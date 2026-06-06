import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
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
  const scrollAdjustmentRef = useRef(0);
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
      setLogs((prev) => {
        const next = [...prev, logEntry];
        // 当自动滚动关闭且需要裁剪旧日志时，累计被移除日志的高度用于补偿滚动偏移
        if (!isAutoScrollRef.current && next.length > 500) {
          const removedCount = next.length - 500;
          const el = getScrollElement();
          if (el) {
            let totalHeight = 0;
            const container = el.querySelector('.space-y-1');
            if (container) {
              const children = Array.from(container.children);
              for (let i = 0; i < removedCount && i < children.length; i++) {
                totalHeight += (children[i] as HTMLElement).offsetHeight;
              }
            }
            scrollAdjustmentRef.current += totalHeight;
          }
        }
        return next.slice(-500);
      });
    };

    addEventListener('logReceived', handleLogReceived);
    return () => removeEventListener('logReceived', handleLogReceived);
  }, []);

  // 使用 useLayoutEffect 在浏览器绘制前调整滚动位置
  useLayoutEffect(() => {
    const el = getScrollElement();
    if (!el) return;

    if (isAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (scrollAdjustmentRef.current > 0) {
      // 补偿 .slice(-500) 移除首条日志导致的视窗偏移
      el.scrollTop = Math.max(0, el.scrollTop - scrollAdjustmentRef.current);
      scrollAdjustmentRef.current = 0;
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
