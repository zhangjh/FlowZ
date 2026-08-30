/**
 * 代理管理 IPC 处理器
 * 处理代理相关的 IPC 请求
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { UserConfig, ProxyStatus } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { ProxyManager } from '../../services/ProxyManager';
import { ISystemProxyManager } from '../../services/SystemProxyManager';
import type { AutoSelectService } from '../../services/AutoSelectService';
import type { ConfigManager } from '../../services/ConfigManager';
import { ipcEventEmitter } from '../../ipc/ipc-events';

/**
 * 托盘状态更新回调
 */
export type TrayStateUpdateCallback = (isRunning: boolean, hasError?: boolean) => void;

let trayStateCallback: TrayStateUpdateCallback | null = null;

/**
 * 设置托盘状态更新回调
 */
export function setTrayStateCallback(callback: TrayStateUpdateCallback): void {
  trayStateCallback = callback;
}

/**
 * 统一的代理启动逻辑（含自动选择测速）
 * 供自动连接、IPC 调用、托盘菜单等入口复用
 */
export async function executeProxyStart(
  proxyManager: ProxyManager,
  systemProxyManager: ISystemProxyManager | undefined,
  autoSelectService: AutoSelectService | undefined,
  configManager: ConfigManager | undefined,
  config: UserConfig
): Promise<void> {
  let finalConfig = config;

  // 自动选择模式：启动前先测速选最佳服务器
  if (
    autoSelectService &&
    config.autoSelect?.enabled &&
    !config.selectedGroupId &&
    config.servers.length > 0
  ) {
    console.log('[Proxy] Auto-select enabled, testing servers before start...');
    try {
      const results = await autoSelectService.testAllServers(config.servers);
      const available = results.filter((r) => r.latency !== null);
      if (available.length > 0) {
        const best = available.reduce((a, b) => (a.latency! < b.latency! ? a : b));
        if (best.serverId !== config.selectedServerId) {
          console.log(`[Proxy] Auto-select: switching to ${best.serverId} (latency: ${best.latency}ms)`);
          finalConfig = { ...config, selectedServerId: best.serverId };

          if (configManager) {
            await configManager.saveConfig(finalConfig);
          }
          ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_CONFIG_CHANGED, { newValue: finalConfig });
        }
      }
    } catch (error) {
      console.error('[Proxy] Auto-select test failed, using original config:', error);
    }
  }

  // 启动 sing-box 进程
  await proxyManager.start(finalConfig);

  // 系统代理模式：设置系统代理
  const modeType = (finalConfig.proxyModeType || 'systemProxy').toLowerCase();
  if (modeType === 'systemproxy' && systemProxyManager) {
    console.log('[Proxy] Setting system proxy...');
    await systemProxyManager.enableProxy(
      '127.0.0.1',
      finalConfig.httpPort || 65533,
      finalConfig.socksPort || 65534
    );
    console.log('[Proxy] System proxy enabled');
  }

  // 启动自动选择健康检查
  if (autoSelectService) {
    autoSelectService.updateConfig(finalConfig);
  }

  // 更新托盘状态
  if (trayStateCallback) {
    trayStateCallback(true);
  }
}

/**
 * 注册代理管理相关的 IPC 处理器
 */
export function registerProxyHandlers(
  proxyManager: ProxyManager,
  systemProxyManager?: ISystemProxyManager,
  autoSelectService?: AutoSelectService,
  configManager?: ConfigManager
): void {
  // 启动代理
  registerIpcHandler<UserConfig, void>(
    IPC_CHANNELS.PROXY_START,
    async (_event: IpcMainInvokeEvent, config: UserConfig) => {
      console.log('[Proxy Handlers] PROXY_START received config:', JSON.stringify(config, null, 2));

      if (!config) {
        throw new Error('配置参数未传递');
      }

      await executeProxyStart(proxyManager, systemProxyManager, autoSelectService, configManager, config);
    }
  );

  // 停止代理
  registerIpcHandler<void, void>(IPC_CHANNELS.PROXY_STOP, async (_event: IpcMainInvokeEvent) => {
    // 停止自动选择服务
    if (autoSelectService) {
      autoSelectService.stop();
    }

    // 先禁用系统代理（不管当前状态如何，都尝试禁用）
    if (systemProxyManager) {
      try {
        console.log('[Proxy Handlers] Disabling system proxy...');
        await systemProxyManager.disableProxy();
        console.log('[Proxy Handlers] System proxy disabled');
      } catch (error) {
        console.error('[Proxy Handlers] Failed to disable system proxy:', error);
      }
    }

    // 停止 sing-box 进程
    await proxyManager.stop();

    // 更新托盘状态
    if (trayStateCallback) {
      trayStateCallback(false);
    }
  });

  // 获取代理状态
  registerIpcHandler<void, ProxyStatus>(
    IPC_CHANNELS.PROXY_GET_STATUS,
    async (_event: IpcMainInvokeEvent) => {
      return proxyManager.getStatus();
    }
  );

  // 重启代理
  registerIpcHandler<UserConfig, void>(
    IPC_CHANNELS.PROXY_RESTART,
    async (_event: IpcMainInvokeEvent, config: UserConfig) => {
      await proxyManager.restart(config);
    }
  );

  console.log('[Proxy Handlers] Registered all proxy IPC handlers');
}
