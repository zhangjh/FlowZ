/**
 * Tauri bridge — phase 3.
 *
 * Tauri 前端 API：proxy/config/server/… namespace，
 * 底层走 `invoke` / `listen`。
 *
 * 已移植：proxy（start/stop/restart/getStatus + 事件）、config（get/save/
 * updateMode/getValue/setValue）、server（parseUrl/generateUrl/
 * parseSubscription/纯配置类 CRUD）、version.getInfo。
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
    await configApi.save(cfg);
    // 切换节点后重启代理（与 Electron 行为一致）
    await proxyApi.restart(cfg);
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
  download: (): Promise<{ success: boolean }> =>
    invoke('update_download_install'),
  install: (): Promise<{ success: boolean }> =>
    Promise.resolve({ success: true }),
  skip: (): Promise<{ success: boolean }> =>
    Promise.resolve({ success: true }),
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
  group: stubNamespace('group'),
  rules: stubNamespace('rules'),
  logs: logsApi,
  systemProxy: systemProxyApi,
  autoStart: autoStartApi,
  stats: stubNamespace('stats'),
  connection: stubNamespace('connection'),
  version: versionApi,
  admin: adminApi,
  update: updateApi,
  autoSelect: autoSelectApi,
};

export default api;

// ---------------------------------------------------------------------------
// ipcClient：事件订阅（兼容旧 Electron 通道名）
// ---------------------------------------------------------------------------

/** Electron 通道名 -> Tauri 事件名的映射 */
const tauriEventMap: Record<string, string> = {
  navigate: 'event:navigate',
  speedTestResult: 'event:speedTestResult',
};

/** Rust 托盘发来的 { page } -> Electron 风格的路由字符串 */
const navigatePageMap: Record<string, string> = {
  servers: '/server',
  settings: '/settings',
  home: '/home',
  rules: '/rules',
};

/**
 * Tauri 下的事件订阅客户端：`on()` 走 @tauri-apps/api/event 的 listen，
 * 并把 Rust 事件的 payload 适配成调用方期望的 Electron 格式。
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
