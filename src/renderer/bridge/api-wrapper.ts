/**
 * API wrapper - 适配层
 * 将 Electron IPC API 适配为原 WPF 项目的 API 接口
 */

import { api } from '../ipc/api-client';
import { ErrorHandler, ErrorCategory } from '../lib/error-handler';
import type { ApiResponse, UserConfig, ServerConfig, DomainRule } from './types';

/**
 * 包装 API 调用，自动处理错误
 */
async function wrapApiCall<T>(
  apiCall: () => Promise<T>,
  context: string,
  _errorCategory: ErrorCategory = ErrorCategory.System
): Promise<T | null> {
  try {
    const result = await apiCall();
    return result;
  } catch (error) {
    ErrorHandler.handleApiError(error, context);
    return null;
  }
}

// 导出以避免未使用警告（保留用于未来扩展）
export { wrapApiCall };

/**
 * Proxy Control APIs with error handling
 */
export async function startProxy(config?: any): Promise<ApiResponse<void>> {
  try {
    // 如果没有传入配置，先获取当前配置
    const currentConfig = config || (await api.config.get());
    await api.proxy.start(currentConfig);
    ErrorHandler.showSuccess('代理已启动');
    return { success: true };
  } catch (error: any) {
    const errorMessage = error?.message || '启动代理失败';

    // Determine error category based on error message
    let category = ErrorCategory.Connection;
    let canRetry = true;

    if (errorMessage.includes('不支持的协议') || errorMessage.includes('Protocol')) {
      category = ErrorCategory.Config;
      canRetry = false;
    } else if (
      errorMessage.includes('认证失败') ||
      errorMessage.includes('密码错误') ||
      errorMessage.includes('UUID 错误')
    ) {
      category = ErrorCategory.Config;
      canRetry = false;
    } else if (errorMessage.includes('配置错误') || errorMessage.includes('配置格式')) {
      category = ErrorCategory.Config;
      canRetry = false;
    }

    ErrorHandler.handle({
      category,
      userMessage: errorMessage,
      technicalMessage: errorMessage,
      canRetry,
    });

    return { success: false, error: errorMessage };
  }
}

export async function stopProxy(): Promise<ApiResponse<void>> {
  try {
    await api.proxy.stop();
    ErrorHandler.showSuccess('代理已停止');
    return { success: true };
  } catch (error: any) {
    const errorMessage = error?.message || '停止代理失败';
    ErrorHandler.handleApiError(error, '停止代理');
    return { success: false, error: errorMessage };
  }
}

/**
 * Configuration Management APIs
 */
export async function getConfig(): Promise<ApiResponse<UserConfig>> {
  try {
    const config = await api.config.get();
    return { success: true, data: config };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '获取配置');
    return { success: false, error: error?.message };
  }
}

export async function saveConfig(config: UserConfig): Promise<ApiResponse<void>> {
  try {
    await api.config.save(config);
    ErrorHandler.showSuccess('配置已保存');
    return { success: true };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '保存配置');
    return { success: false, error: error?.message };
  }
}

export async function updateProxyMode(mode: UserConfig['proxyMode']): Promise<ApiResponse<void>> {
  try {
    await api.config.updateMode(mode);
    ErrorHandler.showSuccess('代理模式已更新');
    return { success: true };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '更新代理模式');
    return { success: false, error: error?.message };
  }
}

/**
 * Status and Statistics APIs
 */
export async function getConnectionStatus(): Promise<ApiResponse<any>> {
  try {
    const status = await api.proxy.getStatus();
    return { success: true, data: status };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function getStatistics(): Promise<ApiResponse<any>> {
  try {
    const stats = await api.stats.get();
    return { success: true, data: stats };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function resetStatistics(): Promise<ApiResponse<void>> {
  try {
    await api.stats.reset();
    ErrorHandler.showSuccess('流量统计已重置');
    return { success: true };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '重置流量统计');
    return { success: false, error: error?.message };
  }
}

/**
 * Custom Rules APIs
 */
export async function addCustomRule(
  rule: Omit<DomainRule, 'id'>
): Promise<ApiResponse<DomainRule>> {
  try {
    const newRule = await api.rules.add(rule);
    ErrorHandler.showSuccess('规则已添加');
    return { success: true, data: newRule };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '添加自定义规则');
    return { success: false, error: error?.message };
  }
}

export async function updateCustomRule(rule: DomainRule): Promise<ApiResponse<void>> {
  try {
    await api.rules.update(rule);
    ErrorHandler.showSuccess('规则已更新');
    return { success: true };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '更新自定义规则');
    return { success: false, error: error?.message };
  }
}

export async function deleteCustomRule(ruleId: string): Promise<ApiResponse<void>> {
  try {
    await api.rules.delete(ruleId);
    ErrorHandler.showSuccess('规则已删除');
    return { success: true };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '删除自定义规则');
    return { success: false, error: error?.message };
  }
}

/**
 * Logging APIs
 */
export async function getLogs(count?: number): Promise<ApiResponse<any[]>> {
  try {
    const logs = await api.logs.get(count);
    return { success: true, data: logs };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function clearLogs(): Promise<ApiResponse<void>> {
  try {
    await api.logs.clear();
    ErrorHandler.showSuccess('日志已清空');
    return { success: true };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '清空日志');
    return { success: false, error: error?.message };
  }
}

/**
 * Version Information APIs
 */
export async function getVersionInfo(): Promise<
  ApiResponse<{
    appVersion: string;
    appName: string;
    buildDate: string;
    singBoxVersion: string;
    copyright: string;
    repositoryUrl: string;
  }>
> {
  try {
    const data = await api.version.getInfo();
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

/**
 * Shell APIs
 */
export async function openExternal(url: string): Promise<ApiResponse<boolean>> {
  try {
    await window.electron.ipcRenderer.invoke('shell:openExternal', url);
    return { success: true, data: true };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

/**
 * Protocol URL Parsing APIs
 */
export async function parseProtocolUrl(
  url: string
): Promise<ApiResponse<Omit<ServerConfig, 'id'>>> {
  try {
    const server = await api.server.parseUrl(url);
    return { success: true, data: server };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '解析协议URL');
    return { success: false, error: error?.message };
  }
}

export async function addServerFromUrl(
  url: string,
  name: string
): Promise<ApiResponse<ServerConfig>> {
  try {
    const server = await api.server.addFromUrl(url, name);
    ErrorHandler.showSuccess('服务器已添加');
    return { success: true, data: server };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '从URL添加服务器');
    return { success: false, error: error?.message };
  }
}

export async function generateShareUrl(server: ServerConfig): Promise<ApiResponse<string>> {
  try {
    const url = await api.server.generateUrl(server);
    return { success: true, data: url };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, '生成分享链接');
    return { success: false, error: error?.message };
  }
}

/**
 * Update Management APIs
 */
export async function checkForUpdates(): Promise<
  ApiResponse<{
    hasUpdate: boolean;
    updateInfo?: {
      version: string;
      title: string;
      releaseNotes: string;
      downloadUrl: string;
      fileSize: number;
      publishedAt: string;
      isPrerelease: boolean;
      fileName: string;
    };
  }>
> {
  try {
    const result = await api.update.check();
    return { success: true, data: result };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function downloadUpdate(updateInfo: any): Promise<ApiResponse<string>> {
  try {
    const result = await api.update.download(updateInfo);
    if (result.success && result.filePath) {
      return { success: true, data: result.filePath };
    }
    return { success: false, error: result.error || '下载失败' };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function installUpdate(filePath: string): Promise<ApiResponse<void>> {
  try {
    const result = await api.update.install(filePath);
    if (result.success) {
      return { success: true };
    }
    return { success: false, error: result.error || '安装失败' };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function skipUpdateVersion(version: string): Promise<ApiResponse<void>> {
  try {
    await api.update.skip(version);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function openReleasesPage(): Promise<ApiResponse<void>> {
  try {
    await api.update.openReleases();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

/**
 * Event listener functions
 */
export function addEventListener(event: string, listener: (...args: any[]) => void): void {
  // 根据事件类型注册对应的监听器
  switch (event) {
    case 'proxyStarted':
      api.proxy.onStarted(listener);
      break;
    case 'proxyStopped':
      api.proxy.onStopped(listener);
      break;
    case 'proxyError':
      api.proxy.onError(listener);
      break;
    case 'configChanged':
      api.config.onChanged(listener);
      break;
    case 'logReceived':
      api.logs.onReceived(listener);
      break;
    case 'statsUpdated':
      api.stats.onUpdated(listener);
      break;
    case 'connectionStateChanged':
      api.connection.onStateChanged(listener);
      break;
  }
}

export function removeEventListener(_event: string, _listener: (...args: any[]) => void): void {
  // Electron IPC 的 removeListener 由返回的清理函数处理
  // 这里保留接口兼容性
}
