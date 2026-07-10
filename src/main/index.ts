import { app, BrowserWindow, dialog, Menu } from 'electron';

// 优化 Chromium 资源占用
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
app.commandLine.appendSwitch('disable-webgl');
app.commandLine.appendSwitch('disable-features', 'TranslateUI,OptimizationGuide,ChromeWhatsNewUI,MediaRouter,InterestFeedContentSuggestions');
app.commandLine.appendSwitch('disable-background-timer-throttling');
import * as path from 'path';
import { ConfigManager } from './services/ConfigManager';
import { ProtocolParser } from './services/ProtocolParser';
import { LogManager } from './services/LogManager';
import { TrayManager } from './services/TrayManager';
import { ProxyManager } from './services/ProxyManager';
import { createSystemProxyManager } from './services/SystemProxyManager';
import { resourceManager } from './services/ResourceManager';
import {
  registerConfigHandlers,
  registerServerHandlers,
  registerLogHandlers,
  registerProxyHandlers,
  registerVersionHandlers,
  registerAdminHandlers,
  registerUpdateHandlers,
  registerRulesHandlers,
  registerAutoStartHandlers,
  setUpdateService,
  setTrayStateCallback,
} from './ipc/handlers';
import { createAutoStartManager } from './services/AutoStartManager';
import { UpdateService } from './services/UpdateService';
import { ipcEventEmitter } from './ipc/ipc-events';
import { mainEventEmitter, MAIN_EVENTS } from './ipc/main-events';
import { initUserDataPath } from './utils/paths';
import { getSystemDnsServers } from './utils/dns';

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
const isDevelopment = process.env.NODE_ENV === 'development';

// 在导入任何使用路径的服务之前，初始化用户数据路径
// 这确保无论以何种权限运行，都使用正确的路径
initUserDataPath();

// 初始化服务
const configManager = new ConfigManager();
const protocolParser = new ProtocolParser();
const logManager = new LogManager();
let proxyManager: ProxyManager | null = null;
const systemProxyManager = createSystemProxyManager();
const updateService = new UpdateService(logManager);

// 全局异常捕获 - 主进程
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
  logManager.addLog('fatal', `未捕获的异常: ${error.message}\n${error.stack}`, 'Main');

  // 在开发环境显示错误对话框
  if (isDevelopment) {
    dialog.showErrorBox('未捕获的异常', `${error.message}\n\n${error.stack}`);
  }

  // 不退出应用，尝试继续运行
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  const errorStack = reason instanceof Error ? reason.stack : '';
  logManager.addLog('error', `未处理的 Promise 拒绝: ${errorMessage}\n${errorStack}`, 'Main');

  // 在开发环境显示错误对话框
  if (isDevelopment && reason instanceof Error) {
    dialog.showErrorBox('未处理的 Promise 拒绝', `${errorMessage}\n\n${errorStack}`);
  }
});

// 开发环境启用热重载
if (isDevelopment) {
  try {
    // __dirname 在打包后是 dist/main/main/，需要往上3层到项目根目录
    const projectRoot = path.join(__dirname, '../../..');
    const electronPath =
      process.platform === 'win32'
        ? path.join(projectRoot, 'node_modules/.bin/electron.cmd')
        : path.join(projectRoot, 'node_modules/.bin/electron');

    require('electron-reload')(__dirname, {
      electron: electronPath,
      hardResetMethod: 'exit',
    });
  } catch (err) {
    console.error('Failed to load electron-reload:', err);
  }
}

/**
 * 显示主窗口
 * 如果窗口不存在则创建，如果已存在则显示并聚焦
 */
function showWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function createWindow() {
  // macOS 需要设置应用菜单以启用 Cmd+C/V/X/A 等快捷键
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
          { role: 'delete', label: '删除' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { type: 'separator' },
          { role: 'front', label: '前置全部窗口' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // 创建主窗口
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'FlowZ',
    icon: resourceManager.getAppIconPath(),
    show: false, // 先不显示，等待加载完成
    backgroundColor: '#ffffff',
    autoHideMenuBar: true, // 自动隐藏菜单栏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: true, // 启用开发者工具以便调试
    },
    // macOS 特定配置
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset',
    }),
  });

  // 移除默认菜单栏（Windows/Linux）
  if (process.platform !== 'darwin') {
    mainWindow.setMenu(null);
  }

  // 注册窗口到 IPC 事件发送器，以便接收广播事件
  ipcEventEmitter.registerWindow(mainWindow);

  // 更新托盘管理器的窗口引用
  if (trayManager) {
    trayManager.setMainWindow(mainWindow);
  }

  // 窗口加载完成后显示
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    logManager.addLog('info', 'Main window shown', 'Main');
  });

  // 生产环境下允许通过快捷键打开开发者工具（用于调试）
  if (!isDevelopment) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        mainWindow?.webContents.toggleDevTools();
      }
    });
  }

  // 开发环境加载 Vite 开发服务器
  if (isDevelopment) {
    mainWindow.loadURL('http://localhost:5173').catch((err) => {
      logManager.addLog('error', `Failed to load dev server: ${err.message}`, 'Main');
    });
    mainWindow.webContents.openDevTools();
  } else {
    // 生产环境加载打包后的文件
    let indexPath: string;

    if (__dirname.includes('app.asar')) {
      // 在 asar 包中，使用 app.asar.unpacked 路径
      const asarPath = __dirname.replace('app.asar', 'app.asar.unpacked');
      indexPath = path.join(asarPath, '../../renderer/index.html');
    } else {
      // 不在 asar 包中
      indexPath = path.join(__dirname, '../../renderer/index.html');
    }

    mainWindow.loadFile(indexPath).catch((err) => {
      logManager.addLog('error', `Failed to load index.html: ${err.message}`, 'Main');
    });
  }

  // 处理窗口加载错误
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    logManager.addLog('error', `Window failed to load: ${errorDescription} (${errorCode})`, 'Main');
  });

  // 窗口隐藏时降低帧率，减少 GPU 开销
  mainWindow.on('hide', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setFrameRate(2);
    }
  });

  // 窗口显示时恢复帧率
  mainWindow.on('show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setFrameRate(60);
    }
  });

  // 处理窗口关闭事件
  mainWindow.on('close', async (event) => {
    // 保存窗口引用，因为在异步操作后 mainWindow 可能变为 null
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;

    // 获取用户配置
    const config = await configManager.loadConfig();

    // 再次检查窗口是否仍然有效
    if (window.isDestroyed()) return;

    // 如果配置为最小化到托盘，则阻止窗口关闭，改为隐藏
    if (config.minimizeToTray) {
      event.preventDefault();
      window.hide();
      logManager.addLog('info', 'Window hidden to tray', 'Main');
    } else {
      // 否则允许窗口关闭，应用将退出
      logManager.addLog('info', 'Window closing, app will quit', 'Main');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (trayManager) {
      trayManager.setMainWindow(null);
    }
    logManager.addLog('info', 'Main window closed', 'Main');
  });
}

/**
 * 清理应用资源
 * 在应用退出前调用，确保清理系统代理和终止进程
 */
async function cleanupResources(): Promise<void> {
  logManager.addLog('info', 'Cleaning up resources before exit...', 'Main');

  try {
    // 1. 停止代理进程
    if (proxyManager) {
      const status = proxyManager.getStatus();
      if (status.running) {
        logManager.addLog('info', 'Stopping proxy process...', 'Main');
        await proxyManager.stop();
        logManager.addLog('info', 'Proxy process stopped', 'Main');
      }
    }

    // 2. 清理系统代理设置
    try {
      const proxyStatus = await systemProxyManager.getProxyStatus();
      if (proxyStatus.enabled) {
        logManager.addLog('info', 'Disabling system proxy...', 'Main');
        await systemProxyManager.disableProxy();
        logManager.addLog('info', 'System proxy disabled', 'Main');
      }
    } catch (error) {
      // 系统代理清理失败不应阻止应用退出
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('warn', `Failed to disable system proxy: ${errorMessage}`, 'Main');
      console.warn('Failed to disable system proxy:', error);
    }

    logManager.addLog('info', 'Resource cleanup completed', 'Main');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logManager.addLog('error', `Error during cleanup: ${errorMessage}`, 'Main');
    console.error('Error during cleanup:', error);
  }
}

/**
 * 导出托盘管理器（用于测试）
 */
export function getTrayManager(): TrayManager | null {
  return trayManager;
}

/**
 * 更新托盘菜单状态
 * @param isProxyRunning 代理是否正在运行
 * @param hasError 是否存在连接错误
 */
async function updateTrayMenuState(isProxyRunning: boolean, hasError?: boolean): Promise<void> {
  if (!trayManager) return;

  try {
    const config = await configManager.loadConfig();
    trayManager.updateFullTrayMenu({
      isProxyRunning,
      hasError,
      servers: config.servers,
      selectedServerId: config.selectedServerId,
      proxyMode: config.proxyMode,
    });

    // 同时更新托盘图标状态
    trayManager.updateTrayIcon(isProxyRunning ? 'connected' : 'idle');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logManager.addLog('error', `Failed to update tray menu state: ${errorMessage}`, 'Main');
  }
}

app.whenReady().then(async () => {
  // 记录应用启动日志
  logManager.addLog('info', 'Application started', 'Main');

  // macOS: 禁用 App Nap，防止系统认为应用"没有响应"
  // 当应用在后台运行代理时，App Nap 会导致系统误判应用状态
  if (process.platform === 'darwin') {
    const { powerSaveBlocker } = require('electron');
    powerSaveBlocker.start('prevent-app-suspension');
  }

  // 设置 macOS Dock 图标
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = resourceManager.getAppIconPath();
    const fs = require('fs');
    if (fs.existsSync(iconPath)) {
      const { nativeImage } = require('electron');
      const icon = nativeImage.createFromPath(iconPath);
      // 调整为标准 Dock 图标尺寸
      const resizedIcon = icon.resize({ width: 128, height: 128 });
      app.dock.setIcon(resizedIcon);
    }
  }

  // 加载配置并处理错误
  try {
    const config = await configManager.loadConfig();
    logManager.addLog('info', 'Configuration loaded successfully', 'Main');

    // 检查配置是否为默认配置（可能是因为加载失败）
    if (config.servers.length === 0 && config.selectedServerId === null) {
      // 这可能是首次启动或配置文件损坏
      logManager.addLog('warn', 'Using default configuration', 'Main');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logManager.addLog('error', `Failed to load configuration: ${errorMessage}`, 'Main');

    // 显示错误对话框通知用户
    dialog.showErrorBox(
      '配置加载失败',
      `无法加载配置文件，将使用默认配置。\n\n错误信息: ${errorMessage}`
    );
  }

  createWindow();

  // 初始化 ProxyManager（需要在窗口创建后）
  proxyManager = new ProxyManager(logManager, mainWindow || undefined);

  // 监听代理管理器事件，更新托盘状态
  proxyManager.on('error', async (error: Error) => {
    logManager.addLog('error', `Proxy error: ${error.message}`, 'Main');
    // 发生错误时，更新托盘显示为"连接异常"
    updateTrayMenuState(false, true);

    // 进程意外退出时，清理系统代理设置，避免网络不可用
    try {
      const proxyStatus = await systemProxyManager.getProxyStatus();
      if (proxyStatus.enabled) {
        logManager.addLog('info', 'Disabling system proxy due to proxy error...', 'Main');
        await systemProxyManager.disableProxy();
        logManager.addLog('info', 'System proxy disabled after error', 'Main');
      }
    } catch (cleanupError) {
      const errorMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logManager.addLog('warn', `Failed to disable system proxy after error: ${errorMessage}`, 'Main');
    }
  });

  proxyManager.on('stopped', async () => {
    // 正常停止时，重置错误状态
    updateTrayMenuState(false, false);

    // 确保系统代理被清理
    try {
      const proxyStatus = await systemProxyManager.getProxyStatus();
      if (proxyStatus.enabled) {
        await systemProxyManager.disableProxy();
        logManager.addLog('info', 'System proxy disabled on stop', 'Main');
      }
    } catch (cleanupError) {
      const errorMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logManager.addLog('warn', `Failed to disable system proxy on stop: ${errorMessage}`, 'Main');
    }
  });

  // 注册 IPC 处理器（需要在 ProxyManager 创建后）
  registerConfigHandlers(configManager);
  registerServerHandlers(protocolParser, configManager);
  registerLogHandlers(logManager, proxyManager);
  registerProxyHandlers(proxyManager, systemProxyManager);
  registerVersionHandlers();
  registerAdminHandlers();
  registerRulesHandlers(configManager);

  // 注册自启动处理器
  registerAutoStartHandlers();

  // 同步自启动状态
  const autoStartManager = createAutoStartManager();
  const config = await configManager.loadConfig();
  await autoStartManager.setAutoStart(config.autoStart ?? false);

  // 注册更新处理器
  setUpdateService(updateService);
  updateService.setMainWindow(mainWindow);
  // 设置更新前的清理回调，确保在安装更新前停止代理进程
  updateService.setCleanupCallback(cleanupResources);
  registerUpdateHandlers();

  // 设置托盘状态更新回调
  setTrayStateCallback((isRunning: boolean, hasError?: boolean) => {
    updateTrayMenuState(isRunning, hasError);
  });

  // 创建托盘图标
  trayManager = new TrayManager(mainWindow, logManager, {
    onStartProxy: async () => {
      try {
        const config = await configManager.loadConfig();
        if (proxyManager) {
          await proxyManager.start(config);

          // 系统代理模式：设置系统代理
          const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();
          if (modeType === 'systemproxy') {
            await systemProxyManager.enableProxy(
              '127.0.0.1',
              config.httpPort || 65533,
              config.socksPort || 65534
            );
          }

          logManager.addLog('info', 'Proxy started from tray', 'Main');
          // 更新托盘菜单状态
          updateTrayMenuState(true);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logManager.addLog('error', `Failed to start proxy: ${errorMessage}`, 'Main');
      }
    },
    onStopProxy: async () => {
      try {
        // 先禁用系统代理（不管当前状态如何，都尝试禁用）
        await systemProxyManager.disableProxy();

        if (proxyManager) {
          await proxyManager.stop();
          logManager.addLog('info', 'Proxy stopped from tray', 'Main');
          // 更新托盘菜单状态
          updateTrayMenuState(false);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logManager.addLog('error', `Failed to stop proxy: ${errorMessage}`, 'Main');
      }
    },
    onShowWindow: () => {
      showWindow();
    },
    onQuit: async () => {
      // 清理资源后退出
      await cleanupResources();
      app.exit(0);
    },
    onSelectServer: async (serverId: string) => {
      try {
        const config = await configManager.loadConfig();
        config.selectedServerId = serverId;
        await configManager.saveConfig(config);
        logManager.addLog('info', `Server selected from tray: ${serverId}`, 'Main');

        // saveConfig 已触发 CONFIG_CHANGED，自动处理热更新或重启

        // 更新托盘菜单
        updateTrayMenuState(proxyManager?.getStatus().running ?? false);

        // 通知渲染进程配置已更新
        ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logManager.addLog('error', `Failed to select server: ${errorMessage}`, 'Main');
      }
    },
    onChangeProxyMode: async (mode) => {
      try {
        const config = await configManager.loadConfig();
        config.proxyMode = mode;
        await configManager.saveConfig(config);
        logManager.addLog('info', `Proxy mode changed from tray: ${mode}`, 'Main');

        // saveConfig 已触发 CONFIG_CHANGED，自动处理重启

        // 更新托盘菜单
        updateTrayMenuState(proxyManager?.getStatus().running ?? false);

        // 通知渲染进程配置已更新
        ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logManager.addLog('error', `Failed to change proxy mode: ${errorMessage}`, 'Main');
      }
    },
    onOpenSettings: () => {
      showWindow();
      // 发送导航事件到渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('navigate', '/settings');
      }
    },
    onCheckUpdate: async () => {
      // 检查更新并显示对话框
      const result = await updateService.checkForUpdate();
      if (result.hasUpdate && result.updateInfo) {
        const action = await updateService.showUpdateDialog(result.updateInfo);
        if (action === 'update') {
          // 使用带进度窗口的下载方法
          const filePath = await updateService.downloadUpdateWithProgress(result.updateInfo);
          if (filePath) {
            await updateService.installUpdate(filePath);
          }
        } else if (action === 'skip') {
          updateService.skipVersion(result.updateInfo.version);
        }
      } else if (!result.error) {
        // 没有更新，显示提示
        if (mainWindow && !mainWindow.isDestroyed()) {
          const { dialog } = require('electron');
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '检查更新',
            message: '当前已是最新版本',
            buttons: ['确定'],
          });
        }
      }
    },
    onManageServers: () => {
      showWindow();
      // 发送导航事件到渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('navigate', '/server');
      }
    },
    onSpeedTest: async () => {
      try {
        const config = await configManager.loadConfig();
        if (config.servers.length === 0) {
          logManager.addLog('warn', 'No servers configured for speed test', 'Main');
          return;
        }

        logManager.addLog('info', `Starting speed test for ${config.servers.length} servers`, 'Main');

        const { isIP } = require('net');
        const http = require('http');
        const fs = require('fs/promises');
        const { spawn } = require('child_process');

        const BASE_PORT = 65401;
        const TEST_TIMEOUT = 12000;
        const SINGBOX_STARTUP_TIMEOUT = 20000;

        // 收集 stderr/stdout 用于调试
        const stderrChunks: string[] = [];
        const stdoutChunks: string[] = [];
        const logOutput = (source: string, chunks: string[]) => {
          if (chunks.length > 0) {
            const lines = chunks.join('').split('\n').filter(l => l.trim());
            lines.forEach(l => logManager.addLog('info', `[sing-box ${source}] ${l}`, 'SpeedTest'));
            chunks.length = 0;
          }
        };

        // 为单个服务器生成 sing-box outbound 配置
        const buildOutbound = (server: typeof config.servers[0], tag: string) => {
          const protocol = server.protocol.toLowerCase();
          const outbound: any = {
            type: protocol,
            tag,
            server: server.address,
            server_port: server.port,
          };

          if (protocol === 'vless') {
            outbound.uuid = server.uuid;
            if (server.flow) outbound.flow = server.flow;
            outbound.packet_encoding = 'xudp';
          }
          if (protocol === 'trojan') {
            outbound.password = server.password;
          }
          if (protocol === 'hysteria2') {
            outbound.password = server.password;
            if (server.hysteria2Settings?.upMbps) outbound.up_mbps = server.hysteria2Settings.upMbps;
            if (server.hysteria2Settings?.downMbps) outbound.down_mbps = server.hysteria2Settings.downMbps;
            if (server.hysteria2Settings?.obfs?.type && server.hysteria2Settings?.obfs?.password) {
              outbound.obfs = {
                type: server.hysteria2Settings.obfs.type,
                password: server.hysteria2Settings.obfs.password,
              };
            }
            if (server.hysteria2Settings?.network) outbound.network = server.hysteria2Settings.network;
          }

          // TLS / Reality
          if (server.security === 'reality' && server.realitySettings) {
            outbound.tls = {
              enabled: true,
              server_name: server.tlsSettings?.serverName || server.address,
              utls: { enabled: true, fingerprint: server.tlsSettings?.fingerprint || 'chrome' },
              reality: {
                enabled: true,
                public_key: server.realitySettings.publicKey,
                short_id: server.realitySettings.shortId || '',
              },
            };
          } else if (server.security === 'tls' || server.tlsSettings) {
            outbound.tls = {
              enabled: true,
              server_name: server.tlsSettings?.serverName || server.address,
              insecure: server.tlsSettings?.allowInsecure || false,
            };
            if (protocol !== 'hysteria2') {
              outbound.tls.utls = {
                enabled: true,
                fingerprint: server.tlsSettings?.fingerprint || 'chrome',
              };
            }
            if (server.tlsSettings?.alpn) outbound.tls.alpn = server.tlsSettings.alpn;
          }

          // 传输层 (WS/gRPC)
          const network = server.network?.toLowerCase();
          if (protocol !== 'hysteria2' && network && network !== 'tcp') {
            outbound.transport = { type: network };
            if (network === 'ws' && server.wsSettings) {
              outbound.transport.path = server.wsSettings.path || '/';
              if (server.wsSettings.headers) outbound.transport.headers = server.wsSettings.headers;
            }
            if (network === 'grpc' && server.grpcSettings) {
              outbound.transport.service_name = server.grpcSettings.serviceName || '';
            }
          }

          return outbound;
        };

        // 构建测试用的 sing-box 配置
        const servers = config.servers;
        const inbounds: any[] = [];
        const outbounds: any[] = [];
        const routeRules: any[] = [];
        const serverDomains: string[] = [];
        const serverIPs: string[] = [];

        servers.forEach((server, i) => {
          const outboundTag = `proxy-${i}`;
          const inboundTag = `speed-in-${i}`;

          inbounds.push({
            type: 'http',
            tag: inboundTag,
            listen: '127.0.0.1',
            listen_port: BASE_PORT + i,
          });

          outbounds.push(buildOutbound(server, outboundTag));

          routeRules.push({
            inbound: [inboundTag],
            outbound: outboundTag,
          });

          if (isIP(server.address)) {
            const cidr = isIP(server.address) === 6
              ? `${server.address}/128`
              : `${server.address}/32`;
            if (!serverIPs.includes(cidr)) serverIPs.push(cidr);
          } else {
            if (!serverDomains.includes(server.address)) {
              serverDomains.push(server.address);
            }
          }
        });

        outbounds.push({ type: 'direct', tag: 'direct' });
        outbounds.push({ type: 'block', tag: 'block' });

        if (serverDomains.length > 0) {
          routeRules.unshift({ domain: serverDomains, outbound: 'direct' });
        }
        if (serverIPs.length > 0) {
          routeRules.unshift({ ip_cidr: serverIPs, outbound: 'direct' });
        }

        const systemDnsServers = process.platform === 'linux' ? getSystemDnsServers() : [];
        for (const dnsIp of systemDnsServers) {
          const cidr = dnsIp.includes(':') ? `${dnsIp}/128` : `${dnsIp}/32`;
          routeRules.unshift({ ip_cidr: [cidr], outbound: 'direct' });
        }

        const dnsServers: any[] = systemDnsServers.length > 0
          ? systemDnsServers.map(ip => ({ tag: 'dns-local', type: 'udp', server: ip }))
          : [{ tag: 'dns-local', type: 'local' }];

        const dnsConfig: any = {
          servers: dnsServers,
          rules: [] as any[],
          final: 'dns-local',
        };
        if (serverDomains.length > 0) {
          dnsConfig.rules.push({ domain: serverDomains, server: 'dns-local' });
        }

        const testConfig = {
          log: { level: 'info', timestamp: true },
          dns: dnsConfig,
          inbounds,
          outbounds,
          route: {
            rules: routeRules,
            auto_detect_interface: true,
            default_domain_resolver: 'dns-local',
            final: 'direct',
          },
        };

        // 写入并记录配置摘要
        const { getUserDataPath } = require('./utils/paths');
        const userDataPath = getUserDataPath();
        const testConfigPath = path.join(userDataPath, 'speedtest_config.json');
        await fs.writeFile(testConfigPath, JSON.stringify(testConfig, null, 2));

        logManager.addLog('info', `Config: ${servers.length} inbounds, ${outbounds.length} outbounds, path=${testConfigPath}`, 'SpeedTest');

        // 验证配置
        const { execSync } = require('child_process');
        const singboxPath = resourceManager.getSingBoxPath();
        try {
          const checkResult = execSync(`"${singboxPath}" check -c "${testConfigPath}"`, {
            encoding: 'utf-8',
            timeout: 10000,
          });
          logManager.addLog('info', `Config check passed: ${checkResult.trim()}`, 'SpeedTest');
        } catch (e: any) {
          logManager.addLog('error', `Config check FAILED: ${e.stderr || e.message}`, 'SpeedTest');
          try { await fs.unlink(testConfigPath); } catch { /* ignore */ }
          if (trayManager) trayManager.updateSpeedTestResults(new Map(), config.servers);
          return;
        }

        // 启动测试用 sing-box 进程
        logManager.addLog('info', `Starting sing-box: "${singboxPath}" run -c "${testConfigPath}"`, 'SpeedTest');

        const testProc = spawn(singboxPath, ['run', '-c', testConfigPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        testProc.stdout?.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk.toString());
        });
        testProc.stderr?.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk.toString());
        });

        let processExited = false;
        let exitCode: number | null = null;
        testProc.on('exit', (code: number | null, signal: string | null) => {
          processExited = true;
          exitCode = code;
          logManager.addLog('info', `sing-box exited code=${code} signal=${signal}`, 'SpeedTest');
        });
        testProc.on('error', (err: Error) => {
          logManager.addLog('error', `sing-box spawn error: ${err.message}`, 'SpeedTest');
        });

        // 等待 sing-box 就绪
        const startupOk = await new Promise<boolean>((resolve) => {
          const startTime = Date.now();
          const check = () => {
            if (processExited) {
              logOutput('stdout', stdoutChunks);
              logOutput('stderr', stderrChunks);
              logManager.addLog('error', `sing-box exited before ready (code=${exitCode})`, 'SpeedTest');
              resolve(false);
              return;
            }
            if (Date.now() - startTime > SINGBOX_STARTUP_TIMEOUT) {
              logOutput('stdout', stdoutChunks);
              logOutput('stderr', stderrChunks);
              logManager.addLog('error', 'sing-box startup timeout', 'SpeedTest');
              resolve(false);
              return;
            }
            const sock = new (require('net').Socket)();
            sock.setTimeout(500);
            sock.on('connect', () => { sock.destroy(); resolve(true); });
            sock.on('error', () => { sock.destroy(); setTimeout(check, 500); });
            sock.on('timeout', () => { sock.destroy(); setTimeout(check, 500); });
            sock.connect(BASE_PORT, '127.0.0.1');
          };
          setTimeout(check, 1000);
        });

        if (!startupOk) {
          testProc.kill();
          try { await fs.unlink(testConfigPath); } catch { /* ignore */ }
          if (trayManager) trayManager.updateSpeedTestResults(new Map(), config.servers);
          return;
        }

        logOutput('stdout', stdoutChunks);
        logManager.addLog('info', 'sing-box started, running tests...', 'SpeedTest');

        // 发起测试请求（带预热，先发一个请求建立连接/DNS缓存，再测第二个）
        const testUrl = 'http://www.gstatic.com/generate_204';
        const results = new Map<string, number | null>();

        // 发送单个请求，返回 { ok, latency, statusCode, error }
        const doOneRequest = (port: number, timeout: number): Promise<{ ok: boolean; latency: number; statusCode?: number; error?: string }> => {
          return new Promise((resolve) => {
            const startTime = Date.now();
            const req = http.request(
              {
                hostname: '127.0.0.1',
                port,
                path: testUrl,
                method: 'GET',
                timeout,
                headers: { Host: 'www.gstatic.com', 'User-Agent': 'FlowZ-SpeedTest/1.0' },
              },
              (res: any) => {
                const latency = Date.now() - startTime;
                res.resume();
                res.on('end', () => resolve({ ok: true, latency, statusCode: res.statusCode }));
              }
            );
            req.on('error', (err: Error) => resolve({ ok: false, latency: Date.now() - startTime, error: err.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, latency: Date.now() - startTime, error: 'TIMEOUT' }); });
            req.end();
          });
        };

        const testOneServer = async (server: typeof servers[0], index: number): Promise<void> => {
          const port = BASE_PORT + index;
          const label = server.name || server.address;

          // 预热请求：建立 DNS 缓存和连接
          const warmResult = await doOneRequest(port, TEST_TIMEOUT);
          if (!warmResult.ok) {
            logManager.addLog('warn', `${label}: FAILED - ${warmResult.error}`, 'SpeedTest');
            results.set(server.id, null);
            return;
          }

          // 实测请求
          const measuredResult = await doOneRequest(port, TEST_TIMEOUT);
          if (measuredResult.ok) {
            logManager.addLog('info', `${label}: ${measuredResult.latency}ms (HTTP ${measuredResult.statusCode})`, 'SpeedTest');
            results.set(server.id, measuredResult.latency);
          } else {
            logManager.addLog('warn', `${label}: FAILED - ${measuredResult.error}`, 'SpeedTest');
            results.set(server.id, null);
          }
        };

        // 并发测试（每个服务器预热一次后实测）
        await Promise.all(servers.map((s, i) => testOneServer(s, i)));

        // 收集剩余输出
        logOutput('stdout', stdoutChunks);
        logOutput('stderr', stderrChunks);

        // 清理
        testProc.kill();
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => resolve(), 3000);
          testProc.on('close', () => { clearTimeout(t); resolve(); });
        });
        try { await fs.unlink(testConfigPath); } catch { /* ignore */ }

        logManager.addLog('info', 'Speed test completed for all servers', 'Main');
        if (trayManager) trayManager.updateSpeedTestResults(results, config.servers);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logManager.addLog('error', `Speed test failed: ${errorMessage}`, 'Main');
        if (trayManager) trayManager.updateSpeedTestResults(new Map(), []);
      }
    },
  });
  trayManager.createTray();

  // 初始化托盘菜单状态
  updateTrayMenuState(false);

  // 启动时自动连接（延迟 2 秒，等待窗口和服务初始化完成）
  setTimeout(async () => {
    try {
      const config = await configManager.loadConfig();
      // 检查是否启用了启动时自动连接
      if (config.autoConnect && config.selectedServerId) {
        logManager.addLog('info', '启动时自动连接已启用，正在连接...', 'Main');
        
        if (proxyManager) {
          await proxyManager.start(config);
          
          // 系统代理模式：设置系统代理
          const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();
          if (modeType === 'systemproxy') {
            await systemProxyManager.enableProxy(
              '127.0.0.1',
              config.httpPort || 65533,
              config.socksPort || 65534
            );
          }
          
          logManager.addLog('info', '启动时自动连接成功', 'Main');
          // 更新托盘菜单状态
          updateTrayMenuState(true);
        }
      } else if (config.autoConnect && !config.selectedServerId) {
        logManager.addLog('warn', '启动时自动连接已启用，但未选择服务器', 'Main');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('error', `启动时自动连接失败: ${errorMessage}`, 'Main');
      // 连接失败时更新托盘状态
      updateTrayMenuState(false, true);
    }
  }, 2000);

  // 启动后自动检查更新（延迟 5 秒，避免影响启动体验）
  setTimeout(async () => {
    try {
      const config = await configManager.loadConfig();
      // 检查是否启用了自动检查更新
      if (config.autoCheckUpdate !== false) {
        logManager.addLog('info', '正在自动检查更新...', 'Main');
        const result = await updateService.checkForUpdate();
        if (result.hasUpdate && result.updateInfo) {
          logManager.addLog('info', `发现新版本: ${result.updateInfo.version}`, 'Main');
          // 显示更新对话框
          const action = await updateService.showUpdateDialog(result.updateInfo);
          if (action === 'update') {
            // 使用带进度窗口的下载方法
            const filePath = await updateService.downloadUpdateWithProgress(result.updateInfo);
            if (filePath) {
              await updateService.installUpdate(filePath);
            }
          } else if (action === 'skip') {
            updateService.skipVersion(result.updateInfo.version);
          }
        } else if (result.error) {
          logManager.addLog('warn', `自动检查更新失败: ${result.error}`, 'Main');
        } else {
          logManager.addLog('info', '当前已是最新版本', 'Main');
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('warn', `自动检查更新时出错: ${errorMessage}`, 'Main');
    }
  }, 5000);

  // 监听配置变更事件，更新托盘菜单并自动重启代理
  mainEventEmitter.on(MAIN_EVENTS.CONFIG_CHANGED, async (_newConfig?: any) => {
    // 1. 更新托盘菜单
    const isRunning = proxyManager?.getStatus().running ?? false;
    updateTrayMenuState(isRunning);

    // 2. 如果代理正在运行，尝试热更新或重启以应用新配置
    if (isRunning && proxyManager) {
      // 加载最新配置（确保使用最新值）
      const latestConfig = await configManager.loadConfig();

      // 尝试热更新（仅服务器切换时不重启）
      if (proxyManager.canHotReload(latestConfig)) {
        logManager.addLog('info', 'Configuration changed, hot reloading...', 'Main');
        try {
          const success = await proxyManager.hotReloadConfig(latestConfig);
          if (success) {
            logManager.addLog('info', 'Proxy config hot reloaded successfully', 'Main');
            updateTrayMenuState(true);
            return;
          }
          logManager.addLog('warn', 'Hot reload failed, falling back to restart', 'Main');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logManager.addLog('warn', `Hot reload error: ${errorMessage}, falling back to restart`, 'Main');
        }
      }

      // 热更新不可用或失败，执行完整重启
      logManager.addLog('info', 'Configuration changed, restarting proxy...', 'Main');
      try {
        await proxyManager.restart(latestConfig);
        logManager.addLog('info', 'Proxy restarted successfully with new configuration', 'Main');

        // 重启后再次更新托盘（以防状态有变）
        updateTrayMenuState(true);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logManager.addLog('error', `Failed to restart proxy after config change: ${errorMessage}`, 'Main');
        // 重启失败，更新托盘状态为停止
        updateTrayMenuState(false, true);
      }
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // 在 macOS 上，即使所有窗口关闭，应用也应该继续运行（托盘模式）
  // 在其他平台上，如果启用了托盘，也应该继续运行
  if (process.platform !== 'darwin' && !trayManager) {
    app.quit();
  }
});

// 使用 will-quit 事件来清理资源
// 用标志位防止 app.exit() 再次触发 will-quit 导致无限循环
let isCleaningUp = false;
app.on('will-quit', async (_event) => {
  if (isCleaningUp) {
    // 已经在清理中（由 app.exit 再次触发），直接放行
    return;
  }

  isCleaningUp = true;
  _event.preventDefault();

  try {
    await cleanupResources();

    // 清理托盘图标
    if (trayManager) {
      trayManager.destroyTray();
      trayManager = null;
    }
  } catch (error) {
    console.error('Error during app quit:', error);
  }

  // 清理完成，退出应用
  app.exit(0);
});

// 处理 SIGINT 和 SIGTERM 信号
process.on('SIGINT', async () => {
  console.log('Received SIGINT, cleaning up...');
  await cleanupResources();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, cleaning up...');
  await cleanupResources();
  process.exit(0);
});
