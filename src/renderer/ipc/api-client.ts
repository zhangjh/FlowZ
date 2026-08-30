/**
 * API 客户端
 * 封装所有 IPC 调用方法，提供类型安全的 API 接口
 */

import { ipcClient } from './ipc-client';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  UserConfig,
  ServerConfig,
  ProxyStatus,
  SystemProxyStatus,
  LogEntry,
  TrafficStats,
  DomainRule,
  AutoStartStatus,
  ConnectionStateInfo,
  AutoSelectStatus,
  ServerSpeedResult,
} from '../../shared/types';

/**
 * 代理控制 API
 */
export const proxyApi = {
  /**
   * 启动代理
   * @param config 用户配置
   */
  async start(config: UserConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_START, config);
  },

  /**
   * 停止代理
   */
  async stop(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_STOP);
  },

  /**
   * 重启代理
   */
  async restart(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_RESTART);
  },

  /**
   * 获取代理状态
   */
  async getStatus(): Promise<ProxyStatus> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_GET_STATUS);
  },

  /**
   * 监听代理启动事件
   */
  onStarted(listener: (data: { pid: number; timestamp: string }) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_STARTED, listener);
  },

  /**
   * 监听代理停止事件
   */
  onStopped(listener: (data: { timestamp: string }) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_STOPPED, listener);
  },

  /**
   * 监听代理错误事件
   */
  onError(listener: (data: { error: string; timestamp: string }) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_ERROR, listener);
  },

  /**
   * 监听自动连接事件（主进程请求渲染进程执行代理启动）
   */
  onAutoConnect(listener: () => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_AUTO_CONNECT, listener);
  },

  /**
   * 监听代理重启事件（主进程正在重启代理）
   */
  onProxyRestarting(listener: () => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_RESTARTING, listener);
  },
};

/**
 * 配置管理 API
 */
export const configApi = {
  /**
   * 获取完整配置
   */
  async get(): Promise<UserConfig> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_GET);
  },

  /**
   * 保存完整配置
   */
  async save(config: UserConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_SAVE, config);
  },

  /**
   * 更新代理模式
   */
  async updateMode(mode: UserConfig['proxyMode']): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_UPDATE_MODE, { mode });
  },

  /**
   * 获取配置值
   */
  async getValue<T = any>(key: string): Promise<T> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_GET_VALUE, { key });
  },

  /**
   * 设置配置值
   */
  async setValue(key: string, value: any): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_SET_VALUE, { key, value });
  },

  /**
   * 监听配置变化事件
   */
  onChanged(
    listener: (data: { key?: string; oldValue?: any; newValue?: any }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_CONFIG_CHANGED, listener);
  },
};

/**
 * 服务器管理 API
 */
export const serverApi = {
  /**
   * 获取所有服务器
   */
  async getAll(): Promise<ServerConfig[]> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_GET_ALL);
  },

  /**
   * 添加服务器
   */
  async add(server: Omit<ServerConfig, 'id'>): Promise<ServerConfig> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_ADD, server);
  },

  /**
   * 更新服务器
   */
  async update(server: ServerConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_UPDATE, server);
  },

  /**
   * 删除服务器
   */
  async delete(serverId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_DELETE, { serverId });
  },

  /**
   * 切换服务器
   */
  async switch(serverId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_SWITCH, { serverId });
  },

  /**
   * 解析协议 URL
   */
  async parseUrl(url: string): Promise<Omit<ServerConfig, 'id'>> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_PARSE_URL, { url });
  },

  /**
   * 从 URL 添加服务器
   */
  async addFromUrl(url: string, name?: string): Promise<ServerConfig> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_ADD_FROM_URL, { url, name });
  },

  /**
   * 生成分享 URL
   */
  async generateUrl(server: ServerConfig): Promise<string> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_GENERATE_URL, { server });
  },

  /**
   * 解析订阅内容（多行协议链接 或 订阅 URL），返回解析出的服务器（不保存）
   */
  async parseSubscription(input: { content?: string; url?: string }): Promise<ServerConfig[]> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_PARSE_SUBSCRIPTION, input);
  },

  /**
   * 从订阅批量添加服务器到配置（自动归为一个分组，启用组内故障转移）
   * 传入 servers 时复用调用方已解析的服务器，避免二次拉取/解析
   */
  async addSubscription(input: {
    servers?: ServerConfig[];
    content?: string;
    url?: string;
    groupName?: string;
  }): Promise<{ servers: ServerConfig[]; group: import('../../shared/types').ServerGroup }> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_ADD_SUBSCRIPTION, input);
  },
};

/**
 * 分组管理 API
 */
export const groupApi = {
  async getAll(): Promise<import('../../shared/types').ServerGroup[]> {
    return ipcClient.invoke(IPC_CHANNELS.GROUP_GET_ALL);
  },
  async create(input: {
    name: string;
    serverIds?: string[];
  }): Promise<import('../../shared/types').ServerGroup> {
    return ipcClient.invoke(IPC_CHANNELS.GROUP_CREATE, input);
  },
  async update(input: {
    groupId: string;
    name?: string;
    addServerIds?: string[];
    removeServerIds?: string[];
  }): Promise<import('../../shared/types').ServerGroup> {
    return ipcClient.invoke(IPC_CHANNELS.GROUP_UPDATE, input);
  },
  async moveServer(input: { serverId: string; targetGroupId: string }): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.GROUP_MOVE_SERVER, input);
  },
  async delete(groupId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.GROUP_DELETE, { groupId });
  },
  async generateShareUrl(groupId: string): Promise<string> {
    return ipcClient.invoke(IPC_CHANNELS.GROUP_SHARE, { groupId });
  },
  async select(groupId: string | null): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.GROUP_SELECT, { groupId });
  },
  async addServers(input: { serverIds: string[]; groupId: string }): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.GROUP_ADD_SERVERS, input);
  },
};

/**
 * 路由规则管理 API
 */
export const rulesApi = {
  /**
   * 获取所有规则
   */
  async getAll(): Promise<DomainRule[]> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_GET_ALL);
  },

  /**
   * 添加规则
   */
  async add(rule: Omit<DomainRule, 'id'>): Promise<DomainRule> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_ADD, rule);
  },

  /**
   * 更新规则
   */
  async update(rule: DomainRule): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_UPDATE, rule);
  },

  /**
   * 删除规则
   */
  async delete(ruleId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_DELETE, { ruleId });
  },
};

/**
 * 日志管理 API
 */
export const logsApi = {
  /**
   * 获取日志
   */
  async get(limit?: number): Promise<LogEntry[]> {
    return ipcClient.invoke(IPC_CHANNELS.LOGS_GET, { limit });
  },

  /**
   * 清空日志
   */
  async clear(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.LOGS_CLEAR);
  },

  /**
   * 设置日志级别
   */
  async setLevel(level: LogEntry['level']): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.LOGS_SET_LEVEL, { level });
  },

  /**
   * 打开日志文件夹
   */
  async openFolder(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.LOGS_OPEN_FOLDER);
  },

  /**
   * 监听日志接收事件
   */
  onReceived(listener: (log: LogEntry) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_LOG_RECEIVED, listener);
  },
};

/**
 * 系统代理管理 API
 */
export const systemProxyApi = {
  /**
   * 启用系统代理
   */
  async enable(address: string, port: number): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SYSTEM_PROXY_ENABLE, { address, port });
  },

  /**
   * 禁用系统代理
   */
  async disable(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SYSTEM_PROXY_DISABLE);
  },

  /**
   * 获取系统代理状态
   */
  async getStatus(): Promise<SystemProxyStatus> {
    return ipcClient.invoke(IPC_CHANNELS.SYSTEM_PROXY_GET_STATUS);
  },
};

/**
 * 自启动管理 API
 */
export const autoStartApi = {
  /**
   * 设置自启动
   */
  async set(enabled: boolean): Promise<boolean> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_START_SET, { enabled });
  },

  /**
   * 获取自启动状态
   */
  async getStatus(): Promise<AutoStartStatus> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_START_GET_STATUS);
  },
};

/**
 * 统计信息 API
 */
export const statsApi = {
  /**
   * 获取流量统计
   */
  async get(): Promise<TrafficStats> {
    return ipcClient.invoke(IPC_CHANNELS.STATS_GET);
  },

  /**
   * 重置流量统计
   */
  async reset(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.STATS_RESET);
  },

  /**
   * 监听统计更新事件
   */
  onUpdated(listener: (stats: TrafficStats) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_STATS_UPDATED, listener);
  },
};

/**
 * 连接状态 API
 */
export const connectionApi = {
  /**
   * 监听连接状态变化事件
   */
  onStateChanged(listener: (state: ConnectionStateInfo) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_CONNECTION_STATE_CHANGED, listener);
  },
};

/**
 * 版本信息类型
 */
export interface VersionInfo {
  appVersion: string;
  appName: string;
  buildDate: string;
  singBoxVersion: string;
  copyright: string;
  repositoryUrl: string;
}

/**
 * 版本信息 API
 */
export const versionApi = {
  /**
   * 获取版本信息
   */
  async getInfo(): Promise<VersionInfo> {
    return ipcClient.invoke(IPC_CHANNELS.VERSION_GET_INFO);
  },
};

/**
 * 管理员权限检查结果
 */
export interface AdminCheckResult {
  isAdmin: boolean;
  platform: NodeJS.Platform;
  needsElevationForTun: boolean;
}

/**
 * 管理员权限 API
 */
export const adminApi = {
  /**
   * 检查管理员权限状态
   */
  async check(): Promise<AdminCheckResult> {
    return ipcClient.invoke(IPC_CHANNELS.ADMIN_CHECK);
  },
};

/**
 * 更新检查结果
 */
export interface UpdateCheckResult {
  hasUpdate: boolean;
  updateInfo?: UpdateInfo;
  error?: string;
}

/**
 * 更新信息
 */
export interface UpdateInfo {
  version: string;
  title: string;
  releaseNotes: string;
  downloadUrl: string;
  fileSize: number;
  publishedAt: string;
  isPrerelease: boolean;
  fileName: string;
}

/**
 * 更新进度
 */
export interface UpdateProgress {
  status:
    | 'idle'
    | 'checking'
    | 'no-update'
    | 'update-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  percentage: number;
  message: string;
  error?: string;
}

/**
 * 更新管理 API
 */
export const updateApi = {
  /**
   * 检查更新
   */
  async check(includePrerelease = false): Promise<UpdateCheckResult> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_CHECK, { includePrerelease });
  },

  /**
   * 下载更新
   */
  async download(
    updateInfo: UpdateInfo
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD, { updateInfo });
  },

  /**
   * 安装更新
   */
  async install(filePath: string): Promise<{ success: boolean; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_INSTALL, { filePath });
  },

  /**
   * 跳过版本
   */
  async skip(version: string): Promise<{ success: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_SKIP, { version });
  },

  /**
   * 打开 Releases 页面
   */
  async openReleases(): Promise<{ success: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_OPEN_RELEASES);
  },

  /**
   * 监听更新进度事件
   */
  onProgress(listener: (progress: UpdateProgress) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_UPDATE_PROGRESS, listener);
  },
};

/**
 * 自动选择 API
 */
export const autoSelectApi = {
  /**
   * 获取自动选择状态
   */
  async getStatus(): Promise<AutoSelectStatus> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_SELECT_GET_STATUS);
  },

  /**
   * 测试服务器速度
   */
  async testServers(serverIds?: string[]): Promise<ServerSpeedResult[]> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_SELECT_TEST_SERVERS, { serverIds });
  },

  /**
   * 获取最佳服务器
   */
  async getBestServer(): Promise<ServerConfig | null> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_SELECT_GET_BEST_SERVER);
  },

  /**
   * 立即触发故障转移（检测到请求失败时调用）
   */
  async triggerFailover(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_SELECT_TRIGGER_FAILOVER);
  },

  /**
   * 监听故障转移事件
   */
  onFailover(
    listener: (data: {
      from: string;
      to: string;
      server: ServerConfig;
      latency: number;
      failoverCount: number;
    }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_AUTO_SELECT_FAILOVER, listener);
  },

  /**
   * 监听测试完成事件
   */
  onTestCompleted(listener: (results: ServerSpeedResult[]) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_AUTO_SELECT_TEST_COMPLETED, listener);
  },
};

/**
 * 统一的 API 客户端
 */
export const api = {
  proxy: proxyApi,
  config: configApi,
  server: serverApi,
  group: groupApi,
  rules: rulesApi,
  logs: logsApi,
  systemProxy: systemProxyApi,
  autoStart: autoStartApi,
  stats: statsApi,
  connection: connectionApi,
  version: versionApi,
  admin: adminApi,
  update: updateApi,
  autoSelect: autoSelectApi,
};

/**
 * 默认导出
 */
export default api;
