/**
 * 全局类型声明（Tauri）
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export {};
