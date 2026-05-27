/**
 * 日志管理 IPC 处理器
 * 处理日志相关的 IPC 请求
 */

import { IpcMainInvokeEvent, shell } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { LogEntry, LogLevel } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { LogManager } from '../../services/LogManager';
import { ProxyManager } from '../../services/ProxyManager';
import { broadcastEvent } from '../ipc-events';
import { getLogsPath } from '../../utils/paths';

/**
 * 注册日志管理相关的 IPC 处理器
 */
export function registerLogHandlers(logManager: LogManager, proxyManager?: ProxyManager): void {
  // 获取日志
  registerIpcHandler<{ limit?: number }, LogEntry[]>(
    IPC_CHANNELS.LOGS_GET,
    async (_event: IpcMainInvokeEvent, args?: { limit?: number }) => {
      return logManager.getLogs(args?.limit);
    }
  );

  // 清空日志
  registerIpcHandler<void, void>(IPC_CHANNELS.LOGS_CLEAR, async (_event: IpcMainInvokeEvent) => {
    // 清空应用日志（内存和文件）
    logManager.clearLogs();
    
    // 同时清空 sing-box 日志文件
    if (proxyManager) {
      await proxyManager.clearSingBoxLogFile();
    }
  });

  // 设置日志级别
  registerIpcHandler<{ level: LogLevel }, void>(
    IPC_CHANNELS.LOGS_SET_LEVEL,
    async (_event: IpcMainInvokeEvent, args: { level: LogLevel }) => {
      logManager.setLogLevel(args.level);
    }
  );

  // 打开日志文件
  registerIpcHandler<void, void>(
    IPC_CHANNELS.LOGS_OPEN_FOLDER,
    async (_event: IpcMainInvokeEvent) => {
      const path = require('path');
      const logFile = path.join(getLogsPath(), 'app.log');
      const result = await shell.openPath(logFile);
      if (result) {
        // 非空字符串表示打开失败
        throw new Error(`打开日志文件失败: ${result}`);
      }
    }
  );

  // 监听日志事件并广播到所有渲染进程
  logManager.on('log', (log: LogEntry) => {
    broadcastEvent(IPC_CHANNELS.EVENT_LOG_RECEIVED, log);
  });

  console.log('[Log Handlers] Registered all log IPC handlers and event forwarding');
}
