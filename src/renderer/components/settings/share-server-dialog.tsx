import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Copy, Check } from 'lucide-react';
import { generateShareUrl } from '@/bridge/api-wrapper';
import type { ServerConfig } from '@/bridge/types';

interface ShareServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: ServerConfig | null;
}

export function ShareServerDialog({ open, onOpenChange, server }: ShareServerDialogProps) {
  const [shareUrl, setShareUrl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open && server) {
      setLoading(true);
      setCopied(false);
      generateShareUrl(server)
        .then((response) => {
          if (response.success && response.data) {
            setShareUrl(response.data);
          } else {
            toast.error(response.error || '生成分享链接失败');
            onOpenChange(false);
          }
        })
        .catch(() => {
          toast.error('生成分享链接失败');
          onOpenChange(false);
        })
        .finally(() => setLoading(false));
    } else {
      setShareUrl('');
    }
  }, [open, server]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success('链接已复制到剪贴板');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>分享服务器</DialogTitle>
          <DialogDescription>
            扫描二维码或复制链接分享 {server?.name} 的配置
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-muted-foreground">生成中...</p>
          </div>
        ) : shareUrl ? (
          <div className="flex flex-col items-center gap-4 overflow-hidden">
            <div className="rounded-lg border bg-white p-3">
              <QRCodeSVG value={shareUrl} size={180} />
            </div>

            <div className="flex w-full min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-3 py-2 text-xs select-all">
                {shareUrl}
              </code>
              <Button variant="outline" size="sm" className="shrink-0" onClick={handleCopy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
