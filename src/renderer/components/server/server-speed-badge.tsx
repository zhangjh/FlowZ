/**
 * 服务器速度标签组件
 * 显示服务器的延迟测试结果
 */

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ServerSpeedResult } from '@/bridge/types';

interface ServerSpeedBadgeProps {
  result?: ServerSpeedResult;
  isLoading?: boolean;
  className?: string;
}

export function ServerSpeedBadge({ result, isLoading, className }: ServerSpeedBadgeProps) {
  if (isLoading) {
    return (
      <Badge variant="secondary" className={cn('animate-pulse', className)}>
        测试中...
      </Badge>
    );
  }

  if (!result) {
    return (
      <Badge variant="outline" className={className}>
        未测试
      </Badge>
    );
  }

  if (result.latency === null) {
    return (
      <Badge variant="destructive" className={className}>
        不可达
      </Badge>
    );
  }

  // 根据延迟设置颜色
  const getLatencyColor = (latency: number): string => {
    if (latency < 100) return 'bg-green-500/20 text-green-700 border-green-500/30';
    if (latency < 200) return 'bg-yellow-500/20 text-yellow-700 border-yellow-500/30';
    if (latency < 500) return 'bg-orange-500/20 text-orange-700 border-orange-500/30';
    return 'bg-red-500/20 text-red-700 border-red-500/30';
  };

  const formatSpeed = (speed: number | null): string => {
    if (speed === null) return '';
    if (speed >= 1024 * 1024) {
      return `${(speed / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    if (speed >= 1024) {
      return `${(speed / 1024).toFixed(1)} KB/s`;
    }
    return `${speed.toFixed(0)} B/s`;
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Badge
        variant="outline"
        className={cn('text-xs', getLatencyColor(result.latency))}
      >
        {result.latency}ms
      </Badge>
      {result.downloadSpeed !== null && (
        <Badge variant="outline" className="text-xs">
          {formatSpeed(result.downloadSpeed)}
        </Badge>
      )}
    </div>
  );
}
