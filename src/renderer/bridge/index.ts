/**
 * Bridge module exports
 *
 * api 从 `src/renderer/ipc/index.ts`（Tauri bridge）导出。
 * 这里只保留类型导出和兼容性转发。
 */

export * from './types';
export { api } from '../ipc';
