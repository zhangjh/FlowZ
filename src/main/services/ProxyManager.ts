/**
 * 代理管理服务
 * 负责 sing-box 进程的生命周期管理和配置生成
 */

import { BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import { isIP } from 'net';
import type { UserConfig, ServerConfig, ProxyStatus } from '../../shared/types';
import type { ILogManager } from './LogManager';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { resourceManager } from './ResourceManager';
import { retry } from '../utils/retry';
import { getUserDataPath } from '../utils/paths';
import { getSystemDnsServers } from '../utils/dns';
import { isRunningAsAdmin } from './AdminPrivilege';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 私有 IP 地址段（CIDR 格式）
 * 用于路由规则中的直连配置
 */
const PRIVATE_IP_CIDRS = [
  // IPv4 私有地址
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  // IPv6 私有地址
  '::1/128',           // loopback
  'fc00::/7',          // unique local address (ULA)
  'fe80::/10',         // link-local
  'ff00::/8',          // multicast
];

/**
 * 私有 IP 地址正则表达式
 * 用于日志过滤中识别内网请求
 */
const PRIVATE_IP_PATTERNS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /\b172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}/,
  /\b192\.168\.\d{1,3}\.\d{1,3}/,
  /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /\b169\.254\.\d{1,3}\.\d{1,3}/,
];

/**
 * sing-box clash_api 热更新端口
 */
const CLASH_API_PORT = 9091;

/**
 * sing-box 1.12.x 配置类型定义
 */

interface SingBoxLogConfig {
  level: string;
  timestamp: boolean;
  output?: string;
}

interface SingBoxDnsServer {
  tag: string;
  type: string;
  server?: string;
  detour?: string;
  // DoH 专用字段
  address?: string;
  address_resolver?: string;
  // FakeIP 专用字段
  inet4_range?: string;
  inet6_range?: string;
}

interface SingBoxDnsRule {
  rule_set?: string;
  query_type?: string[];
  domain?: string[];
  domain_suffix?: string[];
  server: string;
}

interface SingBoxFakeIPConfig {
  enabled: boolean;
  inet4_range?: string;
  inet6_range?: string;
}

interface SingBoxDnsConfig {
  servers: SingBoxDnsServer[];
  rules?: SingBoxDnsRule[];
  final?: string;
  strategy?: string;
  fakeip?: SingBoxFakeIPConfig;
}

interface SingBoxInbound {
  type: string;
  tag: string;
  listen?: string;
  listen_port?: number;
  // TUN 模式
  interface_name?: string;
  address?: string[];
  mtu?: number;
  auto_route?: boolean;
  strict_route?: boolean;
  stack?: string;
  sniff?: boolean;
  sniff_override_destination?: boolean;
  route_exclude_address?: string[];
  platform?: {
    http_proxy?: {
      enabled: boolean;
      server: string;
      server_port: number;
    };
  };
}

interface SingBoxOutbound {
  type: string;
  tag: string;
  server?: string;
  server_port?: number;
  // VLESS
  uuid?: string;
  flow?: string;
  packet_encoding?: string;
  // Trojan and Hysteria2
  password?: string;
  // Hysteria2 specific
  up_mbps?: number;
  down_mbps?: number;
  obfs?: {
    type: string;
    password: string;
  };
  network?: string;
  // TLS
  tls?: {
    enabled: boolean;
    server_name?: string;
    insecure?: boolean;
    alpn?: string[];
    utls?: {
      enabled: boolean;
      fingerprint: string;
    };
    reality?: {
      enabled: boolean;
      public_key: string;
      short_id: string;
    };
  };
  // Transport
  transport?: {
    type: string;
    path?: string;
    headers?: Record<string, string | string[]>;
    service_name?: string;
  };
  // DNS resolver for outbound server domain
  domain_resolver?: string;
}

interface SingBoxRouteRule {
  protocol?: string;
  rule_set?: string;
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  domain_regex?: string[];
  ip_cidr?: string[];
  action: string;
  outbound?: string;
}

interface SingBoxRuleSet {
  tag: string;
  type: string;
  format: string;
  path: string;
}

interface SingBoxRouteConfig {
  rule_set?: SingBoxRuleSet[];
  rules: SingBoxRouteRule[];
  default_domain_resolver?: string;
  auto_detect_interface?: boolean;
  final?: string;
}

interface SingBoxExperimental {
  cache_file?: {
    enabled: boolean;
    path: string;
  };
  clash_api?: {
    external_controller: string;
    secret?: string;
  };
}

interface SingBoxConfig {
  log: SingBoxLogConfig;
  dns?: SingBoxDnsConfig;
  inbounds: SingBoxInbound[];
  outbounds: SingBoxOutbound[];
  route?: SingBoxRouteConfig;
  experimental?: SingBoxExperimental;
}

export interface IProxyManager {
  start(config: UserConfig): Promise<void>;
  stop(): Promise<void>;
  restart(config: UserConfig): Promise<void>;
  getStatus(): ProxyStatus;
  generateSingBoxConfig(config: UserConfig): SingBoxConfig;
  hotReloadConfig(newConfig: UserConfig): Promise<boolean>;
  canHotReload(newConfig: UserConfig): boolean;
  on(event: 'started' | 'stopped' | 'error', listener: (...args: any[]) => void): void;
  off(event: 'started' | 'stopped' | 'error', listener: (...args: any[]) => void): void;
}

export class ProxyManager extends EventEmitter implements IProxyManager {
  private singboxProcess: ChildProcess | null = null;
  private startTime: Date | null = null;
  private pid: number | null = null;
  private singboxPid: number | null = null; // macOS TUN 模式下实际的 sing-box PID
  private currentConfig: UserConfig | null = null;
  private configPath: string;
  private singboxPath: string;
  private logManager: ILogManager | null = null;
  private lastLogMessage: string = '';
  private lastLogCount: number = 0;
  private lastLogTime: number = 0;
  private mainWindow: BrowserWindow | null = null;
  private lastErrorOutput: string = '';
  private logFileWatcher: ReturnType<typeof setInterval> | null = null;
  private lastLogFileSize: number = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly HEALTH_CHECK_INTERVAL = 30000; // 30秒检查一次

  // 自动重启相关
  private autoRestartEnabled: boolean = true;
  private restartCount: number = 0;
  private lastRestartTime: number = 0;
  private static readonly MAX_RESTART_COUNT = 3; // 最大重启次数
  private static readonly RESTART_COOLDOWN = 60000; // 重启冷却时间（1分钟内最多重启3次）
  private isRestarting: boolean = false;
  private isHealthCheckRunning: boolean = false;

  constructor(
    logManager?: ILogManager,
    mainWindow?: BrowserWindow,
    configPath?: string,
    singboxPath?: string
  ) {
    super();
    this.logManager = logManager || null;
    this.mainWindow = mainWindow || null;

    // 配置文件路径
    if (configPath) {
      this.configPath = configPath;
    } else {
      const userDataPath = getUserDataPath();
      this.configPath = path.join(userDataPath, 'singbox_config.json');
    }

    // sing-box 可执行文件路径
    if (singboxPath) {
      this.singboxPath = singboxPath;
    } else {
      this.singboxPath = this.getSingBoxPath();
    }
  }

  /**
   * 启动代理
   */
  async start(config: UserConfig): Promise<void> {
    // 如果已经在运行，先停止
    if (this.singboxProcess || this.singboxPid) {
      await this.stop();
    }

    // 用户手动启动时重置重启计数
    if (!this.isRestarting) {
      this.resetRestartCount();
    }

    // 先保存当前配置（needsRootPrivilege 等方法需要用到）
    this.currentConfig = config;

    // 仅在 TUN 模式下清理可能残留的 sing-box 进程
    // 系统代理模式不需要管理员权限，也不会有残留的 TUN 进程问题
    const isTunMode = config.proxyModeType === 'tun';
    if (isTunMode) {
      await this.killOrphanedSingBoxProcesses();
    }

    // 修复可能被 root 创建的文件权限（从 TUN 模式切换到系统代理模式时）
    await this.fixFilePermissions();

    // 检查是否选择了服务器
    if (!config.selectedServerId) {
      throw new Error('No server selected');
    }

    // 查找选中的服务器
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);
    if (!selectedServer) {
      throw new Error('Selected server not found');
    }

    // 生成 sing-box 配置
    const singboxConfig = this.generateSingBoxConfig(config);

    // 写入配置文件
    await this.writeSingBoxConfig(singboxConfig);

    // TUN 模式下，删除旧的 PID 文件，确保不会读到旧的 PID
    if (this.needsPrivilegedWrapper()) {
      await this.deletePidFile();
    }

    // 使用重试机制启动 sing-box 进程
    await retry(() => this.startSingBoxProcess(), {
      maxRetries: 2,
      delay: 2000,
      exponentialBackoff: true,
      shouldRetry: (error) => {
        // 只对特定错误进行重试
        const message = error.message.toLowerCase();

        // 不重试的错误类型
        const nonRetryableErrors = [
          '找不到',
          '权限',
          'permission',
          'enoent',
          'eacces',
          'eperm',
          '配置文件格式错误',
          'invalid config',
        ];

        // 如果是不可重试的错误，直接失败
        if (nonRetryableErrors.some((pattern) => message.includes(pattern))) {
          return false;
        }

        // 其他错误可以重试
        return true;
      },
      onRetry: (error, attempt) => {
        this.logToManager('warn', `启动失败，正在进行第 ${attempt} 次重试: ${error.message}`);
      },
    });
  }

  /**
   * 停止代理
   */
  async stop(): Promise<void> {
    // macOS TUN 模式：即使 singboxProcess 为 null，也可能有后台进程在运行
    if (!this.singboxProcess && !this.singboxPid) {
      return;
    }

    await this.stopSingBoxProcess();
  }

  /**
   * 重启代理
   * TUN 模式下将停止和启动合并为单次提权操作，避免两次弹框
   */
  async restart(config: UserConfig): Promise<void> {
    const modeTypeChanged = this.currentConfig?.proxyModeType !== config.proxyModeType;

    // 模式类型发生变化（TUN ↔ 系统代理）：使用 stop + start
    // stop 可能需要提权（旧进程是 root），start 根据新模式决定是否提权
    if (modeTypeChanged) {
      await this.stop();
      await this.start(config);
      return;
    }

    // 系统代理模式：直接 stop + start，无需提权
    if (!this.needsPrivilegedWrapper()) {
      await this.stop();
      await this.start(config);
      return;
    }

    // TUN 模式内重启（如切换服务器、改端口、改规则）：合并为单次提权操作
    await this.restartWithElevation(config);
  }

  /**
   * TUN 模式下通过单次提权完成重启
   * 生成一个 wrapper 脚本，在同一个提权上下文中完成：杀旧进程 → 启动新进程
   */
  private async restartWithElevation(config: UserConfig): Promise<void> {
    // 先生成新配置并写入文件（提权脚本直接读取）
    const singboxConfig = this.generateSingBoxConfig(config);
    await this.writeSingBoxConfig(singboxConfig);
    this.currentConfig = config;

    const pidFile = path.join(getUserDataPath(), 'singbox.pid');
    const exitInfoFile = path.join(getUserDataPath(), 'singbox_exit.log');
    const wrapperScriptFile = path.join(getUserDataPath(), 'singbox_wrapper.sh');

    // 通用的 wrapper 脚本逻辑（macOS / Linux）
    const wrapperContent = [
      '#!/bin/bash',
      `SINGBOX_PATH=${shellQuote(this.singboxPath)}`,
      `CONFIG_PATH=${shellQuote(this.configPath)}`,
      `PID_FILE=${shellQuote(pidFile)}`,
      `EXIT_LOG=${shellQuote(exitInfoFile)}`,
      '',
      'echo "[$(date)] restart wrapper started" > "$EXIT_LOG"',
      '',
      '# 停止旧 sing-box 进程',
      'if [ -f "$PID_FILE" ]; then',
      '  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)',
      '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
      '    echo "[$(date)] killing old sing-box PID=$OLD_PID" >> "$EXIT_LOG"',
      '    kill -TERM "$OLD_PID" 2>/dev/null',
      '    for i in $(seq 1 15); do',
      '      if ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi',
      '      sleep 0.2',
      '    done',
      '    if kill -0 "$OLD_PID" 2>/dev/null; then',
      '      echo "[$(date)] old process not responding, force killing" >> "$EXIT_LOG"',
      '      kill -9 "$OLD_PID" 2>/dev/null',
      '      sleep 0.5',
      '    fi',
      '    echo "[$(date)] old sing-box stopped" >> "$EXIT_LOG"',
      '  else',
      '    echo "[$(date)] old process already gone" >> "$EXIT_LOG"',
      '  fi',
      'fi',
      '',
      '# 启动新 sing-box',
      '"$SINGBOX_PATH" run -c "$CONFIG_PATH" &',
      'SBPID=$!',
      'echo $SBPID > "$PID_FILE"',
      'chmod 644 "$PID_FILE" 2>/dev/null || true',
      'echo "[$(date)] new sing-box started PID=$SBPID" >> "$EXIT_LOG"',
      '',
      '# trap 信号：转发给 sing-box',
      'trap \'kill -TERM $SBPID 2>/dev/null\' TERM INT',
      '',
      'wait $SBPID',
      'EXIT_CODE=$?',
      'echo "[$(date)] sing-box exited code=$EXIT_CODE" >> "$EXIT_LOG"',
    ].join('\n');

    const fsSync = require('fs');
    fsSync.writeFileSync(wrapperScriptFile, wrapperContent, { mode: 0o755 });

    // 删除旧 PID 文件，避免读到残留值
    await this.deletePidFile();

    this.logToManager('info', 'TUN 模式重启：正在请求管理员权限...');

    let command: string;
    let args: string[];

    if (this.needsOsascript()) {
      command = '/usr/bin/osascript';
      args = [
        '-e',
        `do shell script "/bin/bash '${wrapperScriptFile}'" with administrator privileges`,
      ];
    } else if (this.needsLinuxPkexec()) {
      command = '/usr/bin/pkexec';
      args = ['/bin/bash', wrapperScriptFile];
    } else {
      // Windows TUN 模式：使用 PowerShell 合并 stop + start
      await this.restartWithUAC(config);
      return;
    }

    // 启动提权进程
    this.singboxProcess = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.pid = this.singboxProcess.pid || null;
    this.startTime = new Date();

    // 监听进程输出
    if (this.singboxProcess.stdout) {
      this.singboxProcess.stdout.on('data', (data: Buffer) => {
        this.handleProcessOutput(data.toString());
      });
    }
    if (this.singboxProcess.stderr) {
      this.singboxProcess.stderr.on('data', (data: Buffer) => {
        this.handleProcessOutput(data.toString());
      });
    }

    // 监听退出事件
    this.singboxProcess.on('exit', (code) => {
      // macOS: exit code 0 = 成功（wrapper 正常退出）
      // 用户取消密码弹框 = exit code 1，但 sing-box 可能已在后台启动
      if (this.needsOsascript() && code === 1) {
        // 检查 PID 文件是否已写入（用户可能已输入密码，sing-box 已启动）
        this.waitForPidFile().then(() => {
          if (!this.singboxPid) {
            this.logToManager('warn', '用户取消了管理员权限授权');
            this.cleanup();
            this.emit('stopped');
            this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
          }
        });
        return;
      }

      if (code !== 0) {
        this.logToManager('warn', `提权进程退出码: ${code}`);
      }
    });

    this.singboxProcess.on('error', (error) => {
      this.logToManager('error', `提权进程启动失败: ${error.message}`);
      this.cleanup();
      this.emit('error', error);
    });

    // 等待 PID 文件写入（新 sing-box 的实际 PID）
    await this.waitForPidFile();

    // 启动日志监控和健康检查
    this.startLogFileWatcher();
    this.startHealthCheck();

    this.logToManager('info', 'TUN 模式重启完成');
    this.emit('started');
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {});
  }

  /**
   * Windows TUN 模式下通过单次 UAC 完成重启
   */
  private async restartWithUAC(_config: UserConfig): Promise<void> {
    const pidFile = path.join(getUserDataPath(), 'singbox.pid');
    const startupLogFile = path.join(getUserDataPath(), 'singbox_startup.log');
    const singboxPathEsc = this.singboxPath.replace(/'/g, "''");
    const configPathEsc = this.configPath.replace(/'/g, "''");
    const pidFileEsc = pidFile.replace(/'/g, "''");
    const logFileEsc = startupLogFile.replace(/'/g, "''");

    // 读取旧 PID
    let oldPid = 0;
    try {
      const pidContent = require('fs').readFileSync(pidFile, 'utf-8').trim();
      oldPid = parseInt(pidContent, 10) || 0;
    } catch { /* ignore */ }

    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      "$logFile = '" + logFileEsc + "'",
      "$pidFile = '" + pidFileEsc + "'",
      "$singboxPath = '" + singboxPathEsc + "'",
      "$configPath = '" + configPathEsc + "'",
      "'Restarting sing-box...' | Out-File -FilePath $logFile -Encoding UTF8",
      // 停止旧进程
      "if (" + oldPid + " -gt 0) {",
      "  try {",
      "    $proc = Get-Process -Id " + oldPid + " -ErrorAction SilentlyContinue",
      "    if ($proc) {",
      "      Stop-Process -Id " + oldPid + " -Force -ErrorAction SilentlyContinue",
      "      Start-Sleep -Seconds 2",
      "      'Stopped old process PID " + oldPid + "' | Out-File -FilePath $logFile -Append -Encoding UTF8",
      "    }",
      "  } catch { }",
      "}",
      // 启动新进程
      "try {",
      "  $process = Start-Process -FilePath $singboxPath -ArgumentList 'run','-c',$configPath -Verb RunAs -PassThru -WindowStyle Hidden",
      "  if ($process -and $process.Id) {",
      "    'New process started PID: ' + $process.Id | Out-File -FilePath $logFile -Append -Encoding UTF8",
      "    $process.Id | Out-File -FilePath $pidFile -Encoding ASCII -NoNewline",
      "    exit 0",
      "  }",
      "} catch {",
      "  'ERROR: ' + $_.Exception.Message | Out-File -FilePath $logFile -Append -Encoding UTF8",
      "  exit 1",
      "}",
    ].join('; ');

    const command = 'powershell.exe';
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript];

    this.singboxProcess = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.pid = this.singboxProcess.pid || null;
    this.startTime = new Date();

    if (this.singboxProcess.stdout) {
      this.singboxProcess.stdout.on('data', (data: Buffer) => {
        this.handleProcessOutput(data.toString());
      });
    }
    if (this.singboxProcess.stderr) {
      this.singboxProcess.stderr.on('data', (data: Buffer) => {
        this.handleProcessOutput(data.toString());
      });
    }

    this.singboxProcess.on('exit', (code) => {
      if (code === 1) {
        this.logToManager('warn', '用户取消了 UAC 授权');
        this.cleanup();
        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
      }
    });

    this.singboxProcess.on('error', (error) => {
      this.logToManager('error', `UAC 重启失败: ${error.message}`);
      this.cleanup();
      this.emit('error', error);
    });

    await this.waitForPidFile();
    this.startLogFileWatcher();
    this.startHealthCheck();

    this.logToManager('info', 'Windows TUN 模式重启完成');
    this.emit('started');
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {});
  }

  /**
   * 切换代理模式
   * 检测模式变化，如果代理正在运行则重启
   */
  async switchMode(newConfig: UserConfig): Promise<void> {
    // 检查是否有模式变化
    const modeChanged = this.hasModeChanged(newConfig);

    if (!modeChanged) {
      // 模式没有变化，只更新配置
      this.currentConfig = newConfig;
      return;
    }

    // 如果代理正在运行，需要重启
    if (this.singboxProcess) {
      this.logToManager('info', '代理模式已更改，正在重启代理...');
      await this.restart(newConfig);
    } else {
      // 代理未运行，只更新配置
      this.currentConfig = newConfig;
    }
  }

  /**
   * 检查模式是否变化
   */
  private hasModeChanged(newConfig: UserConfig): boolean {
    if (!this.currentConfig) {
      return true;
    }

    // 检查代理模式
    if (this.currentConfig.proxyMode !== newConfig.proxyMode) {
      return true;
    }

    // 检查代理模式类型
    if (this.currentConfig.proxyModeType !== newConfig.proxyModeType) {
      return true;
    }

    // 检查选中的服务器
    if (this.currentConfig.selectedServerId !== newConfig.selectedServerId) {
      return true;
    }

    // 检查端口
    if (
      this.currentConfig.socksPort !== newConfig.socksPort ||
      this.currentConfig.httpPort !== newConfig.httpPort
    ) {
      return true;
    }

    // 检查 TUN 配置（如果是 TUN 模式）
    if (newConfig.proxyModeType === 'tun') {
      const oldTun = this.currentConfig.tunConfig;
      const newTun = newConfig.tunConfig;

      if (
        oldTun.mtu !== newTun.mtu ||
        oldTun.stack !== newTun.stack ||
        oldTun.autoRoute !== newTun.autoRoute ||
        oldTun.strictRoute !== newTun.strictRoute
      ) {
        return true;
      }
    }

    // 检查自定义规则
    if (JSON.stringify(this.currentConfig.customRules) !== JSON.stringify(newConfig.customRules)) {
      return true;
    }

    return false;
  }

  /**
   * 判断是否可以通过热更新应用配置变更
   * 仅当代理正在运行时才允许热更新
   * 系统代理模式和 TUN 模式均支持（clash_api 绑定在 127.0.0.1，localhost 连接不受 TUN 影响）
   *
   * 支持热更新的变更：服务器切换、模式切换（global/smart/direct）、自定义规则变更
   * 不支持热更新的变更：proxyModeType（TUN ↔ 系统代理）、端口、TUN 配置
   */
  canHotReload(newConfig: UserConfig): boolean {
    if (!this.currentConfig || !this.singboxProcess) {
      return false;
    }

    // 以下变更影响底层基础设施，需要重启：
    // - proxyModeType（TUN ↔ 系统代理）
    // - socksPort / httpPort（inbound 监听端口）
    // - tunConfig（TUN 接口参数）
    if (
      this.currentConfig.proxyModeType !== newConfig.proxyModeType ||
      this.currentConfig.socksPort !== newConfig.socksPort ||
      this.currentConfig.httpPort !== newConfig.httpPort
    ) {
      return false;
    }

    // TUN 配置变更需要重启
    if (newConfig.proxyModeType === 'tun') {
      const oldTun = this.currentConfig.tunConfig;
      const newTun = newConfig.tunConfig;
      if (
        oldTun.mtu !== newTun.mtu ||
        oldTun.stack !== newTun.stack ||
        oldTun.autoRoute !== newTun.autoRoute ||
        oldTun.strictRoute !== newTun.strictRoute
      ) {
        return false;
      }
    }

    // 其他变更（服务器、模式、规则）均可通过 clash_api 热更新
    return true;
  }

  /**
   * 通过 sing-box clash_api 热更新配置
   * 重新生成 sing-box 配置并通知进程重新加载，无需重启
   */
  async hotReloadConfig(newConfig: UserConfig): Promise<boolean> {
    try {
      // 生成新的 sing-box 配置并写入文件
      const singboxConfig = this.generateSingBoxConfig(newConfig);
      await this.writeSingBoxConfig(singboxConfig);
      this.currentConfig = newConfig;

      // 通过 clash_api 通知 sing-box 重新加载配置
      // sing-box clash_api 使用 PUT /configs?path=<config_path>
      const configUrl = `http://127.0.0.1:${CLASH_API_PORT}/configs`;
      const params = new URLSearchParams({ path: this.configPath });
      const response = await fetch(`${configUrl}?${params.toString()}`, {
        method: 'PUT',
      });

      if (response.ok) {
        this.logToManager('info', '配置热更新成功，无需重启代理');
        return true;
      }

      // 读取响应体获取详细错误信息
      const body = await response.text().catch(() => '');
      this.logToManager('warn', `热更新 API 返回错误: ${response.status} ${body}`);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logToManager('warn', `热更新失败: ${message}，将回退到重启`);
      return false;
    }
  }

  /**
   * 获取代理状态
   */
  getStatus(): ProxyStatus {
    // TUN 模式下只检查 singboxPid（sing-box 的实际 PID）
    // 系统代理模式下检查 pid（直接启动的进程 PID）
    // 注意：TUN 模式下 this.pid 是 osascript/PowerShell 的 PID，不是 sing-box 的
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    const activePid = isTunMode ? this.singboxPid : (this.singboxPid || this.pid);
    
    // 验证进程是否真正存活（同步快速检查，仅用于状态显示）
    const isRunning = activePid !== null && (() => {
      try { process.kill(activePid, 0); return true; }
      catch (e: any) { return e.code !== 'ESRCH'; }
    })();

    if (!isRunning || !activePid) {
      return {
        running: false,
      };
    }

    // 计算运行时间
    let uptime: number | undefined;
    if (this.startTime) {
      uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    }

    return {
      running: true,
      pid: activePid,
      startTime: this.startTime || undefined,
      uptime,
      currentServer: this.currentConfig?.servers.find(
        (s) => s.id === this.currentConfig?.selectedServerId
      ),
    };
  }

  /**
   * 生成 sing-box 配置（sing-box 1.12.x 格式）
   */
  generateSingBoxConfig(config: UserConfig): SingBoxConfig {
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);
    if (!selectedServer) {
      throw new Error('Selected server not found');
    }

    // 调试日志
    console.log('[ProxyManager] Generating config with:', {
      proxyMode: config.proxyMode,
      proxyModeType: config.proxyModeType,
      selectedServerId: config.selectedServerId,
      serverProtocol: selectedServer.protocol,
    });

    // 获取用户数据目录用于缓存文件
    const userDataPath = getUserDataPath();
    const cachePath = path.join(userDataPath, 'cache.db');

    const singboxConfig: SingBoxConfig = {
      log: this.generateLogConfig(config),
      dns: this.generateDnsConfig(config, selectedServer),
      inbounds: this.generateInbounds(config),
      outbounds: this.generateOutbounds(selectedServer),
      route: this.generateRouteConfig(config),
      experimental: {
        cache_file: {
          enabled: true,
          path: cachePath,
        },
        clash_api: {
          external_controller: `127.0.0.1:${CLASH_API_PORT}`,
        },
      },
    };

    // 调试日志
    console.log('[ProxyManager] Generated inbounds count:', singboxConfig.inbounds.length);
    console.log('[ProxyManager] Generated outbounds count:', singboxConfig.outbounds.length);
    console.log('[ProxyManager] Route rule_set count:', singboxConfig.route?.rule_set?.length || 0);

    return singboxConfig;
  }

  /**
   * 生成日志配置
   */
  private generateLogConfig(config: UserConfig): SingBoxLogConfig {
    // 默认使用 debug 级别以显示路由决策（哪些请求走代理/直连）
    // 应用层会过滤掉不重要的日志，只保留有价值的信息
    const logConfig: SingBoxLogConfig = {
      level: config.logLevel || 'debug',
      timestamp: true,
    };

    // 在 TUN 模式下（macOS、Windows 和 Linux），使用权限提升运行时无法捕获 stdout
    // 需要将日志输出到文件，然后通过文件监控读取
    // 注意：这里直接根据 config 参数判断，而不是 this.currentConfig
    const isTunMode = config.proxyModeType?.toLowerCase() !== 'systemproxy';
    const isMacTunMode = process.platform === 'darwin' && isTunMode;
    const isWindowsTunMode = process.platform === 'win32' && isTunMode;
    const isLinuxTunMode = process.platform === 'linux' && isTunMode;

    if (isMacTunMode || isWindowsTunMode || isLinuxTunMode) {
      logConfig.output = this.getLogFilePath();
    }

    return logConfig;
  }

  /**
   * 获取 sing-box 日志文件路径
   */
  private getLogFilePath(): string {
    const userDataPath = getUserDataPath();
    return path.join(userDataPath, 'singbox.log');
  }

  /**
   * 清空 sing-box 日志文件
   * 在 Windows 和 macOS 上都能工作
   */
  async clearSingBoxLogFile(): Promise<void> {
    const logFilePath = this.getLogFilePath();
    try {
      // 清空日志文件（截断为空）
      await fs.writeFile(logFilePath, '', 'utf-8');
      // 重置文件监控位置，否则后续 stats.size > this.lastLogFileSize 恒为 false
      this.lastLogFileSize = 0;
      this.logToManager('info', 'sing-box 日志文件已清空');
    } catch (error: any) {
      // 文件不存在，忽略
      if (error.code !== 'ENOENT') {
        this.logToManager('error', `清空 sing-box 日志文件失败: ${error.message}`);
      }
    }
  }

  /**
   * 生成 DNS 配置（sing-box 1.12.x 格式）
   * 统一使用 FakeIP 模式：DNS 查询直接返回虚假 IP，由 sniff 识别真实域名后路由
   * 这避免了 DNS 污染和超时问题，TUN 和系统代理模式都使用相同的逻辑
   */
  private generateDnsConfig(config: UserConfig, selectedServer: ServerConfig): SingBoxDnsConfig {
    const proxyMode = (config.proxyMode || 'smart').toLowerCase();
    const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();
    const isTunMode = modeType !== 'systemproxy';

    // 在 Linux 上，检测系统上游 DNS 服务器（绕过 systemd-resolved 等本地 stub）
    // 避免 TUN 模式下 DNS 查询因路由拦截而超时
    const systemDnsServers = process.platform === 'linux' ? getSystemDnsServers() : [];
    const useExplicitDns = systemDnsServers.length > 0;

    const dnsServers: SingBoxDnsServer[] = [];

    if (useExplicitDns) {
      // Linux（Ubuntu）上使用检测到的上游 DNS 服务器，直接发送 DNS 查询
      // 配合路由规则中的 DNS IP 直连规则，避免 TUN 拦截
      for (const server of systemDnsServers) {
        dnsServers.push({
          tag: 'dns-local',
          type: 'udp',
          server: server,
        });
        break;
      }
    } else {
      dnsServers.push({
        tag: 'dns-local',
        type: 'local',
      });
    }

    dnsServers.push({
      tag: 'fakeip',
      type: 'fakeip',
      inet4_range: '198.18.0.0/15',
      inet6_range: 'fc00::/18',
    });

    const dnsConfig: SingBoxDnsConfig = {
      servers: dnsServers,
      rules: [],
      final: 'dns-local',
      // 不设置 strategy，允许 IPv4 和 IPv6 DNS 查询都返回 FakeIP
    };

    const dnsRules: SingBoxDnsRule[] = [];

    // 代理服务器域名必须使用本地 DNS 解析（避免死循环）
    // IP 地址不需要 DNS 规则
    if (selectedServer?.address && !isIP(selectedServer.address)) {
      dnsRules.push({
        domain: [selectedServer.address],
        server: 'dns-local',
      } as SingBoxDnsRule);
    }

    // 绕过 FakeIP 的域名：使用本地 DNS 解析真实 IP
    // 用于解决 QUIC 等协议与 FakeIP 的兼容性问题（如 Cloudflare Tunnel）
    const bypassFakeIPDomains = this.collectBypassFakeIPDomains(config.customRules || []);
    if (bypassFakeIPDomains.length > 0) {
      dnsRules.push({
        domain_suffix: bypassFakeIPDomains,
        server: 'dns-local',
      } as SingBoxDnsRule);
    }

    // TUN 模式下所有普通 A/AAAA 查询都走 FakeIP。
    // Ubuntu 的系统 DNS 在 TUN 接管路由后容易对海外域名或 AAAA 查询超时；
    // FakeIP 避免把客户端 DNS 查询交给本地 DNS，再由路由规则决定直连/代理。
    if (isTunMode && proxyMode !== 'direct') {
      dnsRules.push({
        query_type: ['A', 'AAAA'],
        server: 'fakeip',
      } as SingBoxDnsRule);
    }

    // 根据代理模式配置 FakeIP 规则
    if (proxyMode === 'global') {
      // 全局代理：所有 A/AAAA 查询走 FakeIP
      if (!isTunMode) {
        dnsRules.push({
          query_type: ['A', 'AAAA'],
          server: 'fakeip',
        } as SingBoxDnsRule);
      }
    } else if (proxyMode === 'smart' && !isTunMode) {
      // 智能分流：仅非中国域名走 FakeIP
      // 中国域名使用本地 DNS 解析真实 IP，即使代理不可达也能直连访问
      dnsRules.push({
        rule_set: 'geosite-geolocation-!cn',
        server: 'fakeip',
      } as SingBoxDnsRule);
    }
    // 直连模式不使用 FakeIP，全部走本地 DNS

    dnsConfig.rules = dnsRules;

    return dnsConfig;
  }

  /**
   * 收集需要绕过 FakeIP 的域名列表
   * 这些域名将使用本地 DNS 解析真实 IP，而不是返回 FakeIP
   */
  private collectBypassFakeIPDomains(
    customRules: import('../../shared/types').DomainRule[]
  ): string[] {
    const domains: string[] = [];

    for (const rule of customRules) {
      if (!rule.enabled || !rule.bypassFakeIP || rule.domains.length === 0) continue;

      // 统一处理域名格式，移除可能的 *. 前缀
      for (const domain of rule.domains) {
        const normalizedDomain = domain.startsWith('*.') ? domain.slice(2) : domain;
        domains.push(normalizedDomain);
      }
    }

    return domains;
  }

  /**
   * 生成 Inbound 配置（sing-box 1.12.x 格式）
   */
  private generateInbounds(config: UserConfig): SingBoxInbound[] {
    const inbounds: SingBoxInbound[] = [];

    // 使用小写比较，兼容 SystemProxy/systemProxy 和 Tun/tun
    const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();

    console.log('[ProxyManager] generateInbounds - proxyModeType:', config.proxyModeType);
    console.log('[ProxyManager] generateInbounds - modeType (lowercase):', modeType);

    // 无论哪种模式，都添加 HTTP + SOCKS inbound
    // 这样用户在终端配置的代理环境变量在切换模式后仍然可用
    inbounds.push(
      {
        type: 'http',
        tag: 'http-in',
        listen: '127.0.0.1',
        listen_port: config.httpPort || 65533,
        sniff: true,
        sniff_override_destination: true,
      },
      {
        type: 'socks',
        tag: 'socks-in',
        listen: '127.0.0.1',
        listen_port: config.socksPort || 65534,
        sniff: true,
        sniff_override_destination: true,
      }
    );

    // TUN 模式额外添加 TUN inbound
    if (modeType !== 'systemproxy') {
      const tunInbound: SingBoxInbound = {
        type: 'tun',
        tag: 'tun-in',
        address: [
          config.tunConfig?.inet4Address || '172.19.0.1/30',
          config.tunConfig?.inet6Address || 'fdfe:dcba:9876::1/126',
        ],
        mtu: config.tunConfig?.mtu || 1400,
        auto_route: config.tunConfig?.autoRoute ?? true,
        // macOS 上不使用 strict_route，避免网络完全不通
        strict_route: process.platform === 'darwin' ? false : (config.tunConfig?.strictRoute ?? true),
        // 关键修复：Windows 和 macOS 使用 gvisor stack
        // 原因：Windows 的 system stack 在处理流量嗅探时存在竞态条件，导致 TLS 握手超时
        // gvisor 是用户态网络栈，绕过内核 TUN 实现，消除竞态条件
        // macOS 也使用 gvisor 以保持跨平台行为一致
        stack:
          process.platform === 'win32' || process.platform === 'darwin'
            ? 'gvisor'
            : config.tunConfig?.stack || 'system',
        sniff: true,
        // macOS TUN + smart routing needs the sniffed domain as the destination
        // so geosite rules can match foreign sites instead of falling through to direct.
        // Windows keeps this disabled to preserve the FakeIP behavior fixed for
        // SSH/QUIC-style traffic in a6f9cd8.
        sniff_override_destination: process.platform === 'darwin',
        // 在系统路由层面排除本地地址和 DNS 服务器，确保本地代理端口和 DNS 可访问
        route_exclude_address: [
          '127.0.0.0/8', '::1/128',
          ...process.platform === 'linux' ? getSystemDnsServers().map(ip =>
            ip.includes(':') ? `${ip}/128` : `${ip}/32`
          ) : [],
        ],
      };

      // macOS 平台特定配置
      if (process.platform === 'darwin') {
        tunInbound.platform = {
          http_proxy: {
            enabled: true,
            server: '127.0.0.1',
            server_port: config.httpPort || 65533,
          },
        };
      }

      inbounds.push(tunInbound);
    }

    return inbounds;
  }

  /**
   * 生成 Outbound 配置（sing-box 1.12.x 格式）
   * 包含 proxy, direct, block 三个出站
   */
  private generateOutbounds(selectedServer: ServerConfig): SingBoxOutbound[] {
    const outbounds: SingBoxOutbound[] = [];

    // 代理出站
    outbounds.push(this.generateProxyOutbound(selectedServer));

    // 直连出站
    outbounds.push({
      type: 'direct',
      tag: 'direct',
    });

    // 阻断出站
    outbounds.push({
      type: 'block',
      tag: 'block',
    });

    return outbounds;
  }

  /**
   * 生成代理 Outbound 配置（sing-box 1.12.x 格式）
   */
  private generateProxyOutbound(server: ServerConfig): SingBoxOutbound {
    // sing-box 要求协议类型必须是小写
    const protocol = server.protocol.toLowerCase();

    const outbound: SingBoxOutbound = {
      type: protocol,
      tag: 'proxy',
      server: server.address,
      server_port: server.port,
      // 代理服务器域名使用本地 DNS 解析
      domain_resolver: 'dns-local',
    };

    // VLESS 特定配置
    if (protocol === 'vless') {
      outbound.uuid = server.uuid;
      if (server.flow) {
        outbound.flow = server.flow;
      }
      outbound.packet_encoding = 'xudp';
    }

    // Trojan 特定配置
    if (protocol === 'trojan') {
      outbound.password = server.password;
    }

    // Hysteria2 特定配置
    if (protocol === 'hysteria2') {
      outbound.password = server.password;

      // 带宽限制
      if (server.hysteria2Settings?.upMbps) {
        outbound.up_mbps = server.hysteria2Settings.upMbps;
      }
      if (server.hysteria2Settings?.downMbps) {
        outbound.down_mbps = server.hysteria2Settings.downMbps;
      }

      // 混淆配置
      if (server.hysteria2Settings?.obfs?.type && server.hysteria2Settings?.obfs?.password) {
        outbound.obfs = {
          type: server.hysteria2Settings.obfs.type,
          password: server.hysteria2Settings.obfs.password,
        };
      }

      // 网络类型 (tcp/udp)
      if (server.hysteria2Settings?.network) {
        outbound.network = server.hysteria2Settings.network;
      }
    }

    // TLS 配置
    if (server.security === 'tls' || server.tlsSettings) {
      outbound.tls = {
        enabled: true,
        server_name: server.tlsSettings?.serverName || server.address,
        insecure: server.tlsSettings?.allowInsecure || false,
      };

      // uTLS 仅适用于基于 TCP 的协议，Hysteria2 使用 QUIC (UDP) 不支持 uTLS
      if (protocol !== 'hysteria2') {
        outbound.tls.utls = {
          enabled: true,
          fingerprint: server.tlsSettings?.fingerprint || 'chrome',
        };
      }

      if (server.tlsSettings?.alpn) {
        outbound.tls.alpn = server.tlsSettings.alpn;
      }
    }

    // Reality 配置
    if (server.security === 'reality' && server.realitySettings) {
      outbound.tls = {
        enabled: true,
        server_name: server.tlsSettings?.serverName || server.address,
        utls: {
          enabled: true,
          fingerprint: server.tlsSettings?.fingerprint || 'chrome',
        },
        reality: {
          enabled: true,
          public_key: server.realitySettings.publicKey,
          short_id: server.realitySettings.shortId || '',
        },
      };
    }

    // 传输层配置（不适用于 hysteria2）
    if (protocol !== 'hysteria2' && server.network && server.network !== 'tcp') {
      outbound.transport = this.generateTransportConfig(server);
    }

    return outbound;
  }

  /**
   * 生成传输层配置
   */
  private generateTransportConfig(server: ServerConfig): SingBoxOutbound['transport'] {
    if (server.network === 'ws' && server.wsSettings) {
      return {
        type: 'ws',
        path: server.wsSettings.path || '/',
        headers: server.wsSettings.headers,
      };
    }

    if (server.network === 'grpc' && server.grpcSettings) {
      return {
        type: 'grpc',
        service_name: server.grpcSettings.serviceName || '',
      };
    }

    return undefined;
  }

  /**
   * 生成路由配置（sing-box 1.12.x 格式）
   */
  private generateRouteConfig(config: UserConfig): SingBoxRouteConfig {
    const rules: SingBoxRouteRule[] = [];

    // 使用小写比较代理模式
    const proxyMode = (config.proxyMode || 'smart').toLowerCase();

    // 获取当前选中的服务器，用于排除代理服务器域名
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);

    // DNS 劫持规则（必须）
    rules.push({
      protocol: 'dns',
      action: 'hijack-dns',
    });

    // 排除代理服务器域名/IP，确保代理服务器的连接走直连
    // 这必须放在其他规则之前，否则可能被 geosite-cn 匹配导致死循环
    if (selectedServer?.address) {
      if (isIP(selectedServer.address)) {
        const cidr = isIP(selectedServer.address) === 6
          ? `${selectedServer.address}/128`
          : `${selectedServer.address}/32`;
        rules.push({
          ip_cidr: [cidr],
          action: 'route',
          outbound: 'direct',
        });
      } else {
        rules.push({
          domain: [selectedServer.address],
          action: 'route',
          outbound: 'direct',
        });
      }
    }

    // 自定义规则（优先级最高，必须放在智能分流规则之前）
    // 这样用户可以覆盖任何默认的分流行为
    const customRules = this.generateCustomRules(config.customRules || []);
    rules.push(...customRules);

    // 私有 IP 段直连（内网地址不应该走代理）
    rules.push({
      ip_cidr: PRIVATE_IP_CIDRS,
      action: 'route',
      outbound: 'direct',
    });

    // DNS 服务器 IP 直连：确保上游 DNS 查询不经过 TUN
    // 解决 Ubuntu systemd-resolved 在 TUN 模式下 DNS 超时的问题
    const systemDnsServers = process.platform === 'linux' ? getSystemDnsServers() : [];
    for (const dnsIp of systemDnsServers) {
      if (dnsIp.includes(':')) {
        rules.push({
          ip_cidr: [`${dnsIp}/128`],
          action: 'route',
          outbound: 'direct',
        });
      } else {
        rules.push({
          ip_cidr: [`${dnsIp}/32`],
          action: 'route',
          outbound: 'direct',
        });
      }
    }

    // 智能分流规则（默认启用，除非是直连模式）
    if (proxyMode !== 'direct') {
      // 中国域名直连（优先匹配）
      rules.push({
        rule_set: 'geosite-cn',
        action: 'route',
        outbound: 'direct',
      });
      // 中国 IP 直连
      rules.push({
        rule_set: 'geoip-cn',
        action: 'route',
        outbound: 'direct',
      });
      // 国外域名走代理
      rules.push({
        rule_set: 'geosite-geolocation-!cn',
        action: 'route',
        outbound: 'proxy',
      });
    }

    // 始终添加 rule_set 配置（除非是直连模式）
    // 统一使用 dns-local 作为默认解析器
    const routeConfig: SingBoxRouteConfig = {
      rules,
      default_domain_resolver: 'dns-local',
      auto_detect_interface: true,
      final: proxyMode === 'global' ? 'proxy' : 'direct',
    };

    // 添加 rule_set（除非是直连模式）
    if (proxyMode !== 'direct') {
      routeConfig.rule_set = [
        {
          tag: 'geosite-cn',
          type: 'local',
          format: 'binary',
          path: resourceManager.getGeoSiteCNPath(),
        },
        {
          tag: 'geosite-geolocation-!cn',
          type: 'local',
          format: 'binary',
          path: resourceManager.getGeoSiteNonCNPath(),
        },
        {
          tag: 'geoip-cn',
          type: 'local',
          format: 'binary',
          path: resourceManager.getGeoIPPath(),
        },
      ];
    }

    return routeConfig;
  }

  /**
   * 生成自定义路由规则
   * 所有域名统一使用 domain_suffix 匹配，即匹配该域名及其所有子域名
   */
  private generateCustomRules(
    customRules: import('../../shared/types').DomainRule[]
  ): SingBoxRouteRule[] {
    const rules: SingBoxRouteRule[] = [];

    for (const rule of customRules) {
      if (!rule.enabled || rule.domains.length === 0) continue;

      // 统一使用 domain_suffix，匹配域名及其所有子域名
      // 如 google.com 会匹配 google.com、www.google.com、mail.google.com 等
      const domains = rule.domains.map((d) => (d.startsWith('*.') ? d.slice(2) : d));

      const singboxRule: SingBoxRouteRule = {
        action: 'route',
        domain_suffix: domains,
      };

      // 设置出站
      if (rule.action === 'proxy') {
        singboxRule.outbound = 'proxy';
      } else if (rule.action === 'direct') {
        singboxRule.outbound = 'direct';
      } else if (rule.action === 'block') {
        singboxRule.outbound = 'block';
      }

      rules.push(singboxRule);
    }

    return rules;
  }

  /**
   * 写入 sing-box 配置文件
   */
  private async writeSingBoxConfig(config: SingBoxConfig): Promise<void> {
    const content = JSON.stringify(config, null, 2);
    await fs.writeFile(this.configPath, content, 'utf-8');
  }

  /**
   * 检查当前配置是否需要 root/admin 权限（TUN 模式）
   * Windows 和 macOS 的 TUN 模式都需要管理员权限
   */
  private needsRootPrivilege(): boolean {
    // 只有 TUN 模式才需要管理员权限
    // proxyModeType 的值为 'systemProxy' 或 'tun'
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    // Windows、macOS 和 Linux 的 TUN 模式都需要管理员/root 权限
    return (
      isTunMode &&
      (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux')
    );
  }

  /**
   * 检查是否需要使用 osascript 运行（仅 macOS）
   */
  private needsOsascript(): boolean {
    return process.platform === 'darwin' && this.needsRootPrivilege();
  }

  /**
   * 检查是否需要使用 UAC 提升权限运行（仅 Windows TUN 模式）
   */
  private needsWindowsUAC(): boolean {
    return process.platform === 'win32' && this.needsRootPrivilege();
  }

  /**
   * 检查是否需要使用 pkexec 提升权限运行（Linux TUN 模式）
   */
  private needsLinuxPkexec(): boolean {
    return process.platform === 'linux' && this.needsRootPrivilege();
  }

  /**
   * 检查 sing-box 是否会通过后台提权 wrapper 启动
   */
  private needsPrivilegedWrapper(): boolean {
    return this.needsOsascript() || this.needsWindowsUAC() || this.needsLinuxPkexec();
  }

  /**
   * 修复可能被 root 创建的文件权限（macOS）
   * 当从 TUN 模式切换到系统代理模式时，某些文件可能仍然属于 root
   * 需要在普通用户模式下修复这些文件的权限
   */
  private async fixFilePermissions(): Promise<void> {
    // 只在 macOS 上需要处理
    if (process.platform !== 'darwin') {
      return;
    }

    // 如果是 TUN 模式，不需要修复（会以 root 权限运行）
    if (this.needsRootPrivilege()) {
      return;
    }

    const userDataPath = getUserDataPath();
    const filesToFix = [
      path.join(userDataPath, 'cache.db'),
      path.join(userDataPath, 'singbox.log'),
      path.join(userDataPath, 'singbox.pid'),
    ];

    const fsSync = require('fs');
    const { execSync } = require('child_process');

    for (const filePath of filesToFix) {
      try {
        if (fsSync.existsSync(filePath)) {
          const stats = fsSync.statSync(filePath);
          // 检查文件是否属于 root (uid 0)
          if (stats.uid === 0) {
            this.logToManager('info', `修复文件权限: ${filePath}`);
            // 使用 chown 修改文件所有权为当前用户
            const currentUser = process.env.USER || process.env.LOGNAME;
            if (currentUser) {
              try {
                // 尝试使用 chown（可能需要密码）
                execSync(`chown ${currentUser} "${filePath}"`, { stdio: 'ignore' });
              } catch {
                // 如果 chown 失败，尝试删除文件让 sing-box 重新创建
                try {
                  fsSync.unlinkSync(filePath);
                  this.logToManager('info', `已删除需要重新创建的文件: ${filePath}`);
                } catch {
                  this.logToManager('warn', `无法修复文件权限: ${filePath}，请手动删除或运行: sudo chown ${currentUser} "${filePath}"`);
                }
              }
            }
          }
        }
      } catch (error) {
        // 忽略检查错误
      }
    }
  }

  /**
   * 启动 sing-box 进程
   */
  private async startSingBoxProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // 检查 sing-box 可执行文件是否存在
        const fs = require('fs');
        if (!fs.existsSync(this.singboxPath)) {
          const error = new Error(`找不到 sing-box 可执行文件: ${this.singboxPath}`);
          this.logToManager('error', error.message);
          reject(error);
          return;
        }

        // 根据平台和模式选择启动方式：
        // - macOS TUN 模式: 使用 osascript 请求管理员权限
        // - Windows TUN 模式: 使用 PowerShell Start-Process -Verb RunAs 请求 UAC 权限
        // - Linux TUN 模式: 使用 pkexec 请求管理员权限
        // - 其他情况: 直接运行
        let command: string;
        let args: string[];

        if (this.needsOsascript()) {
          // macOS: 使用 osascript 请求管理员权限运行
          // 将 wrapper 脚本写入临时文件，避免多层引号转义问题
          // wrapper 脚本功能：
          //   1. 启动 sing-box 并记录 PID
          //   2. 持续运行，wait 等待 sing-box 退出
          //   3. 捕获退出码和信号，写入诊断文件
          const pidFile = path.join(getUserDataPath(), 'singbox.pid');
          const exitInfoFile = path.join(getUserDataPath(), 'singbox_exit.log');
          const wrapperScriptFile = path.join(getUserDataPath(), 'singbox_wrapper.sh');

          // 生成 wrapper 脚本内容
          const wrapperContent = [
            '#!/bin/bash',
            `SINGBOX_PATH="${this.singboxPath}"`,
            `CONFIG_PATH="${this.configPath}"`,
            `PID_FILE="${pidFile}"`,
            `EXIT_LOG="${exitInfoFile}"`,
            '',
            '# 记录启动时间',
            'echo "[$(date)] wrapper started" > "$EXIT_LOG"',
            '',
            '# trap 信号：记录并转发给 sing-box',
            'trap \'echo "[$(date)] wrapper received SIGHUP" >> "$EXIT_LOG"\' HUP',
            'trap \'echo "[$(date)] wrapper received SIGTERM" >> "$EXIT_LOG"; kill -TERM $SBPID 2>/dev/null\' TERM',
            'trap \'echo "[$(date)] wrapper received SIGINT" >> "$EXIT_LOG"; kill -INT $SBPID 2>/dev/null\' INT',
            '',
            '# 启动 sing-box',
            '"$SINGBOX_PATH" run -c "$CONFIG_PATH" &',
            'SBPID=$!',
            'echo $SBPID > "$PID_FILE"',
            'echo "[$(date)] sing-box started PID=$SBPID" >> "$EXIT_LOG"',
            '',
            '# wait 等待 sing-box 退出',
            'wait $SBPID',
            'EXIT_CODE=$?',
            'echo "[$(date)] sing-box exited code=$EXIT_CODE (128+N means signal N)" >> "$EXIT_LOG"',
            '',
            '# 如果退出码 > 128，计算信号编号',
            'if [ $EXIT_CODE -gt 128 ]; then',
            '  SIG=$((EXIT_CODE - 128))',
            '  echo "[$(date)] killed by signal $SIG" >> "$EXIT_LOG"',
            'fi',
          ].join('\n');

          // 写入 wrapper 脚本文件
          const fsSync = require('fs');
          fsSync.writeFileSync(wrapperScriptFile, wrapperContent, { mode: 0o755 });

          command = '/usr/bin/osascript';
          // do shell script 用 /bin/sh 执行，需要显式调用 /bin/bash
          // 路径含空格，用单引号包裹避免 sh 解析问题
          args = [
            '-e',
            `do shell script "/bin/bash '${wrapperScriptFile}'" with administrator privileges`,
          ];
          this.logToManager('info', 'TUN 模式需要管理员权限，正在请求...');
        } else if (this.needsWindowsUAC()) {
          // Windows TUN 模式: 使用 PowerShell 请求 UAC 权限运行
          // 使用 Start-Process -Verb RunAs 来请求管理员权限
          const pidFile = path.join(getUserDataPath(), 'singbox.pid');
          command = 'powershell.exe';

          // PowerShell 脚本：以管理员权限启动 sing-box 并记录 PID
          // 使用数组构建脚本避免模板字符串中 $ 被 JS 解析
          // 详细日志输出到 singbox_startup.log 帮助诊断启动问题
          const startupLogFile = path.join(getUserDataPath(), 'singbox_startup.log');
          const singboxPathEsc = this.singboxPath.replace(/'/g, "''");
          const configPathEsc = this.configPath.replace(/'/g, "''");
          const pidFileEsc = pidFile.replace(/'/g, "''");
          const logFileEsc = startupLogFile.replace(/'/g, "''");

          const psScript = [
            "$ErrorActionPreference = 'Stop'",
            "$logFile = '" + logFileEsc + "'",
            "$pidFile = '" + pidFileEsc + "'",
            "$singboxPath = '" + singboxPathEsc + "'",
            "$configPath = '" + configPathEsc + "'",
            "try {",
            "  'Starting sing-box...' | Out-File -FilePath $logFile -Encoding UTF8",
            "  'SingboxPath: ' + $singboxPath | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  'ConfigPath: ' + $configPath | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  if (-not (Test-Path $singboxPath)) { 'ERROR: sing-box not found' | Out-File -FilePath $logFile -Append -Encoding UTF8; exit 1 }",
            "  if (-not (Test-Path $configPath)) { 'ERROR: config not found' | Out-File -FilePath $logFile -Append -Encoding UTF8; exit 1 }",
            "  'Starting with UAC...' | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  $process = Start-Process -FilePath $singboxPath -ArgumentList 'run','-c',$configPath -Verb RunAs -PassThru -WindowStyle Hidden",
            "  if ($process -and $process.Id) {",
            "    'Process started PID: ' + $process.Id | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "    $process.Id | Out-File -FilePath $pidFile -Encoding ASCII -NoNewline",
            "    exit 0",
            "  } else {",
            "    'ERROR: Start-Process returned null' | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "    exit 1",
            "  }",
            "} catch {",
            "  'ERROR: ' + $_.Exception.Message | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  exit 1",
            "}"
          ].join("; ");

          args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript];
          this.logToManager('info', 'TUN 模式需要管理员权限，正在请求 UAC 授权...');
        } else if (this.needsLinuxPkexec()) {
          const pidFile = path.join(getUserDataPath(), 'singbox.pid');
          const exitInfoFile = path.join(getUserDataPath(), 'singbox_exit.log');
          const wrapperScriptFile = path.join(getUserDataPath(), 'singbox_wrapper.sh');

          const wrapperContent = [
            '#!/bin/bash',
            `SINGBOX_PATH=${shellQuote(this.singboxPath)}`,
            `CONFIG_PATH=${shellQuote(this.configPath)}`,
            `PID_FILE=${shellQuote(pidFile)}`,
            `EXIT_LOG=${shellQuote(exitInfoFile)}`,
            '',
            'echo "[$(date)] linux wrapper started" > "$EXIT_LOG"',
            'trap \'echo "[$(date)] wrapper received SIGTERM" >> "$EXIT_LOG"; kill -TERM $SBPID 2>/dev/null\' TERM',
            'trap \'echo "[$(date)] wrapper received SIGINT" >> "$EXIT_LOG"; kill -INT $SBPID 2>/dev/null\' INT',
            '',
            '"$SINGBOX_PATH" run -c "$CONFIG_PATH" &',
            'SBPID=$!',
            'echo $SBPID > "$PID_FILE"',
            'chmod 644 "$PID_FILE" "$EXIT_LOG" 2>/dev/null || true',
            'echo "[$(date)] sing-box started PID=$SBPID" >> "$EXIT_LOG"',
            '',
            'wait $SBPID',
            'EXIT_CODE=$?',
            'echo "[$(date)] sing-box exited code=$EXIT_CODE (128+N means signal N)" >> "$EXIT_LOG"',
            'exit $EXIT_CODE',
          ].join('\n');

          const fsSync = require('fs');
          fsSync.writeFileSync(wrapperScriptFile, wrapperContent, { mode: 0o755 });

          command = '/usr/bin/pkexec';
          args = ['/bin/bash', wrapperScriptFile];
          this.logToManager('info', 'TUN 模式需要管理员权限，正在请求 Linux 授权...');
        } else {
          // 系统代理模式：直接运行
          command = this.singboxPath;
          args = ['run', '-c', this.configPath];
        }

        // 启动进程
        this.singboxProcess = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // 记录启动信息
        this.pid = this.singboxProcess.pid || null;
        this.startTime = new Date();

        // macOS/Windows/Linux TUN 模式下，这个 PID 是提权进程的 PID，不是 sing-box 的
        // 实际的 sing-box PID 会在 waitForPidFile 中从 PID 文件读取
        if (this.needsPrivilegedWrapper()) {
          this.logToManager('info', `正在启动 sing-box（权限提升进程 PID: ${this.pid}）...`);
        } else {
          this.logToManager('info', `正在启动 sing-box 进程 (PID: ${this.pid})...`);
        }

        // 监听进程输出
        if (this.singboxProcess.stdout) {
          this.singboxProcess.stdout.on('data', (data: Buffer) => {
            this.handleProcessOutput(data.toString());
          });
          this.singboxProcess.stdout.on('error', (error) => {
            console.error('sing-box stdout error:', error);
          });
        }

        if (this.singboxProcess.stderr) {
          this.singboxProcess.stderr.on('data', (data: Buffer) => {
            const output = data.toString();
            this.lastErrorOutput = output;
            this.handleProcessOutput(output);
          });
          this.singboxProcess.stderr.on('error', (error) => {
            console.error('sing-box stderr error:', error);
          });
        }

        // 监听进程事件
        this.singboxProcess.on('error', (error) => {
          console.error('sing-box process error:', error);
          const friendlyError = this.parseLaunchError(error);
          this.logToManager('error', friendlyError);
          this.handleProcessError(error);
          reject(new Error(friendlyError));
        });

        this.singboxProcess.on('exit', (code, signal) => {
          console.log(`sing-box process exited with code ${code}, signal ${signal}`);

          // 对于 macOS TUN 模式，osascript 退出码为 0 表示脚本执行成功
          if (this.needsOsascript()) {
            if (code === 0) {
              // wrapper 脚本正常退出，可能是：
              // 1. 启动阶段：sing-box 刚启动，PID 文件已写入（由 setTimeout 中的 waitForPidFile 处理）
              // 2. 运行阶段：sing-box 退出导致 wait 返回，wrapper 脚本结束
              // 两种情况都不需要在这里处理，健康检查会监控 sing-box 进程状态
              if (this.singboxPid) {
                // 已经在运行阶段，wrapper 退出说明 sing-box 退出了
                this.logToManager('info', 'wrapper 脚本退出，sing-box 进程可能已结束，等待健康检查确认');
              }
              return;
            } else {
              // osascript 执行失败（用户取消或其他错误）
              const errorMessage =
                code === 1 ? '用户取消了管理员权限请求' : `启动失败，退出码: ${code}`;
              this.logToManager('error', errorMessage);
              reject(new Error(errorMessage));
              this.handleProcessExit(code, signal);
              return;
            }
          }

          // 对于 Windows TUN 模式，PowerShell 退出码为 0 表示成功启动了 sing-box
          if (this.needsWindowsUAC()) {
            if (code === 0) {
              // PowerShell 成功执行，sing-box 以管理员权限在后台运行
              // PID 文件读取由 setTimeout 中的 waitForPidFile 统一处理
              return; // 不调用 handleProcessExit，因为 sing-box 还在运行
            } else {
              // PowerShell 执行失败（用户取消 UAC 或其他错误）
              const errorMessage =
                code === 1 ? '用户取消了管理员权限请求' : `UAC 授权失败，退出码: ${code}`;
              this.logToManager('error', errorMessage);
              reject(new Error(errorMessage));
              this.handleProcessExit(code, signal);
              return;
            }
          }

          if (this.needsLinuxPkexec()) {
            if (code === 0) {
              if (this.singboxPid) {
                this.logToManager('info', 'Linux wrapper 退出，sing-box 进程可能已结束，等待健康检查确认');
              }
              return;
            } else {
              const errorMessage =
                code === 126 || code === 127
                  ? '未找到 pkexec 或无法执行授权命令，请安装 policykit-1'
                  : code === 1
                    ? '用户取消了管理员权限请求或 Linux 授权失败'
                    : `Linux 授权启动失败，退出码: ${code}`;
              this.logToManager('error', errorMessage);
              reject(new Error(errorMessage));
              this.handleProcessExit(code, signal);
              return;
            }
          }

          // 如果在启动阶段就退出了，说明启动失败
          const startupTime = Date.now() - (this.startTime?.getTime() || Date.now());
          if (startupTime < 2000 && code !== null && code !== 0) {
            const errorMessage = this.parseStartupError(code, this.lastErrorOutput);
            this.logToManager('error', errorMessage);
            reject(new Error(errorMessage));
          }

          this.handleProcessExit(code, signal);
        });

        // 等待一小段时间确保进程启动成功
        setTimeout(async () => {
          const privileged = this.needsPrivilegedWrapper();

          if (privileged) {
            // TUN 模式：等待提权 wrapper 写入 PID 文件
            await this.waitForPidFile();
          }

          const activePid = privileged ? this.singboxPid : this.pid;

          if (activePid) {
            this.startLogFileWatcher();
            this.startHealthCheck();

            this.emit('started');
            this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
              pid: activePid,
              startTime: this.startTime,
            });
            this.logToManager('info', 'sing-box 进程启动成功');
            resolve();
          } else {
            const error = '启动 sing-box 进程失败：进程未能正常启动';
            this.logToManager('error', error);
            this.cleanup();
            reject(new Error(error));
          }
        }, 1000);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logToManager('error', `启动 sing-box 进程时发生异常: ${errorMessage}`);
        // 异常时也要清理状态
        this.cleanup();
        reject(error);
      }
    });
  }

  /**
   * 解析进程启动错误
   */
  private parseLaunchError(error: Error): string {
    const errorCode = (error as NodeJS.ErrnoException).code;

    switch (errorCode) {
      case 'ENOENT':
        return '找不到 sing-box 可执行文件，请检查安装是否完整';
      case 'EACCES':
        return 'sing-box 可执行文件没有执行权限，请检查文件权限';
      case 'EPERM':
        return '权限不足，无法启动 sing-box 进程。TUN 模式需要管理员权限';
      default:
        return `启动 sing-box 进程失败: ${error.message}`;
    }
  }

  /**
   * 解析启动阶段的错误
   */
  private parseStartupError(exitCode: number, errorOutput: string): string {
    // 首先尝试从错误输出中提取有用信息
    if (errorOutput) {
      const lowerOutput = errorOutput.toLowerCase();

      if (
        lowerOutput.includes('permission denied') ||
        lowerOutput.includes('access denied') ||
        lowerOutput.includes('operation not permitted') ||
        lowerOutput.includes('netlink') ||
        lowerOutput.includes('tun')
      ) {
        return `TUN 模式需要管理员权限，请以管理员身份运行应用 [${errorOutput}]`;
      }

      if (lowerOutput.includes('address already in use') || lowerOutput.includes('bind')) {
        return `端口已被占用，请在设置中更换其他端口或关闭占用端口的程序 [${errorOutput}]`;
      }

      if (
        lowerOutput.includes('invalid config') ||
        lowerOutput.includes('parse') ||
        lowerOutput.includes('json')
      ) {
        return `sing-box 配置文件格式错误，请检查服务器配置 [${errorOutput}]`;
      }

      if (lowerOutput.includes('connection refused') || lowerOutput.includes('dial')) {
        return `无法连接到代理服务器，请检查服务器地址和端口 [${errorOutput}]`;
      }

      if (lowerOutput.includes('certificate') || lowerOutput.includes('tls')) {
        return `TLS 证书验证失败，请检查服务器 TLS 配置 [${errorOutput}]`;
      }

      // 如果有具体的错误信息，翻译后返回
      const friendlyMessage = this.translateErrorMessage(errorOutput);
      if (friendlyMessage !== errorOutput) {
        return `sing-box 启动失败: ${friendlyMessage}`;
      }
    }

    // 根据退出码返回通用错误信息
    switch (exitCode) {
      case 1:
        return 'sing-box 启动失败，请检查配置文件和服务器设置';
      case 2:
        return 'sing-box 配置文件格式错误，请检查服务器配置';
      case 126:
        return 'sing-box 可执行文件没有执行权限';
      case 127:
        return '找不到 sing-box 可执行文件';
      default:
        return `sing-box 启动失败，退出码: ${exitCode}`;
    }
  }

  /**
   * 停止 sing-box 进程
   */
  private async stopSingBoxProcess(): Promise<void> {
    // macOS TUN 模式：sing-box 以 root 权限在后台运行，需要用 osascript 终止
    if (this.singboxPid && process.platform === 'darwin') {
      return this.stopSingBoxWithSudo();
    }

    // Windows TUN 模式：sing-box 以管理员权限在后台运行，使用 taskkill 终止
    if (this.singboxPid && process.platform === 'win32') {
      return this.stopSingBoxOnWindows();
    }

    // Linux TUN 模式：sing-box 以 root 权限在后台运行，需要用 pkexec 终止
    if (this.singboxPid && process.platform === 'linux') {
      return this.stopSingBoxOnLinux();
    }

    if (!this.singboxProcess) {
      return;
    }

    return new Promise((resolve) => {
      const proc = this.singboxProcess!;

      // 设置超时强制终止
      const killTimeout = setTimeout(() => {
        if (proc.killed === false) {
          console.warn('sing-box process did not exit gracefully, force killing');
          proc.kill('SIGKILL');
        }
      }, 5000);

      // 监听退出事件
      proc.once('exit', () => {
        clearTimeout(killTimeout);
        this.cleanup();
        resolve();
      });

      // 发送 SIGTERM 信号优雅终止
      proc.kill('SIGTERM');
    });
  }

  /**
   * 使用 sudo 停止 sing-box 进程（macOS TUN 模式）
   */
  private async stopSingBoxWithSudo(): Promise<void> {
    if (!this.singboxPid) {
      this.cleanup();
      return;
    }

    const pidToKill = this.singboxPid;

    // 进程已不存在，直接清理
    if (!(await this.isProcessAlive(pidToKill))) {
      this.logToManager('info', `sing-box 进程 (PID: ${pidToKill}) 已不存在，跳过终止`);
      try { require('fs').unlinkSync(this.getPidFilePath()); } catch { /* ignore */ }
      this.cleanup();
      this.emit('stopped');
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
      return;
    }

    this.logToManager('info', `正在停止 sing-box 进程 (PID: ${pidToKill})...`);

    return new Promise((resolve) => {
      // 先尝试 SIGTERM 优雅终止
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -TERM ${pidToKill}" with administrator privileges`,
      ]);

      killProcess.on('exit', async (code) => {
        if (code === 0) {
          // 等待进程退出
          await this.waitForProcessExit(pidToKill, 3000);

          // 检查进程是否真的退出了
          if (await this.isProcessAlive(pidToKill)) {
            this.logToManager('warn', '进程未响应 SIGTERM，尝试强制终止...');
            await this.forceKillProcess(pidToKill);
          } else {
            this.logToManager('info', 'sing-box 进程已停止');
          }
        } else {
          this.logToManager('warn', `停止 sing-box 进程可能失败，退出码: ${code}`);
          // 尝试强制终止
          await this.forceKillProcess(pidToKill);
        }

        // 清理 PID 文件
        const fsSync = require('fs');
        try {
          fsSync.unlinkSync(this.getPidFilePath());
        } catch {
          // 忽略错误
        }

        this.cleanup();

        // 触发停止事件
        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});

        resolve();
      });

      killProcess.on('error', async (error) => {
        this.logToManager('error', `停止 sing-box 进程失败: ${error.message}`);
        // 尝试强制终止
        await this.forceKillProcess(pidToKill);
        this.cleanup();
        resolve();
      });
    });
  }

  /**
   * 停止 sing-box 进程（Windows TUN 模式）
   * sing-box 以管理员权限（UAC）启动，停止时也需要管理员权限
   * 使用 PowerShell Start-Process -Verb RunAs 来请求 UAC 权限执行 taskkill
   */
  private async stopSingBoxOnWindows(): Promise<void> {
    if (!this.singboxPid) {
      this.cleanup();
      return;
    }

    this.logToManager('info', '正在停止所有 sing-box 进程...');

    // 按进程名杀掉所有 sing-box.exe 实例（包括残留的）
    // taskkill /IM 比按 PID 更可靠：不依赖 PID 文件，能清理残留进程
    const killed = await this.killAllSingBoxOnWindows();

    if (!killed) {
      this.logToManager('error', '无法终止 sing-box 进程，可能仍在运行');
      throw new Error('无法终止 sing-box 进程');
    }

    this.logToManager('info', 'sing-box 进程已停止');

    // 清理 PID 文件
    const fsSync = require('fs');
    try {
      fsSync.unlinkSync(this.getPidFilePath());
    } catch {
      // 忽略错误
    }

    this.cleanup();

    // 触发停止事件
    this.emit('stopped');
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
  }

  /**
   * 停止 sing-box 进程（Linux TUN 模式）
   * sing-box 通过 pkexec 以 root 权限启动，停止时也需要 pkexec 授权
   */
  private async stopSingBoxOnLinux(): Promise<void> {
    if (!this.singboxPid) {
      this.cleanup();
      return;
    }

    const pidToKill = this.singboxPid;

    if (!(await this.isProcessAlive(pidToKill))) {
      this.logToManager('info', `sing-box 进程 (PID: ${pidToKill}) 已不存在，跳过终止`);
      try { require('fs').unlinkSync(this.getPidFilePath()); } catch { /* ignore */ }
      this.cleanup();
      this.emit('stopped');
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
      return;
    }

    this.logToManager('info', `正在停止 Linux sing-box 进程 (PID: ${pidToKill})...`);

    const terminated = await this.tryKill(pidToKill, 'SIGTERM');
    if (terminated) {
      await this.waitForProcessExit(pidToKill, 3000);
    }

    if (await this.isProcessAlive(pidToKill)) {
      this.logToManager('warn', '进程未响应 SIGTERM，尝试强制终止...');
      await this.tryKill(pidToKill, 'SIGKILL');
      await this.waitForProcessExit(pidToKill, 3000);
    }

    if (await this.isProcessAlive(pidToKill)) {
      this.logToManager('error', '无法终止 Linux sing-box 进程，可能仍在运行');
      throw new Error('无法终止 sing-box 进程');
    }

    try { require('fs').unlinkSync(this.getPidFilePath()); } catch { /* ignore */ }

    this.cleanup();
    this.emit('stopped');
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
    this.logToManager('info', 'Linux sing-box 进程已停止');
  }

  private async tryKill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
    try {
      process.kill(pid, signal === 'SIGTERM' ? 15 : 9);
      return true;
    } catch (e: any) {
      if (e.code === 'ESRCH') {
        this.logToManager('debug', `进程 ${pid} 已不存在`);
        return true;
      }

      if (e.code === 'EPERM') {
        const sigName = signal === 'SIGTERM' ? 'TERM' : 'KILL';

        // 策略1：pkexec kill（polkit 弹窗认证）
        this.logToManager('debug', `进程 ${pid} 需要提权终止，尝试 pkexec`);
        const pkexecResult = await this.runPrivilegedKill('/usr/bin/pkexec', pid, sigName);
        if (pkexecResult) {
          return true;
        }

        // 策略2：sudo kill（终端输入密码）
        this.logToManager('warn', `pkexec 终止失败，尝试 sudo kill`);
        const sudoResult = await this.runPrivilegedKill('/usr/bin/sudo', pid, sigName);
        if (sudoResult) {
          return true;
        }

        return false;
      }

      this.logToManager('error', `终止进程 ${pid} 失败: ${e.message}`);
      return false;
    }
  }

  private runPrivilegedKill(command: string, pid: number, signal: 'TERM' | 'KILL'): Promise<boolean> {
    return new Promise((resolve) => {
      const killProcess = spawn(command, ['/bin/kill', `-${signal}`, String(pid)]);

      const timeout = setTimeout(() => {
        try { killProcess.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 30000);

      killProcess.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });

      killProcess.on('error', (error) => {
        clearTimeout(timeout);
        this.logToManager('error', `执行 ${command} kill 失败: ${error.message}`);
        resolve(false);
      });
    });
  }

  /**
   * 终止所有 sing-box.exe 进程
   * 使用 PowerShell cmdlet（Get-Process / Stop-Process），避免 tasklist/taskkill/wmic
   * 在某些系统上的"关键错误"问题
   */
  private async killAllSingBoxOnWindows(): Promise<boolean> {
    const { execSync } = require('child_process');

    // 检查是否还有 sing-box 进程
    const hasSingBox = (): boolean => {
      try {
        const result = execSync(
          'powershell -NoProfile -Command "@(Get-Process sing-box -ErrorAction SilentlyContinue).Count"',
          {
            encoding: 'utf-8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
          }
        );
        const count = parseInt(result.trim(), 10);
        return !isNaN(count) && count > 0;
      } catch {
        return false;
      }
    };

    if (!hasSingBox()) {
      this.logToManager('debug', '没有 sing-box 进程在运行');
      return true;
    }

    // 当前是 TUN 模式且 FlowZ 非管理员权限运行：
    // sing-box 是 UAC 提权启动的，普通 Stop-Process 必然失败，直接走 UAC 提权
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    const skipNormalKill = isTunMode && !isRunningAsAdmin();

    if (!skipNormalKill) {
      // 策略 1：Stop-Process -Force
      try {
        execSync(
          'powershell -NoProfile -Command "Stop-Process -Name sing-box -Force -ErrorAction Stop"',
          {
            windowsHide: true,
            stdio: 'pipe',
            timeout: 5000,
          }
        );
        this.logToManager('debug', 'Stop-Process 执行完毕');
      } catch (e: any) {
        this.logToManager('debug', `Stop-Process 失败: stderr="${e.stderr?.toString().trim()}" status=${e.status}`);
      }

      for (let i = 0; i < 30; i++) {
        if (!hasSingBox()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // 策略 2：UAC 提权 Stop-Process（针对高完整性级别的进程）
    try {
      this.logToManager('info', '通过 UAC 提权终止 sing-box 进程');
      const uacKilled = await this.killAllSingBoxWithUAC();
      if (uacKilled) {
        for (let i = 0; i < 30; i++) {
          if (!hasSingBox()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } catch (e) {
      this.logToManager('debug', `UAC Stop-Process 异常: ${e}`);
    }

    return !hasSingBox();
  }

  /**
   * UAC 提权终止所有 sing-box 进程
   */
  private killAllSingBoxWithUAC(): Promise<boolean> {
    return new Promise((resolve) => {
      // 通过 -Verb RunAs 启动一个新的 PowerShell 进程执行 Stop-Process
      const psScript =
        "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-Command','Stop-Process -Name sing-box -Force' -Verb RunAs -Wait -WindowStyle Hidden";

      const killProcess = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', psScript,
      ], {
        windowsHide: true,
      });

      const timeout = setTimeout(() => {
        try { killProcess.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 15000);

      killProcess.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });

      killProcess.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  /**
   * 等待进程退出
   */
  private async waitForProcessExit(pid: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (!(await this.isProcessAlive(pid))) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !(await this.isProcessAlive(pid));
  }

  /**
   * 强制终止进程
   */
  private async forceKillProcess(pid: number): Promise<void> {
    return new Promise((resolve) => {
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -9 ${pid}" with administrator privileges`,
      ]);

      killProcess.on('close', () => {
        resolve();
      });

      killProcess.on('error', () => {
        // 最后尝试普通 kill
        try {
          process.kill(pid, 9);
        } catch {
          // 忽略错误
        }
        resolve();
      });
    });
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.stopLogFileWatcher();
    this.stopHealthCheck();
    this.singboxProcess = null;
    this.pid = null;
    this.singboxPid = null;
    this.startTime = null;
  }

  /**
   * 清理可能残留的 sing-box 进程
   * 这是解决"重启代理后网络不恢复"问题的关键
   */
  private async killOrphanedSingBoxProcesses(): Promise<void> {
    if (process.platform === 'darwin') {
      await this.killOrphanedProcessesMac();
    } else if (process.platform === 'win32') {
      await this.killOrphanedProcessesWindows();
    } else if (process.platform === 'linux') {
      await this.killOrphanedProcessesLinux();
    }
  }

  /**
   * macOS: 清理残留的 sing-box 进程
   * 优化：排除当前正在管理的进程，避免误杀
   * 
   * 注意：TUN 模式下 sing-box 以 root 权限运行，必须用 osascript 请求管理员权限才能终止
   */
  private async killOrphanedProcessesMac(): Promise<void> {
    return new Promise((resolve) => {
      // 使用 pgrep 查找所有 sing-box 进程
      const pgrep = spawn('/usr/bin/pgrep', ['-f', 'sing-box']);
      let pids = '';

      pgrep.stdout.on('data', (data: Buffer) => {
        pids += data.toString();
      });

      pgrep.on('close', async () => {
        let pidList = pids
          .trim()
          .split('\n')
          .filter((p) => p.trim())
          .map((p) => parseInt(p.trim(), 10))
          .filter((p) => !isNaN(p) && p > 0);

        // 排除当前正在管理的进程（避免误杀）
        const currentPid = this.singboxPid || this.pid;
        if (currentPid) {
          pidList = pidList.filter((p) => p !== currentPid);
        }

        if (pidList.length === 0) {
          resolve();
          return;
        }

        this.logToManager('warn', `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`);

        // TUN 模式下 sing-box 以 root 权限运行，必须用 osascript 请求管理员权限终止
        const killCmd = pidList.map((p) => `kill -9 ${p}`).join('; ');
        const killProcess = spawn('/usr/bin/osascript', [
          '-e',
          `do shell script "${killCmd}" with administrator privileges`,
        ]);

        killProcess.on('close', async (code) => {
          if (code === 0) {
            this.logToManager('info', '残留进程已清理');
          } else {
            this.logToManager('warn', `清理残留进程可能失败，退出码: ${code}`);
          }
          // 等待系统完全清理 TUN 接口和路由表
          await this.waitForNetworkCleanup();
          resolve();
        });

        killProcess.on('error', async (error) => {
          this.logToManager('warn', `清理残留进程失败: ${error.message}`);
          await this.waitForNetworkCleanup();
          resolve();
        });
      });

      pgrep.on('error', () => {
        resolve();
      });
    });
  }

  /**
   * 等待网络清理完成
   * sing-box 进程终止后，系统需要时间清理 TUN 接口和路由表
   */
  private async waitForNetworkCleanup(): Promise<void> {
    // 等待 2 秒让系统清理 TUN 接口
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 可选：刷新 DNS 缓存（macOS）
    if (process.platform === 'darwin') {
      try {
        const { exec } = require('child_process');
        exec('dscacheutil -flushcache; killall -HUP mDNSResponder', (error: Error | null) => {
          if (error) {
            this.logToManager('debug', `刷新 DNS 缓存失败: ${error.message}`);
          } else {
            this.logToManager('debug', 'DNS 缓存已刷新');
          }
        });
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * Windows: 清理残留的 sing-box 进程
   * 优化：排除当前正在管理的进程，避免误杀
   */
  private async killOrphanedProcessesWindows(): Promise<void> {
    const { execSync } = require('child_process');

    try {
      // 使用 PowerShell Get-Process 获取所有 sing-box 进程的 PID
      // 避免 wmic 在某些系统上的"关键错误"
      const result = execSync(
        'powershell -NoProfile -Command "Get-Process sing-box -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }"',
        {
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        }
      );

      let pidList: number[] = result
        .split(/\s+/)
        .map((s: string) => parseInt(s.trim(), 10))
        .filter((p: number) => !isNaN(p) && p > 0);

      // 排除当前正在管理的进程
      const currentPid = this.singboxPid || this.pid;
      if (currentPid) {
        pidList = pidList.filter((p: number) => p !== currentPid);
      }

      if (pidList.length === 0) {
        return;
      }

      this.logToManager('warn', `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`);

      // 用一次 Stop-Process 批量终止（按 PID）
      const pidArgs = pidList.join(',');
      try {
        execSync(
          `powershell -NoProfile -Command "Stop-Process -Id ${pidArgs} -Force -ErrorAction SilentlyContinue"`,
          {
            windowsHide: true,
            stdio: 'pipe',
            timeout: 5000,
          }
        );
      } catch (e: any) {
        this.logToManager('debug', `批量 Stop-Process 失败: ${e.stderr?.toString().trim()}`);
      }

      // 还有残留就 UAC 提权再杀一次
      const stillAlive: number[] = [];
      for (const p of pidList) {
        if (await this.isProcessAlive(p)) {
          stillAlive.push(p);
        }
      }
      if (stillAlive.length > 0) {
        this.logToManager('warn', `${stillAlive.length} 个进程未被普通权限终止，尝试 UAC 提权`);
        await this.killAllSingBoxWithUAC();
      }

      this.logToManager('info', '残留进程清理完成');

      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch {
      // 命令失败，可能没有残留进程
    }
  }

  /**
   * Linux: 清理残留的 sing-box 进程
   * TUN 模式下残留进程通常是 root 权限，需要 pkexec 终止
   */
  private async killOrphanedProcessesLinux(): Promise<void> {
    return new Promise((resolve) => {
      const pgrep = spawn('/usr/bin/pgrep', ['-f', 'sing-box']);
      let pids = '';

      pgrep.stdout.on('data', (data: Buffer) => {
        pids += data.toString();
      });

      pgrep.on('close', async () => {
        let pidList = pids
          .trim()
          .split('\n')
          .filter((p) => p.trim())
          .map((p) => parseInt(p.trim(), 10))
          .filter((p) => !isNaN(p) && p > 0);

        const currentPid = this.singboxPid || this.pid;
        if (currentPid) {
          pidList = pidList.filter((p) => p !== currentPid);
        }

        if (pidList.length === 0) {
          resolve();
          return;
        }

        this.logToManager('warn', `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`);

        const killed = await this.runPkexecKillMany(pidList, 'KILL');
        if (killed) {
          this.logToManager('info', 'Linux 残留进程已清理');
        } else {
          this.logToManager('warn', 'Linux 残留进程清理可能失败');
        }

        await this.waitForNetworkCleanup();
        resolve();
      });

      pgrep.on('error', () => {
        resolve();
      });
    });
  }

  private runPkexecKillMany(pids: number[], signal: 'TERM' | 'KILL'): Promise<boolean> {
    return new Promise((resolve) => {
      const args = ['/bin/kill', `-${signal}`, ...pids.map((pid) => String(pid))];
      const killProcess = spawn('/usr/bin/pkexec', args);

      const timeout = setTimeout(() => {
        try { killProcess.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 30000);

      killProcess.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });

      killProcess.on('error', (error) => {
        clearTimeout(timeout);
        this.logToManager('error', `执行 pkexec 批量 kill 失败: ${error.message}`);
        resolve(false);
      });
    });
  }

  /**
   * 检查进程是否存活
   *
   * 优先使用 process.kill(pid, 0)（纯系统调用，不创建子进程）。
   * - ESRCH → 进程已不存在，直接返回 false
   * - EPERM → 权限不足，回退到系统命令检测
   * - 其他错误 → 保守返回 true
   *
   * 对于 TUN 模式下以管理员权限运行的进程，process.kill 可能不可靠，
   * 此时回退到系统命令检测。
   */
  private async isProcessAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      if (e.code === 'ESRCH') {
        return false;
      }
    }

    try {
      const { execFile } = require('child_process');
      const run = (cmd: string, args: string[]): Promise<string> =>
        new Promise((resolve) => {
          execFile(cmd, args, { encoding: 'utf-8', windowsHide: true, timeout: 10000 }, (_err: Error | null, stdout: string) =>
            resolve(stdout.trim())
          );
        });

      if (process.platform === 'win32') {
        const result = await run('powershell', [
          '-NoProfile', '-Command',
          `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`,
        ]);
        const alive = result === 'alive';
        this.logToManager('debug', `isProcessAlive pid=${pid} alive=${alive}`);
        return alive;
      } else {
        const result = await run('ps', ['-p', String(pid), '-o', 'pid=']);
        const alive = result === String(pid);
        this.logToManager('debug', `isProcessAlive pid=${pid} alive=${alive}`);
        return alive;
      }
    } catch {
      return true;
    }
  }

  /**
   * 启动健康检查定时器
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, ProxyManager.HEALTH_CHECK_INTERVAL);

    this.logToManager('debug', '已启动进程健康检查');
  }

  /**
   * 停止健康检查定时器
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * 执行健康检查
   */
  private async performHealthCheck(): Promise<void> {
    if (this.isRestarting || this.isHealthCheckRunning) {
      return;
    }
    this.isHealthCheckRunning = true;
    try {
      const isTunMode = this.currentConfig?.proxyModeType === 'tun';
      const activePid = isTunMode ? this.singboxPid : (this.singboxPid || this.pid);

      if (!activePid) {
        return;
      }

      const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

      if (!(await this.isProcessAlive(activePid))) {
        await delay(500);

        if (await this.isProcessAlive(activePid)) {
          this.logToManager('warn', `健康检查首次误判进程 ${activePid} 已退出，二次确认进程仍存活`);
          return;
        }

        await delay(1000);

        if (await this.isProcessAlive(activePid)) {
          this.logToManager('warn', `健康检查二次误判进程 ${activePid} 已退出，三次确认进程仍存活`);
          return;
        }

        const exitInfo = this.getProcessExitInfo();
        const diagInfo = this.collectExitDiagnostics(activePid, isTunMode);
        const fullInfo = [exitInfo, diagInfo].filter(Boolean).join('; ');

        this.logToManager('error', `检测到 sing-box 进程 (PID: ${activePid}) 已意外退出${fullInfo ? `，${fullInfo}` : ''}`);

        this.singboxProcess = null;
        this.pid = null;
        this.singboxPid = null;
        this.stopLogFileWatcher();

        if (this.shouldAutoRestart()) {
          this.isRestarting = true;
          this.attemptAutoRestart().catch((error) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logToManager('error', `自动重启过程中发生未预期的错误: ${errorMessage}`);
            this.isRestarting = false;
          });
        } else {
          this.emit('error', {
            message: 'sing-box 进程意外退出，已达到最大重启次数，请手动重启',
            code: -1,
          });

          this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
            message: 'sing-box 进程多次异常退出，请检查网络或服务器配置后手动重启',
            code: -1,
          });

          this.emit('stopped');
          this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});

          this.cleanup();
        }
      }
    } finally {
      this.isHealthCheckRunning = false;
    }
  }

  /**
   * 收集进程退出的诊断信息
   * 用于在健康检查发现进程退出时，尽可能多地收集上下文
   */
  private collectExitDiagnostics(pid: number, isTunMode: boolean): string {
    const info: string[] = [];
    const { execSync } = require('child_process');

    try {
      info.push(`模式: ${isTunMode ? 'TUN' : '系统代理'}`);
      info.push(`运行时长: ${this.startTime ? Math.floor((Date.now() - this.startTime.getTime()) / 1000) + 's' : '未知'}`);

      if (process.platform === 'darwin') {
        // 检查是否有该 PID 的退出记录（通过 sysctl 或 dmesg）
        try {
          // 查询 ASL (Apple System Log) 中的进程退出记录
          const aslLog = execSync(
            `log show --predicate 'eventMessage CONTAINS "${pid}" AND (eventMessage CONTAINS "exit" OR eventMessage CONTAINS "signal" OR eventMessage CONTAINS "killed" OR eventMessage CONTAINS "jettisoned")' --last 2m --style compact 2>/dev/null | tail -5`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          const aslLines = aslLog.split('\n').filter((l: string) => !l.startsWith('Timestamp') && l.trim());
          if (aslLines.length > 0) {
            info.push(`系统退出记录: ${aslLines.join(' | ').substring(0, 300)}`);
          }
        } catch {
          // 忽略
        }

        // 检查是否被 macOS 的 memory pressure 杀掉
        try {
          const memPressure = execSync(
            `log show --predicate 'process == "kernel" AND eventMessage CONTAINS "jettisoned"' --last 2m --style compact 2>/dev/null | tail -3`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          const memLines = memPressure.split('\n').filter((l: string) => !l.startsWith('Timestamp') && l.trim());
          if (memLines.length > 0) {
            info.push(`内存压力事件: ${memLines.join(' | ').substring(0, 200)}`);
          }
        } catch {
          // 忽略
        }

        // 检查当前内存压力状态
        try {
          const memStatus = execSync('memory_pressure 2>/dev/null | head -1', {
            encoding: 'utf-8',
            timeout: 2000,
          }).trim();
          if (memStatus) {
            info.push(`内存状态: ${memStatus.substring(0, 100)}`);
          }
        } catch {
          // 忽略
        }
      }
    } catch {
      // 忽略诊断错误
    }

    return info.length > 0 ? info.join('; ') : '';
  }

  /**
   * 检查是否应该自动重启
   */
  private shouldAutoRestart(): boolean {
    if (!this.autoRestartEnabled || !this.currentConfig) {
      return false;
    }

    const now = Date.now();

    // 如果距离上次重启超过冷却时间，重置计数
    if (now - this.lastRestartTime > ProxyManager.RESTART_COOLDOWN) {
      this.restartCount = 0;
    }

    // 检查是否超过最大重启次数
    return this.restartCount < ProxyManager.MAX_RESTART_COUNT;
  }

  /**
   * 尝试自动重启
   */
  private async attemptAutoRestart(): Promise<void> {
    if (!this.currentConfig) {
      return;
    }

    this.isRestarting = true;
    this.restartCount++;
    this.lastRestartTime = Date.now();

    this.logToManager(
      'warn',
      `正在尝试自动重启 sing-box (第 ${this.restartCount}/${ProxyManager.MAX_RESTART_COUNT} 次)...`
    );

    // 通知前端正在重启
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: `sing-box 进程异常退出，正在自动重启 (${this.restartCount}/${ProxyManager.MAX_RESTART_COUNT})...`,
      code: -2, // 特殊代码表示正在重启
    });

    try {
      // 等待一小段时间让系统清理
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 重新启动
      await this.start(this.currentConfig);

      this.logToManager('info', 'sing-box 自动重启成功');

      // 通知前端重启成功
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
        pid: this.singboxPid || this.pid,
        startTime: this.startTime,
        autoRestarted: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logToManager('error', `自动重启失败: ${errorMessage}`);

      // 如果还有重试机会，会在下次健康检查时再次尝试
      if (this.restartCount >= ProxyManager.MAX_RESTART_COUNT) {
        this.emit('error', {
          message: `自动重启失败: ${errorMessage}`,
          code: -1,
        });

        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
          message: `自动重启失败，请手动重启: ${errorMessage}`,
          code: -1,
        });

        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
        this.cleanup();
      }
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * 设置是否启用自动重启
   */
  setAutoRestartEnabled(enabled: boolean): void {
    this.autoRestartEnabled = enabled;
    this.logToManager('info', `自动重启已${enabled ? '启用' : '禁用'}`);
  }

  /**
   * 重置重启计数（用于用户手动启动后）
   */
  private resetRestartCount(): void {
    this.restartCount = 0;
    this.lastRestartTime = 0;
  }

  /**
   * 获取进程退出信息（用于诊断）
   * 尝试从系统日志或 sing-box 日志文件中获取退出原因
   */
  private getProcessExitInfo(): string {
    const info: string[] = [];
    
    try {
      const fsSync = require('fs');

      // 读取 wrapper 脚本的退出诊断文件（macOS TUN 模式）
      const exitInfoFile = path.join(getUserDataPath(), 'singbox_exit.log');
      if (fsSync.existsSync(exitInfoFile)) {
        try {
          const exitContent = fsSync.readFileSync(exitInfoFile, 'utf-8').trim();
          if (exitContent) {
            info.push(`退出诊断: ${exitContent.substring(0, 500)}`);
          }
        } catch {
          // 忽略
        }
      }

      const logFilePath = this.getLogFilePath();
      
      // 读取 sing-box 日志文件的最后几行
      if (fsSync.existsSync(logFilePath)) {
        const logContent = fsSync.readFileSync(logFilePath, 'utf-8');
        const lines = logContent.trim().split('\n');
        const lastLines = lines.slice(-20); // 最后 20 行（增加范围以获取更多上下文）
        
        // 先查找错误或警告信息
        const errorLines: string[] = [];
        for (const line of lastLines) {
          const lowerLine = line.toLowerCase();
          if (lowerLine.includes('error') || lowerLine.includes('fatal') || 
              lowerLine.includes('panic') || lowerLine.includes('failed') ||
              lowerLine.includes('closed') || lowerLine.includes('terminated')) {
            errorLines.push(line.substring(0, 200));
          }
        }
        
        if (errorLines.length > 0) {
          info.push(`日志: ${errorLines.join(' | ')}`);
        } else if (lastLines.length > 0) {
          // 没有明确的错误信息，输出最后 3 行作为上下文
          const tail = lastLines.slice(-3).map((l: string) => l.substring(0, 150));
          info.push(`最后日志: ${tail.join(' | ')}`);
        } else {
          info.push('日志文件为空');
        }
      } else {
        info.push('日志文件不存在');
      }
      
      // macOS: 尝试从系统日志获取信息
      if (process.platform === 'darwin') {
        const { execSync } = require('child_process');
        try {
          // 查询最近的 sing-box 相关系统日志
          const sysLog = execSync(
            `log show --predicate 'process == "sing-box"' --last 1m --style compact 2>/dev/null | tail -5`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          if (sysLog) {
            // 过滤掉只有表头没有实际内容的情况
            const sysLogLines = sysLog.split('\n').filter((l: string) => !l.startsWith('Timestamp') && l.trim());
            if (sysLogLines.length > 0) {
              info.push(`系统日志: ${sysLogLines.join(' | ').substring(0, 300)}`);
            }
          }
        } catch {
          // 忽略系统日志查询失败
        }
        
        // 额外检查：是否有 crash report
        try {
          const crashLog = execSync(
            `ls -t ~/Library/Logs/DiagnosticReports/sing-box* 2>/dev/null | head -1`,
            { encoding: 'utf-8', timeout: 2000 }
          ).trim();
          if (crashLog) {
            info.push(`发现崩溃报告: ${crashLog}`);
            // 读取崩溃报告的前几行
            try {
              const crashContent = execSync(
                `head -20 "${crashLog}" 2>/dev/null`,
                { encoding: 'utf-8', timeout: 2000 }
              ).trim();
              if (crashContent) {
                // 提取关键信息：Exception Type 和 Termination Reason
                const relevantLines = crashContent.split('\n').filter((l: string) => 
                  l.includes('Exception') || l.includes('Termination') || l.includes('Signal')
                );
                if (relevantLines.length > 0) {
                  info.push(`崩溃原因: ${relevantLines.join('; ').substring(0, 200)}`);
                }
              }
            } catch {
              // 忽略
            }
          }
        } catch {
          // 忽略
        }
      }
    } catch (error) {
      // 忽略诊断错误
    }
    
    return info.length > 0 ? info.join('; ') : '';
  }

  /**
   * 等待 PID 文件被写入（macOS/Windows TUN 模式）
   * 
   * 重要：在调用此方法前，必须先删除旧的 PID 文件，否则可能读到旧的 PID
   */
  private async waitForPidFile(): Promise<void> {
    const pidFile = this.getPidFilePath();
    const maxWaitTime = this.needsLinuxPkexec() ? 60000 : 10000; // Linux pkexec 可能需要等待用户授权
    const checkInterval = 200; // 每 200ms 检查一次
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const pidContent = await fs.readFile(pidFile, 'utf-8');
        const pid = parseInt(pidContent.trim(), 10);
        if (!isNaN(pid) && pid > 0) {
          // 验证这个 PID 对应的进程确实存在且是 sing-box
          if (await this.isProcessAlive(pid)) {
            this.singboxPid = pid;
            this.pid = pid;
            this.logToManager('info', `sing-box 后台进程 PID: ${pid}`);
            return;
          }
        }
      } catch {
        // 文件还不存在，继续等待
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    this.logToManager('warn', 'PID 文件等待超时');
  }

  /**
   * 删除 PID 文件
   * 在启动新进程前调用，确保不会读到旧的 PID
   */
  private async deletePidFile(): Promise<void> {
    try {
      await fs.unlink(this.getPidFilePath());
    } catch {
      // 文件不存在，忽略
    }
  }

  /**
   * 获取 PID 文件路径
   */
  private getPidFilePath(): string {
    return path.join(getUserDataPath(), 'singbox.pid');
  }

  /**
   * 启动日志文件监控（用于 TUN 模式，提权进程无法捕获 stdout）
   */
  private startLogFileWatcher(): void {
    if (this.logFileWatcher) {
      return;
    }

    const logFilePath = this.getLogFilePath();
    this.lastLogFileSize = 0;

    // 清空旧的日志文件
    const fsSync = require('fs');
    try {
      fsSync.writeFileSync(logFilePath, '');
    } catch {
      // 忽略错误
    }

    // 每 500ms 检查一次日志文件
    this.logFileWatcher = setInterval(async () => {
      let fd: import('fs/promises').FileHandle | null = null;
      try {
        const stats = await fs.stat(logFilePath);
        if (stats.size > this.lastLogFileSize) {
          // 读取新增的内容
          fd = await fs.open(logFilePath, 'r');
          const buffer = Buffer.alloc(stats.size - this.lastLogFileSize);
          await fd.read(buffer, 0, buffer.length, this.lastLogFileSize);

          const newContent = buffer.toString('utf-8');
          this.lastLogFileSize = stats.size;

          // 处理日志内容
          if (newContent.trim()) {
            this.handleProcessOutput(newContent);
          }
        }
      } catch {
        // 文件可能还不存在，忽略错误
      } finally {
        // 确保文件句柄始终被关闭
        if (fd) {
          try {
            await fd.close();
          } catch {
            // 忽略关闭错误
          }
        }
      }
    }, 500);
  }

  /**
   * 停止日志文件监控
   */
  private stopLogFileWatcher(): void {
    if (this.logFileWatcher) {
      clearInterval(this.logFileWatcher);
      this.logFileWatcher = null;
    }
    this.lastLogFileSize = 0;
  }

  /**
   * 处理进程输出
   */
  private handleProcessOutput(data: string): void {
    // 移除 ANSI 颜色代码
    const cleanData = this.removeAnsiCodes(data);

    // 按行分割
    const lines = cleanData.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      this.parseAndLogLine(line);
    }
  }

  /**
   * 移除 ANSI 颜色代码
   */
  private removeAnsiCodes(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  /**
   * 解析并记录日志行
   */
  private parseAndLogLine(line: string): void {
    // 过滤重复日志
    if (this.isDuplicateLog(line)) {
      return;
    }

    // 过滤低价值日志（连接建立、DNS 查询等频繁日志）
    if (this.isLowValueLog(line)) {
      return;
    }

    // 解析 sing-box 日志格式
    const logInfo = this.parseSingBoxLog(line);

    if (logInfo) {
      // 转换为友好的中文提示
      const friendlyMessage = this.translateErrorMessage(logInfo.message);

      // 空消息不记录（如私有 IP 超时）
      if (friendlyMessage) {
        this.logToManager(logInfo.level, friendlyMessage);
      }
    } else {
      // 无法解析的日志，直接记录
      this.logToManager('info', line);
    }
  }

  /**
   * 检查是否为低价值日志（应该被过滤）
   * 保留：路由决策、错误、启动/停止等重要日志
   * 过滤：频繁的连接关闭、握手细节等日志
   */
  private isLowValueLog(line: string): boolean {
    const lowerLine = line.toLowerCase();

    // 高价值日志模式 - 这些日志应该优先保留，即使包含噪音关键词
    const keepPatterns = [
      'started', // 启动完成
      'stopped', // 停止
      'sing-box started', // sing-box 启动
      'error', // 错误
      'fatal', // 致命错误
      'warn', // 警告
      'failed', // 失败
      'updated default interface', // 网络接口变化
      // 路由决策相关 - 关键日志
      'match rule', // 匹配规则
      'final rule', // 最终规则
      'rule-set', // 规则集匹配
      'outbound/proxy', // 代理出站 - 用户关心的
    ];

    for (const pattern of keepPatterns) {
      if (lowerLine.includes(pattern)) {
        return false; // 不过滤，保留这条日志
      }
    }

    // 优先过滤的噪音日志（仅在不包含高价值关键词时才过滤）
    const noisePatterns = [
      'connection upload closed',
      'connection download closed',
      'forcibly closed',
      'connection closed',
      'connection established',
      'tls handshake',
      'handshake completed',
    ];

    for (const pattern of noisePatterns) {
      if (lowerLine.includes(pattern)) {
        return true; // 过滤掉
      }
    }

    // 检查是否为内网IP的直连连接（这些太频繁，需要过滤）
    if (lowerLine.includes('outbound/direct')) {
      // 检查是否连接到私有IP地址
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(line)) {
          return true; // 过滤内网直连
        }
      }
      // 公网直连保留（如 CDN、国内网站等）
      return false;
    }

    // 过滤的低价值日志模式
    const filterPatterns = [
      'dns query', // DNS 查询
      'dns response', // DNS 响应
      'dns: exchanged', // DNS 交换
      'dns: cached', // DNS 缓存
      'resolved', // DNS 解析完成
      'udp packet', // UDP 包
      'inbound/tun[tun-in]', // TUN 入站细节
      'inbound/http[http-in]', // HTTP 入站细节
      'inbound/socks[socks-in]', // SOCKS 入站细节
    ];

    for (const pattern of filterPatterns) {
      if (lowerLine.includes(pattern)) {
        return true; // 过滤掉
      }
    }

    return false; // 默认保留
  }

  /**
   * 检查是否为重复日志
   */
  private isDuplicateLog(message: string): boolean {
    const now = Date.now();

    // 如果消息相同且在 1 秒内
    if (message === this.lastLogMessage && now - this.lastLogTime < 1000) {
      this.lastLogCount++;

      // 如果重复超过 5 次，过滤掉
      if (this.lastLogCount > 5) {
        return true;
      }
    } else {
      // 新消息，重置计数
      this.lastLogMessage = message;
      this.lastLogCount = 1;
      this.lastLogTime = now;
    }

    return false;
  }

  /**
   * 解析 sing-box 日志
   */
  private parseSingBoxLog(
    line: string
  ): { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; message: string } | null {
    // sing-box 日志格式示例：
    // 2024-01-01 12:00:00 INFO message
    // 2024-01-01 12:00:00 [INFO] message

    // 尝试匹配日志级别
    const levelMatch = line.match(/\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i);
    if (!levelMatch) {
      return null;
    }

    let level = levelMatch[1].toUpperCase();
    if (level === 'WARNING') {
      level = 'WARN';
    }

    // 提取消息内容（去掉时间戳和级别）
    const message = line
      .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/, '')
      .replace(/\[?(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]?/i, '')
      .trim();

    return {
      level: level.toLowerCase() as 'debug' | 'info' | 'warn' | 'error' | 'fatal',
      message,
    };
  }

  /**
   * 翻译错误消息为友好的中文提示
   * 返回格式：友好提示 + 原始错误（如果有翻译）
   */
  private translateErrorMessage(message: string): string {
    console.error(message);
    const lowerMessage = message.toLowerCase();

    // 常见错误模式匹配
    if (lowerMessage.includes('dns') && lowerMessage.includes('fail')) {
      return `DNS 解析失败：无法解析服务器域名，请检查 DNS 设置 [${message}]`;
    }

    if (
      lowerMessage.includes('connection refused') ||
      lowerMessage.includes('connect: connection refused')
    ) {
      return `连接被拒绝：无法连接到代理服务器，请检查服务器地址和端口是否正确 [${message}]`;
    }

    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      // 尝试提取目标地址
      const match = message.match(/connection.*?to\s+([^\s:]+(?::\d+)?)/i);
      const target = match ? match[1] : '';
      // 私有 IP 超时不显示（内网服务走代理必然超时）
      if (target && /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(target)) {
        return ''; // 返回空字符串，后续会被过滤
      }
      return target ? `连接超时: ${target}` : '连接超时：服务器响应超时';
    }

    if (
      lowerMessage.includes('certificate') ||
      lowerMessage.includes('tls') ||
      lowerMessage.includes('ssl')
    ) {
      // 保留原始错误信息，帮助用户诊断具体的证书问题
      return `TLS 证书错误：服务器证书验证失败 [${message}]`;
    }

    if (lowerMessage.includes('authentication failed') || lowerMessage.includes('auth fail')) {
      return `认证失败：用户名或密码错误，请检查服务器配置 [${message}]`;
    }

    if (lowerMessage.includes('permission denied') || lowerMessage.includes('access denied')) {
      return `权限不足：需要管理员权限才能启动 TUN 模式 [${message}]`;
    }

    if (
      lowerMessage.includes('address already in use') ||
      lowerMessage.includes('bind: address already in use')
    ) {
      return `端口已被占用：请更换其他端口或关闭占用端口的程序 [${message}]`;
    }

    if (lowerMessage.includes('invalid config') || lowerMessage.includes('config error')) {
      return `配置错误：sing-box 配置文件格式不正确 [${message}]`;
    }

    // 如果没有匹配到特定错误，返回原始消息
    return message;
  }

  /**
   * 记录日志到 LogManager
   */
  private logToManager(
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string
  ): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'sing-box');
    }
  }

  /**
   * 处理进程错误
   */
  private handleProcessError(error: Error): void {
    const errorMessage = this.translateErrorMessage(error.message);

    // 触发错误事件
    this.emit('error', {
      message: errorMessage,
      error: error.message,
    });

    // 发送到前端
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: errorMessage,
      error: error.message,
    });
  }

  /**
   * 处理进程退出
   */
  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    // 解析退出原因
    const exitReason = this.parseExitReason(code, signal);

    this.logToManager('info', `sing-box process exited: ${exitReason}`);

    // 如果是异常退出（非正常停止）
    if (code !== null && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      const errorMessage = this.parseExitError(code);

      this.logToManager('error', `sing-box异常退出: ${errorMessage}`);

      // 触发错误事件
      this.emit('error', {
        message: errorMessage,
        code,
        signal,
      });

      // 发送到前端
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
        message: errorMessage,
        code,
        signal,
      });
    } else {
      // 正常退出，触发停止事件
      this.emit('stopped');
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
    }

    this.cleanup();
  }

  /**
   * 解析退出原因
   */
  private parseExitReason(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) {
      return `信号 ${signal}`;
    }
    if (code !== null) {
      return `退出码 ${code}`;
    }
    return '未知原因';
  }

  /**
   * 解析退出错误
   */
  private parseExitError(code: number): string {
    // 尝试从最后的错误输出中提取错误信息
    if (this.lastErrorOutput) {
      const friendlyMessage = this.translateErrorMessage(this.lastErrorOutput);
      if (friendlyMessage !== this.lastErrorOutput) {
        return friendlyMessage;
      }
    }

    // 根据退出码返回通用错误信息
    switch (code) {
      case 1:
        return 'sing-box 启动失败，请检查配置文件';
      case 2:
        return 'sing-box 配置文件格式错误';
      case 126:
        return 'sing-box 可执行文件没有执行权限';
      case 127:
        return '找不到 sing-box 可执行文件';
      case 137:
        return 'sing-box 进程被强制终止';
      case 143:
        return 'sing-box 进程被正常终止';
      default:
        return `sing-box 异常退出，退出码: ${code}`;
    }
  }

  /**
   * 发送事件到渲染进程
   */
  private sendEventToRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * 获取 sing-box 可执行文件路径
   */
  private getSingBoxPath(): string {
    return resourceManager.getSingBoxPath();
  }
}
