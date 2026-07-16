/**
 * 自动选择 IPC 处理器
 * 处理自动选择相关的 IPC 请求
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { registerIpcHandler } from '../ipc-handler';
import type { AutoSelectService } from '../../services/AutoSelectService';
import type { ConfigManager } from '../../services/ConfigManager';

/**
 * 注册自动选择相关的 IPC 处理器
 */
export function registerAutoSelectHandlers(
  autoSelectService: AutoSelectService,
  configManager: ConfigManager
): void {
  // 获取自动选择状态
  registerIpcHandler<void, any>(
    IPC_CHANNELS.AUTO_SELECT_GET_STATUS,
    async (_event: IpcMainInvokeEvent) => {
      return autoSelectService.getStatus();
    }
  );

  // 测试服务器速度
  registerIpcHandler<{ serverIds?: string[] }, any[]>(
    IPC_CHANNELS.AUTO_SELECT_TEST_SERVERS,
    async (_event: IpcMainInvokeEvent, args) => {
      // 获取当前配置
      const config = await configManager.loadConfig();
      const servers = config?.servers ?? [];

      // 如果指定了服务器ID，只测试这些服务器
      const serversToTest = args?.serverIds
        ? servers.filter((s) => args.serverIds!.includes(s.id))
        : servers;

      return autoSelectService.testAllServers(serversToTest);
    }
  );

  // 获取最佳服务器
  registerIpcHandler<void, any>(
    IPC_CHANNELS.AUTO_SELECT_GET_BEST_SERVER,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      const servers = config?.servers ?? [];
      return autoSelectService.getBestServer(servers);
    }
  );

  // 立即触发故障转移（渲染进程检测到请求失败时调用）
  registerIpcHandler<void, void>(
    IPC_CHANNELS.AUTO_SELECT_TRIGGER_FAILOVER,
    async (_event: IpcMainInvokeEvent) => {
      await autoSelectService.triggerImmediateFailover();
    }
  );

  console.log('[AutoSelect Handlers] Registered all auto-select IPC handlers');
}
