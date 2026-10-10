/**
 * React hook for listening to IPC events from Tauri backend
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

// "重启中"状态的兜底定时器：
// 重启开始事件（proxyRestarting）与结束事件（processStarted/processStopped）是两个独立 IPC，
// 任何一个结束事件丢失都会让首页按钮永久卡在"重启中"。兜底定时器保证超时后按实际状态自愈。
let restartingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
// Linux 下提权弹窗等用户操作可能耗时较长，留足 90 秒
const RESTARTING_FALLBACK_MS = 90_000;

function clearRestartingFallback(): void {
  if (restartingFallbackTimer) {
    clearTimeout(restartingFallbackTimer);
    restartingFallbackTimer = null;
  }
}

/** 结束"重启中"状态：先刷新真实连接状态，再复位按钮 */
function finishRestartingPhase(): void {
  import('../store/app-store').then(({ useAppStore }) => {
    const state = useAppStore.getState();
    if (state.proxyPhase !== 'restarting') return;
    // 刷新真实状态后再复位，避免把一次仍在进行的重启误判为空闲
    state.refreshConnectionStatus().finally(() => {
      if (useAppStore.getState().proxyPhase === 'restarting') {
        useAppStore.setState({ proxyPhase: 'idle', isLoading: false });
      }
    });
  });
}

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
    clearRestartingFallback();
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
    clearRestartingFallback();
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
      // 托盘切换服务器/模式后，也要刷新连接状态（选中态、按钮状态联动）
      useAppStore.getState().refreshConnectionStatus();
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
      clearRestartingFallback();
      useAppStore.setState({ proxyPhase: 'restarting', isLoading: true, error: null });
      // 兜底：若后续的 started/stopped 事件丢失，超时后按实际状态自愈，
      // 避免首页按钮永久卡在"重启中"
      restartingFallbackTimer = setTimeout(() => {
        restartingFallbackTimer = null;
        console.log('[NativeEvent] Restarting fallback: resetting stuck restarting state');
        finishRestartingPhase();
      }, RESTARTING_FALLBACK_MS);
    });
  });

  // 托盘操作同步：窗口可见时每 3 秒检查一次配置/状态
  // （托盘是原生菜单，操作时不会触发 webview 的 focus 事件）
  // 不可见时不轮询，节省资源
  useEffect(() => {
    let lastRunning: boolean | null = null;
    let lastConfigJson: string | null = null;
    let syncing = false;

    const doSync = async () => {
      if (syncing) return;
      // 窗口不可见时跳过
      if (document.visibilityState !== 'visible') return;
      syncing = true;
      try {
        const { useAppStore } = await import('../store/app-store');
        const state = useAppStore.getState();
        if (state.isLoading) return;

        const status = (await api.proxy.getStatus()) as { running: boolean };
        const running = !!status?.running;
        const cfg = (await api.config.get()) as unknown;
        const cfgJson = JSON.stringify(cfg);

        const runningChanged = lastRunning !== null && lastRunning !== running;
        const configChanged = lastConfigJson !== null && lastConfigJson !== cfgJson;

        if (runningChanged || configChanged) {
          console.log('[tray-sync] 检测到托盘操作，同步前端');
          if (configChanged) {
            useAppStore.setState({ config: cfg as never });
          }
          await state.refreshConnectionStatus();
        }
        lastRunning = running;
        lastConfigJson = cfgJson;

        // 同步托盘测速结果到服务器页面
        try {
          const results = await (api as unknown as {
            appEvents: { getTraySpeedtestResults: () => Promise<Array<[string, number | null]>> };
          }).appEvents.getTraySpeedtestResults();
          if (results && results.length > 0) {
            const { useAppStore } = await import('../store/app-store');
            const store = useAppStore.getState();
            // 转换为 ServerSpeedResult 格式
            const speedResults = results.map(([serverId, latency]) => ({
              serverId,
              latency: latency ?? null,
            }));
            // 只有当结果变化时才更新，避免无限循环
            const current = JSON.stringify(store.speedTestResults);
            const next = JSON.stringify(speedResults);
            if (current !== next) {
              console.log('[tray-sync] 同步测速结果到服务器页面');
              useAppStore.setState({ speedTestResults: speedResults as never });
            }
          }
        } catch {
          // 忽略
        }

        // 检查托盘待处理的前端动作（如打开设置页面）
        try {
          const pending = await (api as unknown as {
            appEvents: { getPendingTrayAction: () => Promise<string | null> };
          }).appEvents.getPendingTrayAction();
          if (pending && pending.startsWith('navigate:')) {
            const page = pending.slice('navigate:'.length);
            const viewMap: Record<string, string> = {
              settings: 'settings',
              servers: 'server',
              home: 'home',
              rules: 'rules',
            };
            const view = viewMap[page] || 'home';
            console.log(`[tray-sync] 导航到: ${view}`);
            useAppStore.getState().setCurrentView(view);
          }
        } catch {
          // 忽略
        }
      } catch {
        // 静默失败
      } finally {
        syncing = false;
      }
    };

    // 可见时每 3 秒检查；窗口获得焦点时立即检查一次
    const timer = setInterval(doSync, 3000);
    const onFocus = () => doSync();
    window.addEventListener('focus', onFocus);
    // 启动后 3 秒做一次初始同步
    const initTimer = setTimeout(doSync, 3000);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      clearTimeout(initTimer);
    };
  }, []);
}
