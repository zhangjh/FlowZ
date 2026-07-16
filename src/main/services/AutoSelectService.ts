/**
 * 自动选择最佳服务器服务
 * 负责服务器健康检查和故障转移
 */

import { EventEmitter } from 'events';
import type {
  UserConfig,
  ServerConfig,
  ServerSpeedResult,
  AutoSelectStatus,
} from '../../shared/types';
import { SpeedTester } from './SpeedTester';
import { IPC_CHANNELS } from '../../shared/ipc-channels';

export interface IAutoSelectService {
  start(config: UserConfig): void;
  stop(): void;
  updateConfig(config: UserConfig): void;
  testAllServers(servers: ServerConfig[]): Promise<ServerSpeedResult[]>;
  triggerImmediateFailover(): Promise<void>;
  getBestServer(servers: ServerConfig[]): ServerConfig | null;
  getStatus(): AutoSelectStatus;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

export interface IConfigManager {
  loadConfig(): Promise<UserConfig>;
  saveConfig(config: UserConfig): Promise<void>;
}

export interface IProxyManager {
  hotReloadConfig(config: UserConfig): Promise<boolean>;
  restart(config: UserConfig): Promise<void>;
}

export interface ILogManager {
  addLog(level: import('../../shared/types').LogLevel, message: string, source: string): void;
}

export interface IIpcEventEmitter {
  sendToAll(channel: string, data: any): void;
}

export class AutoSelectService extends EventEmitter implements IAutoSelectService {
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private speedTester: SpeedTester;
  private config: UserConfig | null = null;
  private proxyManager: IProxyManager;
  private configManager: IConfigManager;
  private logManager: ILogManager | null = null;
  private ipcEmitter: IIpcEventEmitter | null = null;

  // 状态
  private enabled: boolean = false;
  private currentBestServerId: string | null = null;
  private lastTestResults: ServerSpeedResult[] = [];
  private lastTestTime: string | null = null;
  private failoverCount: number = 0;
  private isTesting: boolean = false;
  private isFailingOver: boolean = false;

  constructor(
    proxyManager: IProxyManager,
    configManager: IConfigManager,
    logManager?: ILogManager,
    ipcEmitter?: IIpcEventEmitter
  ) {
    super();
    this.proxyManager = proxyManager;
    this.configManager = configManager;
    this.logManager = logManager || null;
    this.ipcEmitter = ipcEmitter || null;
    this.speedTester = new SpeedTester();
  }

  /**
   * 启动自动选择服务
   */
  start(config: UserConfig): void {
    this.config = config;
    this.enabled = config.autoSelect?.enabled ?? false;

    if (this.enabled) {
      this.logToManager('info', '自动选择服务已初始化（等待代理启动后开始健康检查）');
    }
  }

  /**
   * 停止自动选择服务
   */
  stop(): void {
    this.stopHealthCheck();
    this.enabled = false;
    this.logToManager('info', '自动选择服务已停止');
  }

  /**
   * 更新配置
   */
  updateConfig(config: UserConfig): void {
    const wasEnabled = this.enabled;
    this.config = config;
    this.enabled = config.autoSelect?.enabled ?? false;

    if (this.enabled && !wasEnabled) {
      this.startHealthCheck();
      this.logToManager('info', '自动选择服务已启用');
    } else if (!this.enabled && wasEnabled) {
      this.stopHealthCheck();
      this.logToManager('info', '自动选择服务已禁用');
    } else if (this.enabled) {
      // 更新检测间隔
      this.restartHealthCheck();
    }
  }

  /**
   * 立即触发故障转移（由渲染进程在检测到请求失败时调用）
   * 先快速检测当前服务器，确认故障后再执行故障转移
   */
  async triggerImmediateFailover(): Promise<void> {
    if (!this.enabled) return;
    if (this.isTesting || this.isFailingOver) return;

    if (!this.config) return;

    const servers = this.config.servers;
    if (servers.length === 0) return;

    const currentServer = servers.find((s) => s.id === this.config?.selectedServerId);
    if (!currentServer) {
      this.logToManager('warn', '立即故障转移：没有选中的服务器');
      await this.performFailover();
      return;
    }

    // 快速检测当前服务器（3秒超时）
    this.logToManager('info', `立即故障转移：检测当前服务器 ${currentServer.name}...`);
    const latency = await this.speedTester.testLatency(currentServer, 3000);

    if (latency !== null) {
      // 当前服务器正常，无需故障转移
      this.logToManager('info', `立即故障转移：当前服务器 ${currentServer.name} 正常 (${latency}ms)，无需切换`);
      return;
    }

    // 确认故障，执行故障转移
    this.logToManager('warn', `立即故障转移：当前服务器 ${currentServer.name} 确认故障，开始转移`);
    await this.performFailover();

    // 重置健康检查定时器（从现在开始重新计时）
    if (this.enabled) {
      this.restartHealthCheck();
    }
  }

  /**
   * 测试所有服务器
   */
  async testAllServers(servers: ServerConfig[]): Promise<ServerSpeedResult[]> {
    if (this.isTesting) {
      this.logToManager('warn', '速度测试正在进行中，请稍后再试');
      return this.lastTestResults;
    }

    this.isTesting = true;
    this.logToManager('info', `开始测试 ${servers.length} 个服务器...`);

    try {
      const proxyPort = this.config?.httpPort || 65533;
      const testResults = await this.speedTester.testMultipleServers(servers, proxyPort);

      // 转换为 ServerSpeedResult[]
      const results: ServerSpeedResult[] = servers.map((server) => {
        const testResult = testResults.get(server.id);
        return {
          serverId: server.id,
          latency: testResult?.latency ?? null,
          downloadSpeed: testResult?.downloadSpeed ?? null,
          lastTestTime: new Date().toISOString(),
          error: testResult?.latency === null ? '无法连接' : undefined,
        };
      });

      this.lastTestResults = results;
      this.lastTestTime = new Date().toISOString();

      // 更新当前最佳服务器
      this.updateBestServer(servers, results);

      // 通知前端测试完成
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_AUTO_SELECT_TEST_COMPLETED, results);

      this.emit('testCompleted', results);
      this.logToManager('info', '服务器测试完成');

      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logToManager('error', `服务器测试失败: ${message}`);
      throw error;
    } finally {
      this.isTesting = false;
    }
  }

  /**
   * 获取最佳服务器
   */
  getBestServer(servers: ServerConfig[]): ServerConfig | null {
    if (servers.length === 0) return null;

    // 如果有测试结果，根据结果选择
    if (this.lastTestResults.length > 0) {
      const mode = this.config?.autoSelect?.mode ?? 'latency';

      // 过滤出可连接的服务器
      const availableResults = this.lastTestResults.filter((r) => r.latency !== null);

      if (availableResults.length === 0) {
        this.logToManager('warn', '没有可连接的服务器');
        return null;
      }

      // 根据模式排序
      const sorted = [...availableResults].sort((a, b) => {
        if (mode === 'latency') {
          return (a.latency ?? Infinity) - (b.latency ?? Infinity);
        } else {
          // speed 模式，优先下载速度
          return (b.downloadSpeed ?? 0) - (a.downloadSpeed ?? 0);
        }
      });

      const bestId = sorted[0].serverId;
      return servers.find((s) => s.id === bestId) ?? null;
    }

    // 没有测试结果，返回第一个服务器
    return servers[0];
  }

  /**
   * 获取当前状态
   */
  getStatus(): AutoSelectStatus {
    return {
      enabled: this.enabled,
      currentBestServerId: this.currentBestServerId,
      lastTestResults: this.lastTestResults,
      lastTestTime: this.lastTestTime,
      failoverCount: this.failoverCount,
    };
  }

  /**
   * 更新最佳服务器
   */
  private updateBestServer(servers: ServerConfig[], _results: ServerSpeedResult[]): void {
    const bestServer = this.getBestServer(servers);
    if (bestServer && bestServer.id !== this.currentBestServerId) {
      const oldBestId = this.currentBestServerId;
      this.currentBestServerId = bestServer.id;

      this.logToManager(
        'info',
        `最佳服务器已更新: ${bestServer.name} (${oldBestId ? '从之前切换' : '首次选择'})`
      );

      this.emit('bestServerChanged', bestServer);
    }
  }

  /**
   * 启动健康检查
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }

    const interval = (this.config?.autoSelect?.interval ?? 60) * 1000;

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, interval);

    // 延迟执行第一次检查
    setTimeout(() => {
      this.performHealthCheck();
    }, 5000);
  }

  /**
   * 停止健康检查
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * 重启健康检查
   */
  private restartHealthCheck(): void {
    this.stopHealthCheck();
    this.startHealthCheck();
  }

  /**
   * 执行健康检查
   */
  private async performHealthCheck(): Promise<void> {
    if (this.isTesting || this.isFailingOver) {
      return;
    }

    if (!this.config) return;

    const servers = this.config.servers;
    if (servers.length === 0) return;

    // 检查当前服务器是否健康
    const currentServer = servers.find((s) => s.id === this.config?.selectedServerId);

    if (!currentServer) {
      this.logToManager('warn', '没有选中的服务器，尝试选择最佳服务器');
      await this.performFailover();
      return;
    }

    const latency = await this.speedTester.testLatency(currentServer, 3000);

    if (latency !== null) {
      // 当前服务器正常
      this.logToManager('debug', `当前服务器 ${currentServer.name} 健康，延迟: ${latency}ms`);
      return;
    }

    // 当前服务器不可用，触发故障转移
    this.logToManager('warn', `当前服务器 ${currentServer.name} 不可用，触发故障转移`);
    await this.performFailover();
  }

  /**
   * 执行故障转移
   */
  private async performFailover(): Promise<void> {
    if (this.isFailingOver) return;
    this.isFailingOver = true;

    try {
      const failoverEnabled = this.config?.autoSelect?.failoverEnabled ?? true;
      if (!failoverEnabled) {
        this.logToManager('info', '故障转移已禁用');
        return;
      }

      const servers = this.config?.servers ?? [];
      if (servers.length === 0) {
        this.logToManager('error', '没有可用的服务器');
        return;
      }

      // 测试所有服务器
      const results = await this.speedTester.testMultipleServers(servers);

      // 找到最快的可用服务器（排除当前不可用的）
      let bestServer: ServerConfig | null = null;
      let bestLatency = Infinity;

      for (const [serverId, result] of results) {
        if (result.latency !== null && result.latency < bestLatency) {
          bestLatency = result.latency;
          bestServer = servers.find((s) => s.id === serverId) ?? null;
        }
      }

      if (!bestServer) {
        this.logToManager('error', '没有可用的备用服务器');
        this.emit('failoverFailed', { reason: '没有可用的备用服务器' });
        return;
      }

      // 如果最佳服务器就是当前服务器，不需要切换
      if (bestServer.id === this.config?.selectedServerId) {
        this.logToManager('info', '当前服务器仍是最佳选择，无需切换');
        return;
      }

      this.logToManager('info', `故障转移到: ${bestServer.name} (延迟: ${bestLatency}ms)`);

      // 更新测试结果
      this.lastTestResults = servers.map((server) => {
        const testResult = results.get(server.id);
        return {
          serverId: server.id,
          latency: testResult?.latency ?? null,
          downloadSpeed: testResult?.downloadSpeed ?? null,
          lastTestTime: new Date().toISOString(),
          error: testResult?.latency === null ? '无法连接' : undefined,
        };
      });
      this.lastTestTime = new Date().toISOString();

      // 更新配置
      if (this.config) {
        const oldServerId = this.config.selectedServerId;
        const newConfig: UserConfig = {
          ...this.config,
          selectedServerId: bestServer.id,
        };

        await this.configManager.saveConfig(newConfig);
        this.config = newConfig;
        this.currentBestServerId = bestServer.id;
        this.failoverCount++;

        // 通知渲染进程配置已变更（更新首页服务器显示）
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_CONFIG_CHANGED, { newValue: newConfig });

        // 通过 ProxyManager 热更新配置
        const hotReloaded = await this.proxyManager.hotReloadConfig(newConfig);
        if (!hotReloaded) {
          // 热更新失败，尝试重启
          this.logToManager('warn', '热更新失败，尝试重启代理');
          await this.proxyManager.restart(newConfig);
        }

        // 通知前端故障转移完成
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_AUTO_SELECT_FAILOVER, {
          from: oldServerId,
          to: bestServer.id,
          server: bestServer,
          latency: bestLatency,
          failoverCount: this.failoverCount,
        });

        this.emit('failover', {
          from: oldServerId,
          to: bestServer.id,
          server: bestServer,
          latency: bestLatency,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logToManager('error', `故障转移失败: ${message}`);
      this.emit('failoverFailed', { reason: message });
    } finally {
      this.isFailingOver = false;
    }
  }

  /**
   * 发送事件到渲染进程
   */
  private sendEventToRenderer(channel: string, data: any): void {
    if (this.ipcEmitter) {
      this.ipcEmitter.sendToAll(channel, data);
    }
  }

  /**
   * 日志输出
   */
  private logToManager(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'AutoSelectService');
    }
    console.log(`[AutoSelectService] [${level}] ${message}`);
  }
}
