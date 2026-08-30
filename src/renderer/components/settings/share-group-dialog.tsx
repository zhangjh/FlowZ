import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Copy, Check, Layers } from 'lucide-react';
import { generateGroupShareUrl } from '@/bridge/api-wrapper';
import type { ServerGroup } from '@/bridge/types';

interface ShareGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: ServerGroup | null;
}

export function ShareGroupDialog({ open, onOpenChange, group }: ShareGroupDialogProps) {
  const [shareText, setShareText] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open && group) {
      setLoading(true);
      setCopied(false);
      generateGroupShareUrl(group.id)
        .then((response) => {
          if (response.success && response.data) {
            setShareText(response.data);
          } else {
            toast.error(response.error || '生成分组分享失败');
            onOpenChange(false);
          }
        })
        .catch(() => {
          toast.error('生成分组分享失败');
          onOpenChange(false);
        })
        .finally(() => setLoading(false));
    } else {
      setShareText('');
    }
  }, [open, group]);

  const memberCount = shareText ? shareText.split(/\r?\n/).filter(Boolean).length : 0;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      toast.success('组内节点链接已复制到剪贴板');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            分享分组
          </DialogTitle>
          <DialogDescription>
            {group?.name} 的 {memberCount} 个节点。复制后可在其他 FlowZ
            客户端的「订阅导入」中粘贴，批量导入这些节点。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <p className="text-sm text-muted-foreground">生成中...</p>
          </div>
        ) : shareText ? (
          <div className="space-y-3">
            <pre className="max-h-[300px] min-w-0 overflow-auto rounded-md border bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap break-all select-all">
              {shareText}
            </pre>
            <Button onClick={handleCopy} className="w-full">
              {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
              {copied ? '已复制' : '复制全部节点链接'}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
