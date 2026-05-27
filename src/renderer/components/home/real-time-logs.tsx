import { useEffect, useRef, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAppStore } from '@/store/app-store';
import { Trash2, ArrowDown, ArrowDownToLine, FolderOpen } from 'lucide-react';
import { getLogs, clearLogs, openLogFolder, addEventListener, removeEventListener } from '@/bridge/api-wrapper';
import type { LogEntry } from '@/bridge/types';

export function RealTimeLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isAutoScroll, setIsAutoScroll] = useState(false);
  const isAutoScrollRef = useRef(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const connectionStatus = useAppStore((state) => state.connectionStatus);

  const getScrollElement = useCallback((): HTMLElement | null => {
    return scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]') ?? null;
  }, []);

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
      setLogs((prev) => [...prev, logEntry].slice(-500));
    };

    addEventListener('logReceived', handleLogReceived);
    return () => removeEventListener('logReceived', handleLogReceived);
  }, []);

  // 新日志到来时，只有开启了自动滚动才滚到底部
  useEffect(() => {
    if (isAutoScrollRef.current) {
      const el = getScrollElement();
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [logs, getScrollElement]);

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

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error': return 'text-red-500';
      case 'warn': return 'text-yellow-500';
      case 'info': return 'text-blue-500';
      case 'debug': return 'text-gray-500';
      default: return 'text-foreground';
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>实时日志</CardTitle>
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
              onClick={openLogFolder}
              title="用记事本打开 app.log 查看历史日志"
            >
              <FolderOpen className="h-4 w-4 mr-1" />
              本地日志
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
          className="h-64 w-full rounded border bg-muted/30 p-3"
        >
          {logs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              {connectionStatus?.proxyCore?.running ? '等待日志输出...' : '请先启动代理服务'}
            </div>
          ) : (
            <div className="space-y-1 select-text cursor-text">
              {logs.map((log, index) => {
                const timestamp = new Date(log.timestamp).toLocaleTimeString('zh-CN');
                return (
                  <div key={index} className="text-xs font-mono select-text">
                    <span className="text-muted-foreground">[{timestamp}]</span>
                    <span className={`ml-2 font-semibold ${getLevelColor(log.level)}`}>
                      {log.level.toUpperCase()}:
                    </span>
                    <span className="ml-2">{log.message}</span>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {!isAutoScroll && (
          <div className="mt-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const el = getScrollElement();
                if (el) el.scrollTop = el.scrollHeight;
              }}
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
