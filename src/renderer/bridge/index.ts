/**
 * Bridge module exports
 *
 * The `api` namespace is selected at runtime:
 * - Tauri webview (window.__TAURI__ present) -> ../tauri/bridge
 *   (phase-1 subset; unported calls throw honest "not ported yet" errors)
 * - otherwise -> ./api-wrapper (Electron path, unchanged default behavior)
 */

export * from './types';

import * as electronApi from './api-wrapper';
import { api as tauriApi } from '../tauri/bridge';

declare global {
  interface Window {
    __TAURI__?: unknown;
  }
}

const isTauriRuntime =
  typeof window !== 'undefined' && typeof window.__TAURI__ !== 'undefined';

export const api: typeof electronApi = isTauriRuntime ? tauriApi : electronApi;
