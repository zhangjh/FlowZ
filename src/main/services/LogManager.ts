import { EventEmitter } from 'events';
import type { LogEntry, LogLevel } from '../../shared/types';

export interface ILogManager {
  addLog(level: LogLevel, message: string, source: string, stack?: string): void;
  getLogs(limit?: number): LogEntry[];
  clearLogs(): void;
  setLogLevel(level: LogLevel): void;
  getLogLevel(): LogLevel;
  on(event: 'log', listener: (log: LogEntry) => void): void;
  off(event: 'log', listener: (log: LogEntry) => void): void;
}

export class LogManager extends EventEmitter implements ILogManager {
  private ring: LogEntry[] = [];
  private maxLogs = 1000;
  private writeIndex = 0;
  private count = 0;
  private currentLogLevel: LogLevel = 'info';
  private logLevelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
  };

  setLogLevel(level: LogLevel): void {
    this.currentLogLevel = level;
  }

  getLogLevel(): LogLevel {
    return this.currentLogLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.logLevelPriority[level] >= this.logLevelPriority[this.currentLogLevel];
  }

  addLog(level: LogLevel, message: string, source: string, stack?: string): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      source,
      stack,
    };

    this.ring[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % this.maxLogs;
    if (this.count < this.maxLogs) this.count++;

    this.emit('log', entry);
  }

  getLogs(limit?: number): LogEntry[] {
    const total = this.count;
    if (total === 0) return [];
    const take = limit !== undefined && limit > 0 ? Math.min(limit, total) : total;
    const result: LogEntry[] = new Array(take);
    const start = (this.writeIndex - take + this.maxLogs) % this.maxLogs;
    for (let i = 0; i < take; i++) {
      const idx = (start + i) % this.maxLogs;
      const entry = this.ring[idx];
      if (entry) result[i] = entry;
    }
    return result;
  }

  clearLogs(): void {
    this.ring = [];
    this.writeIndex = 0;
    this.count = 0;
  }
}
