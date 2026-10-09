/**
 * 渲染进程 IPC 模块导出
 */

export * from './ipc-client';
export * from './api-client';

import electronApi from './api-client';
import { api as tauriApi } from '../tauri/bridge';

const isTauriRuntime =
  typeof window !== 'undefined' &&
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== undefined;

/**
 * 运行时选择的 api：Tauri webview 里走 invoke/listen，
 * Electron 里走 preload 暴露的 ipcRenderer。
 * 与 api-client 的 `api` 同形，调用方无需改动。
 */
export const api = (isTauriRuntime ? tauriApi : electronApi) as typeof electronApi;
