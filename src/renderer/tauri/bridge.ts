/**
 * Tauri bridge — phase 2.
 *
 * Mirrors the Electron `api` namespace shape (see ../bridge/api-wrapper.ts).
 * 已移植：getVersionInfo / getConfig / saveConfig / parseProtocolUrl /
 * generateShareUrl / parseSubscriptionUrl / getConnectionStatus（proxy 仍是 TODO 桩）。
 * Everything else throws an honest "not ported yet" error instead of
 * silently failing.
 *
 * Active only when the renderer runs inside the Tauri webview
 * (window.__TAURI__ present); see ../bridge/index.ts for the switch.
 */

import { invoke } from '@tauri-apps/api/core';
import type * as electronApi from '../bridge/api-wrapper';

type ApiShape = typeof electronApi;

/** 已在 src-tauri/src/lib.rs 实现的命令（phase-2）。 */
const PORTED: Record<string, (...args: any[]) => Promise<unknown>> = {
  getVersionInfo: () => invoke('get_version'),
  getConfig: () => invoke('get_config'),
  saveConfig: (config: unknown) => invoke('save_config', { config }),
  parseProtocolUrl: (url: string) => invoke('parse_protocol_url', { url }),
  generateShareUrl: (server: unknown) => invoke('generate_share_url', { server }),
  parseSubscriptionUrl: (input: { content?: string; url?: string }) =>
    invoke('parse_subscription', { payload: input }),
  // proxy_get_status 仍是 phase-3 的 TODO 桩：保留映射，调用会返回 honest 错误
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
