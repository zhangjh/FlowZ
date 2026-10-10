import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

export interface SpeedTestResultItem {
  name: string;
  protocol: string;
  latency: number | null;
}

interface SpeedTestResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  results: SpeedTestResultItem[];
}

/**
 * 测速结果弹窗（常驻，需手动关闭）
 * 托盘/服务器页面测速完成后显示，支持滚动查看
 */
export function SpeedTestResultDialog({ open, onOpenChange, results }: SpeedTestResultDialogProps) {
  // 按延迟排序：有延迟的在前（从小到大），超时的在后
  const sorted = [...results].sort((a, b) => {
    if (a.latency === null) return 1;
    if (b.latency === null) return -1;
    return a.latency - b.latency;
  });

  const okCount = results.filter((r) => r.latency !== null).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            测速结果（{okCount}/{results.length} 可用）
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[400px] pr-4">
          <div className="space-y-2">
            {sorted.map((r, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between py-1.5 border-b border-muted last:border-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{r.name}</div>
                  <div className="text-xs text-muted-foreground">{r.protocol}</div>
                </div>
                <div
                  className={`text-sm font-mono ml-4 ${
                    r.latency === null
                      ? 'text-muted-foreground'
                      : r.latency < 200
                        ? 'text-green-600'
                        : r.latency < 500
                          ? 'text-yellow-600'
                          : 'text-red-600'
                  }`}
                >
                  {r.latency === null ? '超时' : `${r.latency}ms`}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
