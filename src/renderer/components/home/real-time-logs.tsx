import { useEffect, useRef, useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppStore } from '@/store/app-store';
import { Trash2, ArrowDown, ArrowDownToLine, Filter } from 'lucide-react';
import { getLogs, clearLogs, addEventListener, removeEventListener } from '@/bridge/api-wrapper';
import type { LogEntry, LogLevel } from '@/bridge/types';

const LOG_ENTRY_HEIGHT = 20;
const MAX_LOGS = 500;
const LOG_LEVELS: { value: LogLevel | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'fatal', label: 'FATAL' },
  { value: 'error', label: 'ERROR' },
  { value: 'warn', label: 'WARN' },
  { value: 'info', label: 'INFO' },
  { value: 'debug', label: 'DEBUG' },
];

function LogRow({ log }: { log: LogEntry }) {
  const timestamp = new Date(log.timestamp).toLocaleTimeString('zh-CN');
  const levelColor = (() => {
    switch (log.level) {
      case 'error': return 'text-red-500';
      case 'warn': return 'text-yellow-500';
      case 'info': return 'text-blue-500';
      case 'debug': return 'text-gray-500';
      default: return 'text-foreground';
    }
  })();

  return (
    <div className="text-xs font-mono select-text" style={{ height: LOG_ENTRY_HEIGHT }}>
      <span className="text-muted-foreground">[{timestamp}]</span>
      <span className={`ml-2 font-semibold ${levelColor}`}>
        {log.level.toUpperCase()}:
      </span>
      <span className="ml-2 truncate">{log.message}</span>
    </div>
  );
}

export function RealTimeLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isAutoScroll, setIsAutoScroll] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const isAutoScrollRef = useRef(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const connectionStatus = useAppStore((state) => state.connectionStatus);

  const filteredLogs = useMemo(() => {
    if (levelFilter === 'all') return logs;
    return logs.filter((log) => log.level === levelFilter);
  }, [logs, levelFilter]);

  const getScrollElement = useCallback((): HTMLElement | null => {
    return scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]') ?? null;
  }, []);

  const virtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement,
    estimateSize: () => LOG_ENTRY_HEIGHT,
    overscan: 10,
  });

  useEffect(() => {
    const loadInitialLogs = async () => {
      try {
        const response = await getLogs(500);
        if (response && response.success && response.data) {
          setLogs(response.data);
        }
      } catch (error) {
        console.error('Failed to load initial logs:', error);
      }
    };

    loadInitialLogs();

    const handleLogReceived = (logEntry: LogEntry) => {
      setLogs((prev) => {
        const next = [...prev, logEntry];
        return next.slice(-MAX_LOGS);
      });
    };

    addEventListener('logReceived', handleLogReceived);
    return () => removeEventListener('logReceived', handleLogReceived);
  }, []);

  const prevTotalSize = useRef(0);
  useLayoutEffect(() => {
    const el = getScrollElement();
    if (!el || filteredLogs.length === 0) return;

    if (isAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      const totalSize = filteredLogs.length * LOG_ENTRY_HEIGHT;
      const removed = totalSize - prevTotalSize.current;
      if (removed > 0) {
        const overflow = totalSize - el.scrollTop - el.clientHeight;
        if (overflow < LOG_ENTRY_HEIGHT * 2) {
          el.scrollTop = el.scrollHeight;
        }
      }
    }
    prevTotalSize.current = filteredLogs.length * LOG_ENTRY_HEIGHT;
  }, [filteredLogs, getScrollElement]);

  const handleToggleAutoScroll = () => {
    const next = !isAutoScrollRef.current;
    isAutoScrollRef.current = next;
    setIsAutoScroll(next);
    if (next) {
      const el = getScrollElement();
      if (el) el.scrollTop = el.scrollHeight;
    }
  };

  const handleClearLogs = async () => {
    try {
      const success = await clearLogs();
      if (success) setLogs([]);
    } catch {
      setLogs([]);
    }
  };

  const handleScrollToBottom = () => {
    const el = getScrollElement();
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>实时日志</CardTitle>
          <div className="flex items-center gap-2">
            <Select value={levelFilter} onValueChange={(v) => setLevelFilter(v as LogLevel | 'all')}>
              <SelectTrigger className="w-[110px] h-8 text-xs">
                <Filter className="h-3 w-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_LEVELS.map((level) => (
                  <SelectItem key={level.value} value={level.value} className="text-xs">
                    {level.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={isAutoScroll ? 'default' : 'outline'}
              size="sm"
              onClick={handleToggleAutoScroll}
            >
              <ArrowDownToLine className="h-4 w-4 mr-1" />
              {isAutoScroll ? '自动滚动开' : '自动滚动关'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearLogs}
              disabled={logs.length === 0}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              清空
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea
          ref={scrollAreaRef}
          className="h-64 w-full rounded border bg-muted/30"
        >
          {filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-3">
              {connectionStatus?.proxyCore?.running ? '等待日志输出...' : '请先启动代理服务'}
            </div>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
                padding: '12px',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => (
                <div
                  key={virtualItem.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <LogRow log={filteredLogs[virtualItem.index]} />
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {!isAutoScroll && (
          <div className="mt-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleScrollToBottom}
              className="text-xs h-7"
            >
              <ArrowDown className="h-3 w-3 mr-1" />
              跳到底部
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
