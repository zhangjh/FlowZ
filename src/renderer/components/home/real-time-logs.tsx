import { useEffect, useRef, useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppStore } from '@/store/app-store';
import { cn } from '@/lib/utils';
import { Trash2, ArrowDown, ArrowDownToLine, Filter, Search, X } from 'lucide-react';
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

type SourceFilter = 'all' | 'proxy' | 'direct';

const SOURCE_FILTERS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'proxy', label: '代理' },
  { value: 'direct', label: '直连' },
];

const SOURCE_PATTERNS: Record<Exclude<SourceFilter, 'all'>, RegExp> = {
  proxy: /\bproxy\b/i,
  direct: /\bdirect\b/i,
};

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
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const isAutoScrollRef = useRef(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const connectionStatus = useAppStore((state) => state.connectionStatus);

  const filteredLogs = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    const sourcePattern = sourceFilter === 'all' ? null : SOURCE_PATTERNS[sourceFilter];

    return logs.filter((log) => {
      if (levelFilter !== 'all' && log.level !== levelFilter) return false;
      if (sourcePattern && !sourcePattern.test(log.message)) return false;
      if (keyword && !log.message.toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [logs, levelFilter, sourceFilter, searchQuery]);

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

    // 轮询兜底：每 2 秒拉取新日志，防止事件丢失导致不更新
    let lastCount = 0;
    const pollTimer = setInterval(async () => {
      try {
        const response = await getLogs(500);
        if (response && response.success && response.data) {
          const logs = response.data as LogEntry[];
          if (logs.length !== lastCount) {
            lastCount = logs.length;
            setLogs(logs.slice(-MAX_LOGS));
          }
        }
      } catch {
        // 忽略轮询错误
      }
    }, 2000);

    return () => {
      removeEventListener('logReceived', handleLogReceived);
      clearInterval(pollTimer);
    };
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

  const handleResetFilters = () => {
    setLevelFilter('all');
    setSourceFilter('all');
    setSearchQuery('');
  };

  const handleScrollToBottom = () => {
    const el = getScrollElement();
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <CardTitle>实时日志</CardTitle>
            <span className="text-xs text-muted-foreground">
              {filteredLogs.length}/{logs.length} 条
            </span>
          </div>
          <div className="flex items-center gap-2">
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
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="日志类型筛选"
            className="flex items-center rounded-md border bg-muted/40 p-0.5"
          >
            {SOURCE_FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={sourceFilter === item.value}
                onClick={() => setSourceFilter(item.value)}
                className={cn(
                  'h-7 rounded px-3 text-xs transition-colors',
                  sourceFilter === item.value
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
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
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索日志关键词"
              aria-label="搜索日志关键词"
              className="h-8 pl-8 pr-8 text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea
          ref={scrollAreaRef}
          className="h-64 w-full rounded border bg-muted/30"
        >
          {filteredLogs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-muted-foreground text-sm">
              {logs.length === 0 ? (
                <span>
                  {connectionStatus?.proxyCore?.running ? '等待日志输出...' : '请先启动代理服务'}
                </span>
              ) : (
                <>
                  <span>没有匹配的日志</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs h-7"
                    onClick={handleResetFilters}
                  >
                    清除筛选
                  </Button>
                </>
              )}
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
