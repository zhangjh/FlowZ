/**
 * 渲染进程 IPC 客户端
 * 提供类型安全的 IPC 调用封装
 */

import { ApiResponse } from '../../shared/types';

interface ElectronIpcRenderer {
  invoke: <T = any>(channel: string, args?: any) => Promise<T>;
  on: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
  once: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
  off: (channel: string, listener: (...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

/**
 * 获取 IPC Renderer 实例
 */
function getIpcRenderer(): ElectronIpcRenderer {
  if (!window.electron?.ipcRenderer) {
    throw new Error('IPC Renderer is not available. Make sure preload script is loaded.');
  }
  return window.electron.ipcRenderer as ElectronIpcRenderer;
}

/**
 * IPC 客户端类
 * 提供类型安全的 IPC 调用和事件监听
 */
type EventListener = (...args: any[]) => void;

export class IpcClient {
  private ipcRenderer: ElectronIpcRenderer | null = null;
  private eventListeners: Map<string, Set<EventListener>> = new Map();

  /**
   * 延迟获取 ipcRenderer：构造时不抛错（Tauri webview 里没有 window.electron，
   * 模块顶层实例化不能崩，否则整个前端白屏）。真正调用时才检查。
   */
  private get renderer(): ElectronIpcRenderer {
    if (!this.ipcRenderer) {
      this.ipcRenderer = getIpcRenderer();
    }
    return this.ipcRenderer;
  }

  constructor() {
    // 故意不在构造时获取 ipcRenderer，见 renderer getter 的注释
  }

  /**
   * 调用主进程方法
   * @param channel IPC 通道名称
   * @param args 参数
   * @returns 响应数据
   */
  async invoke<TArgs = any, TResult = any>(channel: string, args?: TArgs): Promise<TResult> {
    try {
      console.log(`[IPC Client] Invoking: ${channel}`, args);

      const response = (await this.renderer.invoke(channel, args)) as ApiResponse<TResult>;

      if (!response.success) {
        const error = new Error(response.error || 'Unknown error');
        (error as any).code = response.code;
        throw error;
      }

      console.log(`[IPC Client] Success: ${channel}`, response.data);
      return response.data as TResult;
    } catch (error) {
      console.error(`[IPC Client] Error invoking ${channel}:`, error);
      throw error;
    }
  }

  /**
   * 监听主进程事件
   * @param channel 事件通道名称
   * @param listener 事件监听器
   * @returns 取消监听函数
   */
  on<T = any>(channel: string, listener: (data: T) => void): () => void {
    console.log(`[IPC Client] Registering listener for: ${channel}`);

    // 包装监听器以提取数据
    const wrappedListener = (_event: any, data: T) => {
      console.log(`[IPC Client] Received event: ${channel}`, data);
      listener(data);
    };

    // 注册监听器
    this.renderer.on(channel, wrappedListener);

    // 记录监听器以便管理
    if (!this.eventListeners.has(channel)) {
      this.eventListeners.set(channel, new Set());
    }
    this.eventListeners.get(channel)!.add(wrappedListener);

    // 返回取消监听函数
    return () => {
      this.off(channel, wrappedListener);
    };
  }

  /**
   * 监听主进程事件（仅一次）
   * @param channel 事件通道名称
   * @param listener 事件监听器
   */
  once<T = any>(channel: string, listener: (data: T) => void): void {
    console.log(`[IPC Client] Registering one-time listener for: ${channel}`);

    const wrappedListener = (_event: any, data: T) => {
      console.log(`[IPC Client] Received one-time event: ${channel}`, data);
      listener(data);
    };

    this.renderer.once(channel, wrappedListener);
  }

  /**
   * 取消监听主进程事件
   * @param channel 事件通道名称
   * @param listener 事件监听器（可选，不提供则移除所有监听器）
   */
  off(channel: string, listener?: EventListener): void {
    if (listener) {
      this.renderer.off(channel, listener as any);

      const listeners = this.eventListeners.get(channel);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.eventListeners.delete(channel);
        }
      }

      console.log(`[IPC Client] Removed listener for: ${channel}`);
    } else {
      this.renderer.removeAllListeners(channel);
      this.eventListeners.delete(channel);
      console.log(`[IPC Client] Removed all listeners for: ${channel}`);
    }
  }

  /**
   * 移除所有事件监听器
   */
  removeAllListeners(): void {
    for (const channel of this.eventListeners.keys()) {
      this.renderer.removeAllListeners(channel);
    }
    this.eventListeners.clear();
    console.log(`[IPC Client] Removed all listeners`);
  }

  /**
   * 获取已注册的事件通道列表
   */
  getRegisteredChannels(): string[] {
    return Array.from(this.eventListeners.keys());
  }

  /**
   * 获取指定通道的监听器数量
   */
  getListenerCount(channel: string): number {
    return this.eventListeners.get(channel)?.size || 0;
  }
}

/**
 * 全局 IPC 客户端实例（Electron 专用；Tauri 下请用 ipc/index.ts 导出的运行时选择版本）
 */
export const electronIpcClient = new IpcClient();

/**
 * 便捷函数：调用主进程方法
 */
export async function invoke<TArgs = any, TResult = any>(
  channel: string,
  args?: TArgs
): Promise<TResult> {
  return electronIpcClient.invoke<TArgs, TResult>(channel, args);
}

/**
 * 便捷函数：监听主进程事件
 */
export function on<T = any>(channel: string, listener: (data: T) => void): () => void {
  return electronIpcClient.on<T>(channel, listener);
}

/**
 * 便捷函数：监听主进程事件（仅一次）
 */
export function once<T = any>(channel: string, listener: (data: T) => void): void {
  electronIpcClient.once<T>(channel, listener);
}

/**
 * 便捷函数：取消监听主进程事件
 */
export function off(channel: string, listener?: EventListener): void {
  electronIpcClient.off(channel, listener);
}
