/**
 * React hook for listening to IPC events from Tauri backend
 */

import { useEffect } from 'react';
import { toast } from 'sonner';
import { api } from '../ipc';
import { openExternal, downloadUpdate, installUpdate } from '../bridge/api-wrapper';
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
  updateCheckResult: {
    hasUpdate: boolean;
    updateInfo?: {
      version: string;
      title?: string;
      releasePage?: string;
      downloadUrl?: string;
      fileName?: string;
      fileSize?: number;
    };
  };
}

type NativeEventListener<K extends keyof NativeEventData> = (data: NativeEventData[K]) => void;

// 已提示过更新的版本：事件通道与待处理结果兜底可能重复投递同一版本，据此去重。
const handledUpdateVersions = new Set<string>();

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
      case 'updateCheckResult':
        unsubscribe = (api as any).appEvents.onUpdateCheckResult(callback as any);
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

  // 启动时/托盘自动检查更新：仅在发现新版本时提示（后端已过滤"无更新"事件）
  const handleUpdateCheckResult = (data: NativeEventData['updateCheckResult']) => {
    if (!data?.hasUpdate || !data.updateInfo) return;
    const info = data.updateInfo;
    // 事件与轮询兜底可能投递同一版本，去重避免重复弹窗
    if (handledUpdateVersions.has(info.version)) return;
    handledUpdateVersions.add(info.version);

    const downloadAndInstall = async () => {
      const manualUrl = info.downloadUrl || info.releasePage;
      const toastId = toast.loading('正在下载更新... 0%');
      let unsubscribe: (() => void) | null = null;
      if (info.downloadUrl && info.fileName) {
        unsubscribe = api.update.onProgress((progress) => {
          const p = progress as { status: string; percentage: number };
          if (p.status === 'downloading') {
            toast.loading(`正在下载更新... ${p.percentage}%`, { id: toastId });
          }
        });
      }

      try {
        const result = await downloadUpdate(info);
        unsubscribe?.();
        unsubscribe = null;
        if (result.success && result.data) {
          toast.success('下载完成，正在安装...', { id: toastId });
          await installUpdate(result.data);
        } else {
          toast.error('下载失败', {
            id: toastId,
            description: result.error,
            action: manualUrl
              ? { label: '手动下载', onClick: () => openExternal(manualUrl) }
              : undefined,
          });
        }
      } catch (error) {
        unsubscribe?.();
        toast.error('下载失败', {
          id: toastId,
          description: error instanceof Error ? error.message : '未知错误',
          action: manualUrl
            ? { label: '手动下载', onClick: () => openExternal(manualUrl) }
            : undefined,
        });
      }
    };

    toast.success(`发现新版本 ${info.version}`, {
      description: info.title || '可以更新到最新版本',
      action: {
        label: '立即更新',
        onClick: () => downloadAndInstall(),
      },
    });
  };
  useNativeEvent('updateCheckResult', handleUpdateCheckResult);

  // 启动时检查更新的事件可能在 webview 注册监听器之前发出而丢失；
  // 挂载后在前 30s 内轮询待处理结果兜底（后端取出即清，配合版本去重避免重复提示）。
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      try {
        const pending = await (api as unknown as {
          appEvents: {
            getPendingUpdateResult: () => Promise<NativeEventData['updateCheckResult'] | null>;
          };
        }).appEvents.getPendingUpdateResult();
        if (!cancelled && pending?.hasUpdate) {
          handleUpdateCheckResult(pending);
        }
      } catch {
        // 忽略：兜底失败不影响事件通道
      }
      if (attempts >= 15) clearInterval(timer);
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

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

        // 连接状态与 store 实际值对比：启动时自动连接可能在挂载刷新之后、
        // 事件监听就绪之前完成，若用本地基线做增量比较，首次采样会把真实
        // 变化"吸收"掉导致按钮永久停留在旧状态。直接对 store 值刷新则无此问题。
        const storeRunning = !!state.connectionStatus?.proxyCore?.running;
        const configChanged = lastConfigJson !== null && lastConfigJson !== cfgJson;

        if (running !== storeRunning || configChanged) {
          console.log('[tray-sync] 前后端状态不同步，刷新前端');
          if (configChanged) {
            useAppStore.setState({ config: cfg as never });
          }
          await state.refreshConnectionStatus();
        }
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
    const timer = setInterval(async () => {
      await doSync();
      // 检查托盘测速是否完成（版本号变化则弹窗）
      try {
        const apiTyped = api as unknown as {
          appEvents: {
            getTraySpeedtestVersion: () => Promise<number>;
            getTraySpeedtestResults: () => Promise<Array<[string, number | null]>>;
          };
        };
        const version = await apiTyped.appEvents.getTraySpeedtestVersion();
        const lastVersion = (window as unknown as { __lastSpeedtestVersion?: number }).__lastSpeedtestVersion ?? 0;
        if (version > lastVersion) {
          (window as unknown as { __lastSpeedtestVersion?: number }).__lastSpeedtestVersion = version;
          console.log('[tray-sync] 检测到托盘测速完成，打开结果弹窗');
          // 拉取结果并通过自定义事件通知 App 打开弹窗
          const results = await apiTyped.appEvents.getTraySpeedtestResults();
          // 需要服务器名称和协议，从配置里查
          const { useAppStore } = await import('../store/app-store');
          const cfg = useAppStore.getState().config;
          const formatted = results.map(([serverId, latency]) => {
            const srv = cfg?.servers?.find((s: { id: string }) => s.id === serverId);
            return {
              name: (srv as { name?: string })?.name || serverId,
              protocol: ((srv as { protocol?: string })?.protocol || '').toUpperCase(),
              latency,
            };
          });
          window.dispatchEvent(new CustomEvent('tray-speedtest-done', { detail: formatted }));
        }
      } catch {
        // 忽略
      }
    }, 3000);
    const onFocus = () => doSync();
    window.addEventListener('focus', onFocus);
    // 窗口从隐藏转为可见时立即同步（隐藏期间状态可能已变化，如启动时自动连接）
    const onVisibility = () => {
      if (document.visibilityState === 'visible') doSync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // 启动后 3 秒做一次初始同步
    const initTimer = setTimeout(doSync, 3000);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(initTimer);
    };
  }, []);
}
