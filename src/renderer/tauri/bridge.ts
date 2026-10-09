/**
 * Tauri bridge — phase 1 scaffold.
 *
 * Mirrors the Electron `api` namespace shape (see ../bridge/api-wrapper.ts)
 * but only the commands registered in src-tauri/src/lib.rs are real.
 * Everything else throws an honest "not ported yet" error instead of
 * silently failing.
 *
 * Active only when the renderer runs inside the Tauri webview
 * (window.__TAURI__ present); see ../bridge/index.ts for the switch.
 */

import { invoke } from '@tauri-apps/api/core';
import type * as electronApi from '../bridge/api-wrapper';

type ApiShape = typeof electronApi;

/** Commands actually implemented in src-tauri/src/lib.rs (phase 1). */
const PORTED: Record<string, (...args: unknown[]) => Promise<unknown>> = {
  getVersionInfo: () => invoke('get_version'),
  getConfig: () => invoke('get_config'),
  getConnectionStatus: () => invoke('proxy_get_status'),
};

function notPorted(name: string): (...args: unknown[]) => Promise<never> {
  return async (..._args: unknown[]): Promise<never> => {
    throw new Error(`[tauri bridge] api.${name} not ported yet (phase 1 scaffold)`);
  };
}

export const api = new Proxy(PORTED, {
  get(target, prop: string | symbol) {
    if (typeof prop === 'string' && prop in target) {
      return target[prop];
    }
    return notPorted(String(prop));
  },
}) as unknown as ApiShape;
