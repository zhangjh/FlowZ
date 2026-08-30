import {
  Tray,
  Menu,
  nativeImage,
  BrowserWindow,
  app,
  MenuItemConstructorOptions,
  shell,
} from 'electron';
import { LogManager } from './LogManager';
import { ServerConfig, ServerGroup, ProxyMode } from '../../shared/types';

/**
 * 托盘图标状态
 */
export type TrayIconState = 'idle' | 'connected' | 'connecting';

/**
 * 托盘菜单数据
 */
export interface TrayMenuData {
  isProxyRunning: boolean;
  hasError?: boolean;
  servers: ServerConfig[];
  selectedServerId: string | null;
  groups: ServerGroup[];
  selectedGroupId: string | null;
  proxyMode: ProxyMode;
}

/**
 * 托盘管理器接口
 */
export interface ITrayManager {
  /**
   * 创建托盘图标
   */
  createTray(): void;

  /**
   * 销毁托盘图标
   */
  destroyTray(): void;

  /**
   * 更新托盘图标状态
   */
  updateTrayIcon(state: TrayIconState): void;

  /**
   * 更新托盘菜单
   */
  updateTrayMenu(isProxyRunning: boolean): void;

  /**
   * 更新完整托盘菜单（包含服务器列表和代理模式）
   */
  updateFullTrayMenu(data: TrayMenuData): void;
}

/**
 * 托盘管理器
 * 负责创建和管理系统托盘图标及其上下文菜单
 */
export class TrayManager implements ITrayManager {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow | null = null;
  private logManager: LogManager;
  private currentState: TrayIconState = 'idle';
  private isProxyRunning: boolean = false;
  private servers: ServerConfig[] = [];
  private selectedServerId: string | null = null;
  private groups: ServerGroup[] = [];
  private selectedGroupId: string | null = null;
  private proxyMode: ProxyMode = 'smart';

  // 回调函数
  private onStartProxy?: () => void;
  private onStopProxy?: () => void;
  private onShowWindow?: () => void;
  private onQuit?: () => void;
  private onSelectServer?: (serverId: string) => void;
  private onSelectGroup?: (groupId: string) => void;
  private onChangeProxyMode?: (mode: ProxyMode) => void;
  private onOpenSettings?: () => void;
  private onCheckUpdate?: () => void;
  private onManageServers?: () => void;
  private onSpeedTest?: () => void;

  // 测速结果
  private speedTestResults: Map<string, number | null> = new Map();
  private isSpeedTesting: boolean = false;

  constructor(
    mainWindow: BrowserWindow | null,
    logManager: LogManager,
    callbacks?: {
      onStartProxy?: () => void;
      onStopProxy?: () => void;
      onShowWindow?: () => void;
      onQuit?: () => void;
      onSelectServer?: (serverId: string) => void;
      onSelectGroup?: (groupId: string) => void;
      onChangeProxyMode?: (mode: ProxyMode) => void;
      onOpenSettings?: () => void;
      onCheckUpdate?: () => void;
      onManageServers?: () => void;
      onSpeedTest?: () => void;
    }
  ) {
    this.mainWindow = mainWindow;
    this.logManager = logManager;
    this.onStartProxy = callbacks?.onStartProxy;
    this.onStopProxy = callbacks?.onStopProxy;
    this.onShowWindow = callbacks?.onShowWindow;
    this.onQuit = callbacks?.onQuit;
    this.onSelectServer = callbacks?.onSelectServer;
    this.onSelectGroup = callbacks?.onSelectGroup;
    this.onChangeProxyMode = callbacks?.onChangeProxyMode;
    this.onOpenSettings = callbacks?.onOpenSettings;
    this.onCheckUpdate = callbacks?.onCheckUpdate;
    this.onManageServers = callbacks?.onManageServers;
    this.onSpeedTest = callbacks?.onSpeedTest;
  }

  /**
   * 设置主窗口引用
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * 创建托盘图标
   */
  createTray(): void {
    if (this.tray) {
      this.logManager.addLog('warn', 'Tray already exists', 'TrayManager');
      return;
    }

    try {
      const icon = this.loadTrayIcon('idle');

      this.tray = new Tray(icon);
      this.tray.setToolTip('FlowZ');

      // 设置托盘图标点击事件
      this.tray.on('click', () => {
        this.handleTrayClick();
      });

      // 创建上下文菜单
      this.updateTrayMenu(false);

      this.logManager.addLog('info', 'Tray icon created', 'TrayManager');
    } catch (error) {
      this.logManager.addLog(
        'error',
        `Failed to create tray icon: ${error instanceof Error ? error.message : String(error)}`,
        'TrayManager'
      );
    }
  }

  /**
   * 销毁托盘图标
   */
  destroyTray(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
      this.logManager.addLog('info', 'Tray icon destroyed', 'TrayManager');
    }
  }

  /**
   * 更新托盘图标状态
   */
  updateTrayIcon(state: TrayIconState): void {
    if (!this.tray) {
      this.logManager.addLog('warn', 'Cannot update tray icon: tray not created', 'TrayManager');
      return;
    }

    try {
      this.currentState = state;
      const icon = this.loadTrayIcon(state);

      this.tray.setImage(icon);

      if (state !== 'connected') {
        this.speedTestResults.clear();
      }

      this.updateTrayTooltip();

      this.logManager.addLog('info', `Tray icon updated to state: ${state}`, 'TrayManager');
    } catch (error) {
      this.logManager.addLog(
        'error',
        `Failed to update tray icon: ${error instanceof Error ? error.message : String(error)}`,
        'TrayManager'
      );
    }
  }

  /**
   * 更新托盘菜单（简化版，保持向后兼容）
   */
  updateTrayMenu(isProxyRunning: boolean): void {
    this.updateFullTrayMenu({
      isProxyRunning,
      servers: this.servers,
      selectedServerId: this.selectedServerId,
      groups: this.groups,
      selectedGroupId: this.selectedGroupId,
      proxyMode: this.proxyMode,
    });
  }

  /**
   * 更新完整托盘菜单（包含服务器列表和代理模式）
   */
  updateFullTrayMenu(data: TrayMenuData): void {
    if (!this.tray) {
      this.logManager.addLog('warn', 'Cannot update tray menu: tray not created', 'TrayManager');
      return;
    }

    this.isProxyRunning = data.isProxyRunning;
    this.servers = data.servers;
    this.selectedServerId = data.selectedServerId;
    this.groups = data.groups || [];
    this.selectedGroupId = data.selectedGroupId || null;
    this.proxyMode = data.proxyMode;

    // 状态显示：使用 emoji 区分不同状态
    // 🔵 蓝色 = 已连接，⚪ 灰色 = 已断开，🔴 红色 = 连接异常
    let statusLabel: string;
    if (data.hasError) {
      statusLabel = '🔴 连接异常';
    } else if (data.isProxyRunning) {
      statusLabel = '🔵 已连接';
    } else {
      statusLabel = '⚪ 已断开';
    }

    // 构建服务器子菜单：与首页出站列表保持一致，
    // 只展示「分组 + 未分组节点」，分组内的节点由分组统一管理，不再单独列出。
    const serverSubmenu: MenuItemConstructorOptions[] = [];
    const maxLabelLength = 30;

    // 已归入任何分组的节点 ID
    const groupedIds = new Set<string>();
    for (const group of this.groups) {
      for (const id of group.serverIds || []) groupedIds.add(id);
    }
    const ungroupedServers = data.servers.filter((s) => !groupedIds.has(s.id));

    // 分组出口（urltest 故障转移）
    if (this.groups.length > 0) {
      this.groups.forEach((group) => {
        const memberCount = (group.serverIds || []).filter((id) =>
          this.servers.some((s) => s.id === id)
        ).length;
        let label = `${group.name}（分组·${memberCount}节点）`;
        if (label.length > maxLabelLength) {
          label = label.substring(0, maxLabelLength - 3) + '...';
        }
        serverSubmenu.push({
          label,
          type: 'radio' as const,
          checked: group.id === this.selectedGroupId,
          click: () => this.handleSelectGroup(group.id),
        });
      });
      serverSubmenu.push({ type: 'separator' });
    }

    if (ungroupedServers.length > 0) {
      ungroupedServers.forEach((server) => {
        const name = server.name || server.address;
        const protocol = (server.protocol || '').toUpperCase();
        const latency = this.speedTestResults.get(server.id);
        const latencyStr = latency !== undefined
          ? (latency !== null ? ` [${latency}ms]` : ' [超时]')
          : '';
        let label = `${name}（${protocol}）${latencyStr}`;

        if (label.length > maxLabelLength) {
          label = label.substring(0, maxLabelLength - 3) + '...';
        }

        serverSubmenu.push({
          label,
          type: 'radio' as const,
          checked: server.id === data.selectedServerId,
          click: () => this.handleSelectServer(server.id),
        });
      });
      serverSubmenu.push({ type: 'separator' });
    } else if (this.groups.length === 0) {
      serverSubmenu.push({ label: '未配置服务器', enabled: false });
      serverSubmenu.push({ type: 'separator' });
    }

    // 添加"管理服务器"选项
    serverSubmenu.push({
      label: '管理服务器',
      click: () => this.handleManageServers(),
    });

    // 代理模式标签映射
    const proxyModeLabels: Record<ProxyMode, string> = {
      global: '全局代理',
      smart: '智能分流',
      direct: '直连模式',
    };

    // 构建代理模式子菜单
    const proxyModeSubmenu: MenuItemConstructorOptions[] = (
      ['global', 'smart', 'direct'] as ProxyMode[]
    ).map((mode) => ({
      label: proxyModeLabels[mode],
      type: 'radio' as const,
      checked: data.proxyMode === mode,
      click: () => this.handleChangeProxyMode(mode),
    }));

    const contextMenu = Menu.buildFromTemplate([
      {
        label: statusLabel,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: data.isProxyRunning ? '禁用代理' : '启用代理',
        click: () => {
          if (data.isProxyRunning) {
            this.handleStopProxy();
          } else {
            this.handleStartProxy();
          }
        },
      },
      { type: 'separator' },
      {
        label: '选择服务器',
        submenu: serverSubmenu,
      },
      {
        label: '代理模式',
        submenu: proxyModeSubmenu,
      },
      { type: 'separator' },
      {
        label: '打开主窗口',
        click: () => this.handleShowWindow(),
      },
      {
        label: '打开设置',
        click: () => this.handleOpenSettings(),
      },
      {
        label: '检查更新',
        click: () => this.handleCheckUpdate(),
      },
      { type: 'separator' },
      {
        label: this.getSpeedTestLabel(),
        enabled: !this.isSpeedTesting,
        click: () => this.handleSpeedTest(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => this.handleQuit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
    this.logManager.addLog('debug', 'Tray menu updated', 'TrayManager');
  }

  /**
   * 加载托盘图标
   * 如果图标文件不存在，使用内置的默认图标
   */
  private loadTrayIcon(state: TrayIconState): Electron.NativeImage {
    const { resourceManager } = require('./ResourceManager');
    const iconPath = resourceManager.getTrayIconPath(state === 'connected');

    // 检查图标文件是否存在
    const fs = require('fs');
    let icon: Electron.NativeImage;

    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
      this.logManager.addLog('debug', `Loaded tray icon from: ${iconPath}`, 'TrayManager');

      // macOS 托盘图标需要调整大小为 22x22（或 16x16）
      // 高 DPI 屏幕会自动使用 @2x 版本
      if (process.platform === 'darwin') {
        icon = icon.resize({ width: 18, height: 18 });
      }
    } else {
      // 图标文件不存在，创建一个简单的默认图标
      this.logManager.addLog(
        'warn',
        `Tray icon not found: ${iconPath}, using default`,
        'TrayManager'
      );
      icon = this.createDefaultTrayIcon();
    }

    return icon;
  }

  /**
   * 创建默认托盘图标（当图标文件不存在时使用）
   */
  private createDefaultTrayIcon(): Electron.NativeImage {
    // 创建一个 22x22 的简单图标（V 字形状）
    const size = 22;
    const canvas = `
      <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="transparent"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" 
              font-family="Arial" font-size="16" font-weight="bold" fill="black">V</text>
      </svg>
    `;
    return nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(canvas).toString('base64')}`
    );
  }

  /**
   * 处理托盘图标点击事件
   */
  private handleTrayClick(): void {
    this.logManager.addLog('info', 'Tray icon clicked', 'TrayManager');
    this.handleShowWindow();
  }

  /**
   * 处理启动代理
   */
  private handleStartProxy(): void {
    this.logManager.addLog('info', 'Start proxy clicked from tray', 'TrayManager');
    if (this.onStartProxy) {
      this.onStartProxy();
    }
  }

  /**
   * 处理停止代理
   */
  private handleStopProxy(): void {
    this.logManager.addLog('info', 'Stop proxy clicked from tray', 'TrayManager');
    if (this.onStopProxy) {
      this.onStopProxy();
    }
  }

  /**
   * 处理显示窗口
   */
  private handleShowWindow(): void {
    this.logManager.addLog('info', 'Show window clicked from tray', 'TrayManager');
    if (this.onShowWindow) {
      this.onShowWindow();
    } else if (this.mainWindow) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  /**
   * 处理退出应用
   */
  private handleQuit(): void {
    this.logManager.addLog('info', 'Quit clicked from tray', 'TrayManager');
    if (this.onQuit) {
      this.onQuit();
    } else {
      app.quit();
    }
  }

  /**
   * 处理选择服务器
   */
  private handleSelectServer(serverId: string): void {
    this.logManager.addLog('info', `Server selected from tray: ${serverId}`, 'TrayManager');
    if (this.onSelectServer) {
      this.onSelectServer(serverId);
    }
  }

  /**
   * 处理选择分组
   */
  private handleSelectGroup(groupId: string): void {
    this.logManager.addLog('info', `Group selected from tray: ${groupId}`, 'TrayManager');
    if (this.onSelectGroup) {
      this.onSelectGroup(groupId);
    }
  }

  /**
   * 处理切换代理模式
   */
  private handleChangeProxyMode(mode: ProxyMode): void {
    this.logManager.addLog('info', `Proxy mode changed from tray: ${mode}`, 'TrayManager');
    if (this.onChangeProxyMode) {
      this.onChangeProxyMode(mode);
    }
  }

  /**
   * 处理打开设置
   */
  private handleOpenSettings(): void {
    this.logManager.addLog('info', 'Open settings clicked from tray', 'TrayManager');
    if (this.onOpenSettings) {
      this.onOpenSettings();
    } else {
      // 默认行为：显示窗口并导航到设置页面
      this.handleShowWindow();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('navigate', '/settings');
      }
    }
  }

  /**
   * 处理检查更新
   */
  private handleCheckUpdate(): void {
    this.logManager.addLog('info', 'Check update clicked from tray', 'TrayManager');
    if (this.onCheckUpdate) {
      this.onCheckUpdate();
    } else {
      // 默认行为：打开 GitHub releases 页面
      shell.openExternal('https://github.com/zhangjh/FlowZ/releases');
    }
  }

  /**
   * 处理管理服务器
   */
  private handleManageServers(): void {
    this.logManager.addLog('info', 'Manage servers clicked from tray', 'TrayManager');
    if (this.onManageServers) {
      this.onManageServers();
    } else {
      // 默认行为：显示窗口并导航到服务器页面
      this.handleShowWindow();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('navigate', '/server');
      }
    }
  }

  /**
   * 处理测速
   */
  private handleSpeedTest(): void {
    this.logManager.addLog('info', 'Speed test clicked from tray', 'TrayManager');
    if (this.onSpeedTest) {
      this.isSpeedTesting = true;
      this.updateTrayMenu(this.isProxyRunning);
      this.onSpeedTest();
    }
  }

  /**
   * 获取测速菜单项标签
   */
  private getSpeedTestLabel(): string {
    if (this.isSpeedTesting) {
      return '测速中...';
    }
    return '服务器测速';
  }

  /**
   * 更新测速结果
   */
  updateSpeedTestResults(results: Map<string, number | null>, servers: ServerConfig[]): void {
    this.speedTestResults = results;
    this.isSpeedTesting = false;
    this.updateTrayMenu(this.isProxyRunning);

    const resultList = servers
      .map(s => ({
        name: s.name || s.address,
        protocol: (s.protocol || '').toUpperCase(),
        latency: results.get(s.id) ?? null,
      }))
      .sort((a, b) => {
        if (a.latency === null) return 1;
        if (b.latency === null) return -1;
        return a.latency - b.latency;
      });

    // 发送到渲染进程显示 toast
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('speedTestResult', resultList);
    }
  }

  /**
   * 更新托盘 tooltip
   */
  private updateTrayTooltip(): void {
    if (!this.tray) return;

    const tooltips: Record<TrayIconState, string> = {
      idle: 'FlowZ - 未连接',
      connecting: 'FlowZ - 连接中...',
      connected: 'FlowZ - 已连接',
    };

    let tooltip = tooltips[this.currentState];

    this.tray.setToolTip(tooltip);
  }

  /**
   * 获取托盘是否已创建（用于测试）
   */
  isTrayCreated(): boolean {
    return this.tray !== null;
  }

  /**
   * 获取当前代理运行状态（用于测试）
   */
  getProxyRunningState(): boolean {
    return this.isProxyRunning;
  }

  /**
   * 获取当前图标状态（用于测试）
   */
  getCurrentIconState(): TrayIconState {
    return this.currentState;
  }

  /**
   * 获取当前选中的服务器ID（用于测试）
   */
  getSelectedServerId(): string | null {
    return this.selectedServerId;
  }

  /**
   * 获取当前代理模式（用于测试）
   */
  getProxyMode(): ProxyMode {
    return this.proxyMode;
  }
}
