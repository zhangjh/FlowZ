/**
 * 渲染进程 IPC 模块导出（Tauri 专用）
 *
 * 直接从 Tauri bridge 导出 `api`，以及事件订阅用的 `ipcClient`
 *（基于 @tauri-apps/api/event 的 listen）。
 */

export { api } from '../tauri/bridge';
export { ipcClient } from '../tauri/bridge';
