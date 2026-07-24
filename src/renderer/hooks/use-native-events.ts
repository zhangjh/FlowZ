/**
 * React hook for listening to IPC events from Electron main process
 */

import { useEffect } from 'react';
import { api } from '../ipc';
import { ErrorHandler, ErrorCategory } from '../lib/error-handler';

// 定义事件数据类型
interface NativeEventData {
  processStarted: { pid: number; timestamp: string };
  processStopped: { timestamp: string };
  processError: { error: string; timestamp: string };
  configChanged: { key?: string; oldValue?: any; newValue?: any };
  statsUpdated: any;
  navigateToPage: string;
  proxyModeSwitched: { success: boolean; newMode: string };
  proxyModeSwitchFailed: { success: boolean; error: string };
  autoConnect: Record<string, never>;
  proxyRestarting: Record<string, never>;
}

type NativeEventListener<K extends keyof NativeEventData> = (data: NativeEventData[K]) => void;

export function useNativeEvent<K extends keyof NativeEventData>(
  eventName: K,
  callback: NativeEventListener<K>
) {
  useEffect(() => {
    // 根据事件名称注册对应的监听器
    let unsubscribe: (() => void) | undefined;

    switch (eventName) {
      case 'processStarted':
        unsubscribe = api.proxy.onStarted(callback as any);
        break;
      case 'processStopped':
        unsubscribe = api.proxy.onStopped(callback as any);
        break;
      case 'processError':
        unsubscribe = api.proxy.onError(callback as any);
        break;
      case 'configChanged':
        unsubscribe = api.config.onChanged(callback as any);
        break;
      case 'statsUpdated':
        unsubscribe = api.stats.onUpdated(callback as any);
        break;
      case 'autoConnect':
        unsubscribe = api.proxy.onAutoConnect(callback as any);
        break;
      case 'proxyRestarting':
        unsubscribe = api.proxy.onProxyRestarting(callback as any);
        break;
      default:
        console.warn(`Unknown event: ${eventName}`);
    }

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [eventName, callback]);
}

/**
 * Hook to listen to all native events and update store
 */
export function useNativeEventListeners() {
  const handleProcessStarted = (data: NativeEventData['processStarted']) => {
    console.log('Process started:', data);
    // Refresh connection status when process starts
    import('../store/app-store').then(({ useAppStore }) => {
      const state = useAppStore.getState();
      state.refreshConnectionStatus();
      // 如果处于重启状态，清除加载状态（重启完成）
      if (state.proxyPhase === 'restarting') {
        useAppStore.setState({ proxyPhase: 'idle', isLoading: false });
      }
    });
  };

  const handleProcessStopped = (data: NativeEventData['processStopped']) => {
    console.log('Process stopped:', data);
    // Refresh connection status when process stops
    import('../store/app-store').then(({ useAppStore }) => {
      const state = useAppStore.getState();
      state.refreshConnectionStatus();
      // 如果处于重启状态，清除加载状态（重启失败或被取消）
      if (state.proxyPhase === 'restarting') {
        useAppStore.setState({ proxyPhase: 'idle', isLoading: false });
      }
    });
  };

  const handleProcessError = (data: NativeEventData['processError']) => {
    console.error('Process error:', data);

    // Display user-friendly error notification
    if (data.error) {
      // Determine error category and retry capability
      let category = ErrorCategory.Process;
      let canRetry = true;

      // Check for Trojan-specific errors
      if (data.error.includes('Trojan') || data.error.includes('trojan')) {
        category = ErrorCategory.Connection;

        // Authentication and config errors are not retryable
        if (
          data.error.includes('认证失败') ||
          data.error.includes('密码错误') ||
          data.error.includes('配置错误')
        ) {
          canRetry = false;
        }
      }

      // Check for VLESS-specific errors
      if (data.error.includes('VLESS') || data.error.includes('vless')) {
        category = ErrorCategory.Connection;

        if (data.error.includes('UUID 错误') || data.error.includes('认证失败')) {
          canRetry = false;
        }
      }

      // Check for protocol errors
      if (data.error.includes('不支持的协议') || data.error.includes('Protocol')) {
        category = ErrorCategory.Config;
        canRetry = false;
      }

      // Handle the error with appropriate category
      ErrorHandler.handle({
        category,
        userMessage: data.error,
        technicalMessage: data.error,
        canRetry,
      });
    }
  };

  const handleConfigChanged = (data: NativeEventData['configChanged']) => {
    console.log('Config changed:', data);
    // 当收到配置变更事件时，直接使用事件中的新配置更新 store
    // 这样可以确保即使在 isLoading 状态下也能同步配置
    import('../store/app-store').then(({ useAppStore }) => {
      if (data.newValue) {
        // 直接更新 store 中的配置
        console.log('Config changed by external source, updating store directly');
        useAppStore.setState({ config: data.newValue });
      } else {
        // 如果没有新配置数据，则重新加载
        const state = useAppStore.getState();
        if (!state.isLoading) {
          console.log('Config changed, reloading from backend...');
          state.loadConfig();
        }
      }
    });
  };

  const handleStatsUpdated = (data: NativeEventData['statsUpdated']) => {
    console.log('Stats updated:', data);
    // 更新统计信息到 store
    import('../store/app-store').then(({ useAppStore }) => {
      useAppStore.getState().refreshStatistics();
    });
  };

  useNativeEvent('processStarted', handleProcessStarted);
  useNativeEvent('processStopped', handleProcessStopped);
  useNativeEvent('processError', handleProcessError);
  useNativeEvent('configChanged', handleConfigChanged);
  useNativeEvent('statsUpdated', handleStatsUpdated);

  // 自动连接事件：主进程请求渲染进程执行代理启动（含测速）
  useNativeEvent('autoConnect', () => {
    console.log('[NativeEvent] Auto-connect requested by main process');
    import('../store/app-store').then(({ useAppStore }) => {
      const state = useAppStore.getState();
      // 仅在未连接且未加载时响应，避免重复触发
      if (!state.isLoading && !state.connectionStatus?.proxyCore?.running) {
        state.startProxy();
      }
    });
  });

  // 代理重启事件：主进程正在重启代理
  useNativeEvent('proxyRestarting', () => {
    console.log('[NativeEvent] Proxy restarting');
    import('../store/app-store').then(({ useAppStore }) => {
      useAppStore.setState({ proxyPhase: 'restarting', isLoading: true, error: null });
    });
  });
}
