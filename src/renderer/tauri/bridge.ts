/**
 * Tauri bridge — phase 3.
 *
 * Tauri 前端 API：proxy/config/server/… namespace，
 * 底层走 `invoke` / `listen`。
 *
 * 已移植：proxy（start/stop/restart/getStatus + 事件）、config（get/save/
 * updateMode/getValue/setValue）、server（parseUrl/generateUrl/
 * parseSubscription/纯配置类 CRUD）、group（纯配置类 CRUD + 分享）、
 * rules（纯配置类 CRUD）、version.getInfo。
 * 其余：invoke 类抛 honest 错误；事件订阅类 warn + 空卸载（避免 App 挂载时崩）。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Listener<T> = (data: T) => void;
type Unsubscribe = () => void;

const notPorted =
  (ns: string, method: string) =>
  (..._args: unknown[]): Promise<never> =>
    Promise.reject(
      new Error(`[tauri bridge] ${ns}.${method} not ported yet`)
    );

const noopListener =
  (ns: string, method: string) =>
  (..._args: unknown[]): Unsubscribe => {
    console.warn(`[tauri bridge] ${ns}.${method} not ported yet — listener ignored`);
    return () => {};
  };

function onEvent<T>(channel: string, listener: Listener<T>): Unsubscribe {
  let unlisten: Unsubscribe | undefined;
  listen<T>(channel, (event) => listener(event.payload)).then((u) => {
    unlisten = u;
  });
  return () => {
    unlisten?.();
  };
}

// ---------------------------------------------------------------------------
// proxy（Rust: proxy.rs）
// ---------------------------------------------------------------------------
const proxyApi = {
  start: (config?: unknown): Promise<void> => invoke('proxy_start', { config: config ?? null }),
  stop: (): Promise<void> => invoke('proxy_stop'),
  restart: (config?: unknown): Promise<void> => invoke('proxy_restart', { config: config ?? null }),
  getStatus: (): Promise<unknown> => invoke('proxy_get_status'),
  onStarted: (listener: Listener<{ pid: number; timestamp: string }>): Unsubscribe =>
    onEvent('event:proxyStarted', listener),
  onStopped: (listener: Listener<{ timestamp: string }>): Unsubscribe =>
    onEvent('event:proxyStopped', listener),
  onError: (listener: Listener<{ error: string; timestamp: string }>): Unsubscribe =>
    onEvent('event:proxyError', listener),
  onAutoConnect: noopListener('proxy', 'onAutoConnect'),
  onProxyRestarting: (listener: Listener<Record<string, never>>): Unsubscribe =>
    onEvent('event:proxyRestarting', listener),
};

// ---------------------------------------------------------------------------
// config（Rust: config.rs；updateMode/getValue/setValue 走 get+save 组合）
// ---------------------------------------------------------------------------
const appEventsApi = {
  onNavigate: (listener: Listener<{ page: string }>): Unsubscribe =>
    onEvent('event:navigate', listener),
  onUpdateCheckResult: (listener: Listener<unknown>): Unsubscribe =>
    onEvent('event:updateCheckResult', listener),
  getPendingTrayAction: (): Promise<string | null> =>
    invoke('get_pending_tray_action'),
  getPendingUpdateResult: (): Promise<unknown | null> =>
    invoke('get_pending_update_result'),
  getTraySpeedtestResults: (): Promise<Array<[string, number | null]>> =>
    invoke('get_tray_speedtest_results'),
  getTraySpeedtestVersion: (): Promise<number> =>
    invoke('get_tray_speedtest_version'),
};

const configApi = {
  get: (): Promise<any> => invoke('get_config'),
  save: (config: unknown): Promise<void> => invoke('save_config', { config }),
  updateMode: async (mode: string): Promise<void> => {
    const cfg = await configApi.get();
    cfg.proxyMode = mode;
    await configApi.save(cfg);
  },
  getValue: async <T = any>(key: string): Promise<T> => {
    const cfg = await configApi.get();
    return cfg[key];
  },
  setValue: async (key: string, value: any): Promise<void> => {
    const cfg = await configApi.get();
    cfg[key] = value;
    await configApi.save(cfg);
  },
  onChanged: (listener: Listener<{ key?: string; oldValue?: any; newValue?: any }>): Unsubscribe =>
    // Rust 侧暂不发射 configChanged，接线真实，事件后续补
    onEvent('event:configChanged', listener),
};

// ---------------------------------------------------------------------------
// server（解析走 Rust；纯配置类 CRUD 走 config get/save）
// ---------------------------------------------------------------------------
const serverApi = {
  getAll: async (): Promise<any[]> => (await configApi.get()).servers ?? [],
  add: async (server: any): Promise<any> => {
    const cfg = await configApi.get();
    const created = { ...server, id: crypto.randomUUID() };
    cfg.servers.push(created);
    await configApi.save(cfg);
    return created;
  },
  update: async (server: any): Promise<void> => {
    const cfg = await configApi.get();
    const i = cfg.servers.findIndex((s: any) => s.id === server.id);
    if (i < 0) throw new Error(`[tauri bridge] server.update: not found ${server.id}`);
    cfg.servers[i] = server;
    await configApi.save(cfg);
  },
  delete: async (serverId: string): Promise<void> => {
    const cfg = await configApi.get();
    cfg.servers = cfg.servers.filter((s: any) => s.id !== serverId);
    if (cfg.selectedServerId === serverId) cfg.selectedServerId = null;
    await configApi.save(cfg);
  },
  switch: async (serverId: string): Promise<void> => {
    const cfg = await configApi.get();
    cfg.selectedServerId = serverId;
    cfg.selectedGroupId = null;
    // save_config 现在内置了热切换 / 重启逻辑（对齐 Electron 的 CONFIG_CHANGED 处理），
    // 不再需要在这里显式调用 proxyApi.restart，否则会导致双重重启或代理未运行时被意外启动
    await configApi.save(cfg);
  },
  parseUrl: (url: string): Promise<any> => invoke('parse_protocol_url', { url }),
  addFromUrl: async (url: string, name?: string): Promise<any> => {
    const parsed = await serverApi.parseUrl(url);
    if (name) parsed.name = name;
    return serverApi.add(parsed);
  },
  generateUrl: (server: unknown): Promise<string> => invoke('generate_share_url', { server }),
  parseSubscription: (input: { content?: string; url?: string }): Promise<any[]> =>
    invoke('parse_subscription', { payload: input }),
  addSubscription: notPorted('server', 'addSubscription'),
};

// ---------------------------------------------------------------------------
// rules（纯配置类 CRUD 走 config get/save，语义对齐 Electron rules-handlers.ts）
// ---------------------------------------------------------------------------
const rulesApi = {
  getAll: async (): Promise<any[]> => (await configApi.get()).customRules ?? [],
  add: async (rule: any): Promise<any> => {
    const cfg = await configApi.get();
    const created = {
      ...rule,
      id: rule.id || `rule_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    };
    if (!cfg.customRules) cfg.customRules = [];
    // 追加到末尾：列表顺序即匹配优先级（自定义规则整体早于智能分流规则）
    cfg.customRules.push(created);
    await configApi.save(cfg);
    return created;
  },
  update: async (rule: any): Promise<void> => {
    const cfg = await configApi.get();
    if (!cfg.customRules) throw new Error('[tauri bridge] rules.update: no rules found');
    const i = cfg.customRules.findIndex((r: any) => r.id === rule.id);
    if (i < 0) throw new Error(`[tauri bridge] rules.update: rule not found: ${rule.id}`);
    cfg.customRules[i] = rule;
    await configApi.save(cfg);
  },
  delete: async (ruleId: string): Promise<void> => {
    const cfg = await configApi.get();
    cfg.customRules = (cfg.customRules ?? []).filter((r: any) => r.id !== ruleId);
    await configApi.save(cfg);
  },
};

// ---------------------------------------------------------------------------
// group（纯配置类 CRUD 走 config get/save，语义对齐 Electron server-handlers.ts）
// ---------------------------------------------------------------------------

/** 生成服务器去重特征键（用于订阅刷新时判断同一节点） */
function buildServerKey(server: any): string {
  return [
    server.protocol?.toLowerCase(),
    server.address,
    server.port,
    server.uuid || '',
    server.password || '',
    server.flow || '',
    server.network || '',
    server.wsSettings?.path || '',
    server.grpcSettings?.serviceName || '',
    server.tlsSettings?.serverName || '',
  ].join('|');
}

/**
 * 将服务器加入指定分组（作为手动成员）。
 * 一个节点只能属于一个分组：会从其它分组移除其成员身份。
 */
function addServerToGroup(cfg: any, group: any, serverId: string): void {
  const server = (cfg.servers ?? []).find((s: any) => s.id === serverId);
  if (!server) return;
  if (!Array.isArray(group.manualServerIds)) group.manualServerIds = [];
  if (!Array.isArray(group.excludedSubscriptionKeys)) group.excludedSubscriptionKeys = [];
  if (group.serverIds.includes(serverId)) {
    server.groupId = group.id;
    return;
  }
  for (const other of cfg.serverGroups) {
    if (other.id === group.id) continue;
    removeServerFromGroup(cfg, other, serverId);
  }
  server.groupId = group.id;
  if (!group.manualServerIds.includes(serverId)) group.manualServerIds.push(serverId);
  if (!group.serverIds.includes(serverId)) group.serverIds.push(serverId);
}

/**
 * 将服务器从指定分组移除。
 * 若该节点是订阅成员，则加入排除列表，下次订阅刷新时不会被自动加回。
 */
function removeServerFromGroup(cfg: any, group: any, serverId: string): void {
  const server = (cfg.servers ?? []).find((s: any) => s.id === serverId);
  if (!server) return;
  if (!Array.isArray(group.manualServerIds)) group.manualServerIds = [];
  if (!Array.isArray(group.subscriptionServerIds)) group.subscriptionServerIds = [];
  if (!Array.isArray(group.excludedSubscriptionKeys)) group.excludedSubscriptionKeys = [];
  if (!Array.isArray(group.serverIds)) group.serverIds = [];
  const wasSubscriptionMember = group.subscriptionServerIds.includes(serverId);
  group.serverIds = group.serverIds.filter((id: string) => id !== serverId);
  group.manualServerIds = group.manualServerIds.filter((id: string) => id !== serverId);
  group.subscriptionServerIds = group.subscriptionServerIds.filter((id: string) => id !== serverId);
  if (wasSubscriptionMember) {
    const key = buildServerKey(server);
    if (!group.excludedSubscriptionKeys.includes(key)) group.excludedSubscriptionKeys.push(key);
  }
  if (server.groupId === group.id) delete server.groupId;
}

const groupApi = {
  getAll: async (): Promise<any[]> => (await configApi.get()).serverGroups ?? [],
  create: async (input: { name: string; serverIds?: string[] }): Promise<any> => {
    const cfg = await configApi.get();
    const now = new Date().toISOString();
    const group = {
      id: crypto.randomUUID(),
      name: input.name,
      serverIds: [],
      subscriptionServerIds: [],
      manualServerIds: [],
      excludedSubscriptionKeys: [],
      createdAt: now,
      updatedAt: now,
    };
    if (!Array.isArray(cfg.serverGroups)) cfg.serverGroups = [];
    cfg.serverGroups.push(group);
    if (input.serverIds) {
      for (const id of input.serverIds) addServerToGroup(cfg, group, id);
    }
    await configApi.save(cfg);
    return group;
  },
  // 单个原子更新：改名 + 批量增删成员（一次保存，避免重复触发代理重启）
  update: async (input: {
    groupId: string;
    name?: string;
    addServerIds?: string[];
    removeServerIds?: string[];
  }): Promise<any> => {
    const cfg = await configApi.get();
    const group = (cfg.serverGroups ?? []).find((g: any) => g.id === input.groupId);
    if (!group) throw new Error(`[tauri bridge] group.update: 分组不存在: ${input.groupId}`);
    if (input.name !== undefined && input.name.trim()) group.name = input.name.trim();
    if (input.addServerIds) {
      for (const id of input.addServerIds) addServerToGroup(cfg, group, id);
    }
    if (input.removeServerIds) {
      for (const id of input.removeServerIds) removeServerFromGroup(cfg, group, id);
    }
    group.updatedAt = new Date().toISOString();
    await configApi.save(cfg);
    return group;
  },
  delete: async (groupId: string): Promise<void> => {
    const cfg = await configApi.get();
    const i = (cfg.serverGroups ?? []).findIndex((g: any) => g.id === groupId);
    if (i < 0) throw new Error(`[tauri bridge] group.delete: 分组不存在: ${groupId}`);
    cfg.serverGroups.splice(i, 1);
    for (const s of cfg.servers ?? []) {
      if (s.groupId === groupId) delete s.groupId;
    }
    if (cfg.selectedGroupId === groupId) cfg.selectedGroupId = null;
    await configApi.save(cfg);
  },
  select: async (groupId: string | null): Promise<void> => {
    const cfg = await configApi.get();
    if (groupId !== null) {
      const group = (cfg.serverGroups ?? []).find((g: any) => g.id === groupId);
      if (!group || group.serverIds.length === 0) {
        throw new Error('[tauri bridge] group.select: 分组不存在或没有成员服务器');
      }
      cfg.selectedGroupId = groupId;
      cfg.selectedServerId = null;
    } else {
      cfg.selectedGroupId = null;
    }
    await configApi.save(cfg);
  },
  addServers: async (input: { serverIds: string[]; groupId: string }): Promise<void> => {
    const cfg = await configApi.get();
    const group = (cfg.serverGroups ?? []).find((g: any) => g.id === input.groupId);
    if (!group) throw new Error(`[tauri bridge] group.addServers: 分组不存在: ${input.groupId}`);
    for (const id of input.serverIds) addServerToGroup(cfg, group, id);
    await configApi.save(cfg);
  },
  // 移动节点到指定分组（自动从旧分组移除）
  moveServer: async (input: { serverId: string; targetGroupId: string }): Promise<void> => {
    const cfg = await configApi.get();
    const target = (cfg.serverGroups ?? []).find((g: any) => g.id === input.targetGroupId);
    if (!target) throw new Error(`[tauri bridge] group.moveServer: 目标分组不存在: ${input.targetGroupId}`);
    const server = (cfg.servers ?? []).find((s: any) => s.id === input.serverId);
    if (!server) throw new Error(`[tauri bridge] group.moveServer: 服务器不存在: ${input.serverId}`);
    for (const other of cfg.serverGroups) {
      if (other.id === target.id) continue;
      removeServerFromGroup(cfg, other, input.serverId);
    }
    addServerToGroup(cfg, target, input.serverId);
    target.updatedAt = new Date().toISOString();
    await configApi.save(cfg);
  },
  // 生成分组分享文本：组内每个成员生成一个协议链接，换行拼接
  generateShareUrl: async (groupId: string): Promise<string> => {
    const cfg = await configApi.get();
    const group = (cfg.serverGroups ?? []).find((g: any) => g.id === groupId);
    if (!group) throw new Error(`[tauri bridge] group.generateShareUrl: 分组不存在: ${groupId}`);
    const members = (cfg.servers ?? []).filter((s: any) => group.serverIds.includes(s.id));
    if (members.length === 0) throw new Error('该分组暂无成员，无法生成分享');
    const urls = await Promise.all(members.map((s: any) => serverApi.generateUrl(s)));
    return urls.join('\n');
  },
};

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------
const versionApi = {
  getInfo: async (): Promise<{
    appVersion: string;
    appName: string;
    buildDate: string;
    singBoxVersion: string;
    copyright: string;
    repositoryUrl: string;
  }> => {
    const appVersion = await invoke<string>('get_version');
    const year = new Date().getFullYear();
    return {
      appVersion,
      appName: 'FlowZ',
      buildDate: new Date().toISOString().split('T')[0],
      singBoxVersion: '1.14.1',
      copyright: `© ${year} FlowZ. All rights reserved.`,
      repositoryUrl: 'https://github.com/zhangjh/FlowZ',
    };
  },
};

// ---------------------------------------------------------------------------
// systemProxy / autoStart / admin
// ---------------------------------------------------------------------------
const systemProxyApi = {
  enable: (address: string, port: number): Promise<void> =>
    invoke('system_proxy_enable', { address, httpPort: port, socksPort: port }),
  disable: (): Promise<void> => invoke('system_proxy_disable'),
  getStatus: (): Promise<unknown> => invoke('system_proxy_get_status'),
};

const logsApi = {
  get: (limit?: number): Promise<unknown[]> =>
    invoke('logs_get', { limit }),
  clear: (): Promise<void> => invoke('logs_clear'),
  setLevel: (level: string): Promise<void> => invoke('logs_set_level', { level }),
  openFolder: (): Promise<void> => invoke('logs_open_folder'),
  onReceived: (listener: (log: unknown) => void): (() => void) => {
    let unlisten: (() => void) | null = null;
    listen<unknown>('event:logReceived', (e) => listener(e.payload)).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  },
};

const autoSelectApi = {
  testAll: (): Promise<unknown[]> => invoke('autoselect_test_all'),
  // 兼容旧接口：Rust 侧暂只支持全量测速，忽略 serverIds
  testServers: (_serverIds?: string[]): Promise<unknown[]> => invoke('autoselect_test_all'),
  getStatus: (): Promise<unknown> => invoke('autoselect_get_status'),
  triggerFailover: (): Promise<void> => invoke('autoselect_trigger_failover'),
};

const updateApi = {
  check: (includePrerelease = false): Promise<unknown> =>
    invoke('update_check', { includePrerelease }),
  download: (updateInfo: {
    downloadUrl: string;
    fileName: string;
    fileSize?: number;
  }): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    invoke('update_download', {
      downloadUrl: updateInfo.downloadUrl,
      fileName: updateInfo.fileName,
      fileSize: updateInfo.fileSize ?? 0,
    }),
  install: (filePath: string): Promise<{ success: boolean; error?: string }> =>
    invoke('update_install', { filePath }),
  skip: (_version?: string): Promise<{ success: boolean }> => Promise.resolve({ success: true }),
  openReleases: (): Promise<{ success: boolean }> => invoke('update_open_releases'),
  onProgress: (listener: (progress: unknown) => void): (() => void) => {
    let unlisten: (() => void) | null = null;
    listen<unknown>('event:updateProgress', (e) => listener(e.payload)).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  },
};

const autoStartApi = {
  set: (enabled: boolean): Promise<boolean> =>
    invoke('autostart_set', { enabled }).then(() => true),
  getStatus: async (): Promise<{ enabled: boolean }> => ({
    enabled: await invoke<boolean>('autostart_is_enabled'),
  }),
};

const adminApi = {
  check: (): Promise<unknown> => invoke('admin_check'),
};
// ---------------------------------------------------------------------------
// 未移植的 namespace：invoke 抛错，订阅 warn+空卸载
// ---------------------------------------------------------------------------
function stubNamespace(ns: string): any {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'then') return undefined;
        if (prop.startsWith('on')) return noopListener(ns, prop);
        return notPorted(ns, prop);
      },
    }
  );
}

/** 与 api-client.ts 的 `api` 同形 */
export const api = {
  proxy: proxyApi,
  config: configApi,
  server: serverApi,
  group: groupApi,
  rules: rulesApi,
  logs: logsApi,
  systemProxy: systemProxyApi,
  autoStart: autoStartApi,
  stats: stubNamespace('stats'),
  connection: stubNamespace('connection'),
  version: versionApi,
  admin: adminApi,
  update: updateApi,
  autoSelect: autoSelectApi,
  appEvents: appEventsApi,
};

export default api;

// ---------------------------------------------------------------------------
// ipcClient：事件订阅
// ---------------------------------------------------------------------------

/** 通道名 -> Tauri 事件名的映射 */
const tauriEventMap: Record<string, string> = {
  navigate: 'event:navigate',
  speedTestResult: 'event:speedTestResult',
};

/** Rust 托盘发来的 { page } -> 路由字符串 */
const navigatePageMap: Record<string, string> = {
  servers: '/server',
  settings: '/settings',
  home: '/home',
  rules: '/rules',
};

/**
 * Tauri 下的事件订阅客户端：`on()` 走 @tauri-apps/api/event 的 listen，
 * 并把 Rust 事件的 payload 适配成调用方期望的格式。
 */
class TauriIpcClient {
  on<T>(channel: string, listener: (data: T) => void): Unsubscribe {
    const eventName = tauriEventMap[channel] ?? channel;
    let unlisten: Unsubscribe | undefined;
    listen<T>(eventName, (event) => {
      let data = event.payload as T;
      if (channel === 'navigate') {
        const page = (event.payload as { page?: string } | null)?.page;
        data = ((page && navigatePageMap[page]) || '/home') as unknown as T;
      }
      listener(data);
    })
      .then((u) => {
        unlisten = u;
      })
      .catch((e) => {
        console.warn(`[tauri ipcClient] listen(${eventName}) failed:`, e);
      });
    return () => {
      unlisten?.();
    };
  }

  once<T>(channel: string, listener: (data: T) => void): Unsubscribe {
    const off = this.on<T>(channel, (data) => {
      off();
      listener(data);
    });
    return off;
  }

  off(): void {}
  removeAllListeners(): void {}
  getListenerCount(): number {
    return 0;
  }
}

/** 事件订阅客户端（App.tsx 等直接订阅事件的地方使用） */
export const ipcClient = new TauriIpcClient();
