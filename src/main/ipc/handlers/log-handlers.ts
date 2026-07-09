import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { LogEntry, LogLevel } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { LogManager } from '../../services/LogManager';
import { ProxyManager } from '../../services/ProxyManager';
import { broadcastEvent } from '../ipc-events';

export function registerLogHandlers(logManager: LogManager, proxyManager?: ProxyManager): void {
  registerIpcHandler<{ limit?: number }, LogEntry[]>(
    IPC_CHANNELS.LOGS_GET,
    async (_event: IpcMainInvokeEvent, args?: { limit?: number }) => {
      return logManager.getLogs(args?.limit);
    }
  );

  registerIpcHandler<void, void>(IPC_CHANNELS.LOGS_CLEAR, async (_event: IpcMainInvokeEvent) => {
    logManager.clearLogs();
    if (proxyManager) {
      await proxyManager.clearSingBoxLogFile();
    }
  });

  registerIpcHandler<{ level: LogLevel }, void>(
    IPC_CHANNELS.LOGS_SET_LEVEL,
    async (_event: IpcMainInvokeEvent, args: { level: LogLevel }) => {
      logManager.setLogLevel(args.level);
    }
  );

  logManager.on('log', (log: LogEntry) => {
    broadcastEvent(IPC_CHANNELS.EVENT_LOG_RECEIVED, log);
  });

  console.log('[Log Handlers] Registered all log IPC handlers and event forwarding');
}
