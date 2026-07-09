/**
 * Zustand store for application state management
 */

import { create } from 'zustand';
import type { UserConfig, DomainRule, TrafficStats } from '../../shared/types';
import { api } from '../ipc';

// 兼容旧的类型定义
type ProxyMode = UserConfig['proxyMode'];

interface ConnectionStatus {
  proxyCore: {
    running: boolean;
    pid?: number;
    uptime?: number;
    error?: string;
  };
  proxy: {
    enabled: boolean;
    server?: string;
  };
  proxyModeType: UserConfig['proxyModeType'];
}

interface AppState {
  // UI State
  currentView: string;
  isLoading: boolean;
  error: string | null;

  // Connection State
  connectionStatus: ConnectionStatus | null;

  // Configuration
  config: UserConfig | null;

  // Statistics
  stats: TrafficStats | null;

  // Actions
  setCurrentView: (view: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Proxy Control Actions
  startProxy: () => Promise<void>;
  stopProxy: () => Promise<void>;

  // Configuration Actions
  loadConfig: () => Promise<void>;
  saveConfig: (config: UserConfig) => Promise<void>;
  updateProxyMode: (mode: ProxyMode) => Promise<void>;
  switchServer: (serverId: string) => Promise<void>;

  // Status Actions
  refreshConnectionStatus: () => Promise<void>;
  refreshStatistics: () => Promise<void>;
  resetStatistics: () => Promise<void>;

  // Server Management Actions
  deleteServer: (serverId: string) => Promise<void>;

  // Custom Rules Actions
  addCustomRule: (rule: DomainRule) => Promise<void>;
  updateCustomRule: (rule: DomainRule) => Promise<void>;
  deleteCustomRule: (ruleId: string) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial State
  currentView: 'home',
  isLoading: false,
  error: null,
  connectionStatus: null,
  config: null,
  stats: null,

  // UI Actions
  setCurrentView: (view) => set({ currentView: view }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  // Proxy Control Actions
  startProxy: async () => {
    set({ isLoading: true, error: null });
    try {
      // 获取当前配置
      const currentConfig = get().config;
      if (!currentConfig) {
        throw new Error('配置未加载');
      }

      // 直接启动代理，ProxyManager 会在需要时通过 osascript 请求管理员权限
      // 不再预先检查权限，因为 sing-box 进程会在 TUN 模式下自动请求权限
      const isTunMode = currentConfig.proxyModeType?.toLowerCase() === 'tun';
      console.log(
        '[StartProxy] proxyModeType:',
        currentConfig.proxyModeType,
        'isTunMode:',
        isTunMode
      );

      if (isTunMode) {
        console.log('[StartProxy] TUN mode detected, sing-box will request admin privileges when needed');
      }

      await api.proxy.start(currentConfig);
      // 启动成功后不立即设置 isLoading = false，而是等待状态轮询完成

      // Poll connection status until connected or timeout
      const maxAttempts = 20; // 10 seconds (20 * 500ms)
      let attempts = 0;

      const pollStatus = async (): Promise<void> => {
        attempts++;
        await get().refreshConnectionStatus();

        const status = get().connectionStatus;

        // Debug logging
        console.log(`[StartProxy] Polling attempt ${attempts}:`, {
          proxyCoreRunning: status?.proxyCore?.running,
          proxyEnabled: status?.proxy?.enabled,
          proxyCoreError: status?.proxyCore?.error,
          proxyCorePid: status?.proxyCore?.pid,
        });

        // Check if connected based on proxy mode type
        const isTunMode = status?.proxyModeType === 'tun';
        const isConnected = isTunMode
          ? status?.proxyCore?.running // TUN mode: only check if proxy core is running
          : status?.proxyCore?.running && status?.proxy?.enabled; // System proxy mode: check both

        if (isConnected) {
          console.log('[StartProxy] Connection successful!', { mode: status?.proxyModeType });
          // Ensure final status update before completing
          await get().refreshConnectionStatus();
          set({ isLoading: false });
          return;
        }

        // Check for proxy core errors
        if (status?.proxyCore?.error) {
          console.log('[StartProxy] Proxy core error detected:', status.proxyCore.error);
          set({
            error: status.proxyCore.error,
            isLoading: false,
          });
          return;
        }

        // Check if proxy core failed to start (not running and no error means startup failed)
        if (attempts > 3 && !status?.proxyCore?.running) {
          console.log('[StartProxy] Proxy core failed to start');
          set({
            error: 'sing-box 启动失败：进程无法正常启动，请检查服务器配置',
            isLoading: false,
          });
          return;
        }

        // Check timeout
        if (attempts >= maxAttempts) {
          console.log('[StartProxy] Connection timeout');
          set({
            error: '连接超时：无法在预期时间内建立连接，请检查服务器配置',
            isLoading: false,
          });
          return;
        }

        // Continue polling
        setTimeout(pollStatus, 500);
      };

      // Start polling immediately
      await pollStatus();
    } catch (error) {
      set({ error: String(error), isLoading: false });
      // Refresh status to ensure UI reflects actual state
      await get().refreshConnectionStatus();
    }
  },

  stopProxy: async () => {
    set({ isLoading: true, error: null });
    try {
      await api.proxy.stop();
      // Refresh status after stopping
      await get().refreshConnectionStatus();
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ isLoading: false });
    }
  },

  // Configuration Actions
  loadConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      console.log('[Store] Loading config...');
      const config = await api.config.get();
      console.log('[Store] Config loaded successfully:', config);

      // 确保有默认的TUN配置
      if (!config.tunConfig) {
        config.tunConfig = {
          mtu: 9000,
          stack: 'system',
          autoRoute: true,
          strictRoute: true,
        };
      }

      // 确保有默认的代理模式类型
      if (!config.proxyModeType) {
        config.proxyModeType = 'systemProxy';
      }

      set({ config });
    } catch (error) {
      console.error('[Store] Exception loading config:', error);
      set({ error: String(error) });
    } finally {
      set({ isLoading: false });
    }
  },

  saveConfig: async (config) => {
    set({ isLoading: true, error: null });
    try {
      console.log('[Store] Saving config:', config);
      await api.config.save(config);
      console.log('[Store] Config saved successfully');
      set({ config });
    } catch (error) {
      console.error('[Store] Exception saving config:', error);
      set({ error: String(error) });
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  updateProxyMode: async (mode) => {
    set({ isLoading: true, error: null });
    try {
      await api.config.updateMode(mode);
      // Update local config
      const currentConfig = get().config;
      if (currentConfig) {
        set({ config: { ...currentConfig, proxyMode: mode } });
      }
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ isLoading: false });
    }
  },

  switchServer: async (serverId) => {
    set({ isLoading: true, error: null });
    try {
      await api.server.switch(serverId);
      // Update local config
      const currentConfig = get().config;
      if (currentConfig) {
        set({ config: { ...currentConfig, selectedServerId: serverId } });
      }
      // Refresh connection status
      await get().refreshConnectionStatus();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  // Status Actions
  refreshConnectionStatus: async () => {
    try {
      const proxyStatus = await api.proxy.getStatus();
      const current = get().connectionStatus;
      const next: ConnectionStatus = {
        proxyCore: {
          running: proxyStatus.running,
          pid: proxyStatus.pid,
          uptime: proxyStatus.uptime,
          error: proxyStatus.error,
        },
        proxy: {
          enabled: proxyStatus.running,
          server: proxyStatus.currentServer?.name,
        },
        proxyModeType: get().config?.proxyModeType || 'systemProxy',
      };
      if (
        !current ||
        current.proxyCore.running !== next.proxyCore.running ||
        current.proxyCore.pid !== next.proxyCore.pid ||
        current.proxyCore.error !== next.proxyCore.error ||
        current.proxy.enabled !== next.proxy.enabled ||
        current.proxy.server !== next.proxy.server ||
        current.proxyModeType !== next.proxyModeType
      ) {
        set({ connectionStatus: next });
      }
    } catch (error) {
      console.error('Failed to refresh connection status:', error);
    }
  },

  refreshStatistics: async () => {
    try {
      const stats = await api.stats.get();
      set({ stats });
    } catch (error) {
      console.error('Failed to refresh statistics:', error);
    }
  },

  resetStatistics: async () => {
    set({ isLoading: true, error: null });
    try {
      await api.stats.reset();
      set({
        stats: {
          uploadSpeed: 0,
          downloadSpeed: 0,
          totalUpload: 0,
          totalDownload: 0,
        },
      });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ isLoading: false });
    }
  },

  // Server Management Actions
  deleteServer: async (serverId) => {
    set({ isLoading: true, error: null });
    try {
      await api.server.delete(serverId);
      // Reload config to get updated server list
      await get().loadConfig();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  // Custom Rules Actions
  addCustomRule: async (rule) => {
    set({ isLoading: true, error: null });
    try {
      await api.rules.add(rule);
      // Reload config to get updated rules
      await get().loadConfig();
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ isLoading: false });
    }
  },

  updateCustomRule: async (rule) => {
    console.log('[Store] updateCustomRule called with:', rule);
    set({ isLoading: true, error: null });
    try {
      console.log('[Store] Calling api.rules.update...');
      await api.rules.update(rule);
      console.log('[Store] Rule updated successfully, reloading config...');
      // Reload config to get updated rules
      await get().loadConfig();
      console.log('[Store] Config reloaded after rule update');
    } catch (error) {
      console.error('[Store] Exception in updateCustomRule:', error);
      set({ error: String(error) });
      throw error;
    } finally {
      console.log('[Store] updateCustomRule completed, setting isLoading to false');
      set({ isLoading: false });
    }
  },

  deleteCustomRule: async (ruleId) => {
    set({ isLoading: true, error: null });
    try {
      await api.rules.delete(ruleId);
      // Reload config to get updated rules
      await get().loadConfig();
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ isLoading: false });
    }
  },
}));
