/**
 * 渲染进程 IPC 模块导出
 */

export * from './ipc-client';
export * from './api-client';

import { listen } from '@tauri-apps/api/event';
import electronApi from './api-client';
import { electronIpcClient } from './ipc-client';
import { api as tauriApi } from '../tauri/bridge';

const isTauriRuntime =
  typeof window !== 'undefined' &&
  ((window as unknown as { __TAURI__?: unknown }).__TAURI__ !== undefined ||
    // Tauri 2.12+ 默认 withGlobalTauri=false，不再注入 window.__TAURI__，
    // 但 __TAURI_INTERNALS__ 始终存在（@tauri-apps/api 的 IPC 机制）
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      undefined);

/**
 * 运行时选择的 api：Tauri webview 里走 invoke/listen，
 * Electron 里走 preload 暴露的 ipcRenderer。
 * 与 api-client 的 `api` 同形，调用方无需改动。
 */
export const api = (isTauriRuntime ? tauriApi : electronApi) as typeof electronApi;

// ---------------------------------------------------------------------------
// 运行时选择的 ipcClient（事件订阅）
// ---------------------------------------------------------------------------

type Unsubscribe = () => void;

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
 * Tauri 下的 ipcClient 替代实现：`on()` 走 @tauri-apps/api/event 的 listen，
 * 并把 Rust 事件的 payload 适配成调用方期望的 Electron 格式。
 * `invoke()` 在 Tauri 下不应使用（请走上面运行时选择的 `api`），调用会抛明确错误。
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

  invoke(): Promise<never> {
    return Promise.reject(
      new Error('[tauri ipcClient] invoke() 不可用：Tauri 下请使用 ipc/index.ts 导出的 `api`')
    );
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

/**
 * 运行时选择的 ipcClient：Tauri webview 里走 Tauri 事件，Electron 里走 ipcRenderer。
 * App.tsx 等直接订阅事件的地方请从 './ipc' 导入这个，而不是 './ipc/ipc-client'。
 */
export const ipcClient = (isTauriRuntime
  ? new TauriIpcClient()
  : electronIpcClient) as unknown as typeof electronIpcClient;
