/**
 * Bridge module exports
 *
 * 运行时 api 选择已下沉到 `src/renderer/ipc/index.ts`（与 api-client 同形，
 * Tauri/Electron 一套调用方代码）。这里只保留类型导出和兼容性转发。
 */

export * from './types';
export { api } from '../ipc';
