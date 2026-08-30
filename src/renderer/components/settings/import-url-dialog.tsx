import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Link, ListPlus, Server } from 'lucide-react';
import {
  parseProtocolUrl,
  addServerFromUrl,
  parseSubscriptionUrl,
  addSubscription,
} from '@/bridge/api-wrapper';
import type { ServerConfig } from '@/bridge/types';

interface ImportUrlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSuccess?: () => void;
}

type ImportMode = 'single' | 'subscription';

/** 判断一段文本里是否可能包含订阅（多行协议链接或订阅 URL） */
function isSubscriptionInput(value: string): boolean {
  const lines = value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 超过 1 个有效行 → 多行订阅
  if (lines.length > 1) return true;
  // 单行 http/https 订阅链接
  if (lines.length === 1 && /^https?:\/\//i.test(lines[0])) return true;
  // base64 订阅（无换行、无协议前缀，但看起来像 base64）
  if (lines.length === 1 && /^[A-Za-z0-9+/=]+$/.test(lines[0]) && lines[0].length >= 16) {
    return true;
  }
  return false;
}

export function ImportUrlDialog({ open, onOpenChange, onImportSuccess }: ImportUrlDialogProps) {
  const [mode, setMode] = useState<ImportMode>('single');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');

  // 订阅模式状态
  const [subInput, setSubInput] = useState('');
  const [parsedServers, setParsedServers] = useState<ServerConfig[] | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // 单条解析状态（兼容旧逻辑）
  const [parsedConfig, setParsedConfig] = useState<ServerConfig | null>(null);

  const reset = () => {
    setUrl('');
    setName('');
    setParsedConfig(null);
    setSubInput('');
    setParsedServers(null);
    setIsParsing(false);
    setIsImporting(false);
  };

  const handleModeChange = (m: ImportMode) => {
    setMode(m);
    // 清理另一模式的临时状态，避免串扰
    if (m === 'subscription') {
      setParsedConfig(null);
    } else {
      setParsedServers(null);
    }
  };

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  // ==================== 单个服务器 ====================

  const isValidUrl = (value: string) => {
    return (
      value.startsWith('vless://') ||
      value.startsWith('trojan://') ||
      value.startsWith('hysteria2://') ||
      value.startsWith('hy2://')
    );
  };

  const handleParseUrl = async () => {
    if (!url.trim()) {
      toast.error('请输入协议URL');
      return;
    }

    setIsParsing(true);
    try {
      const response = await parseProtocolUrl(url.trim());
      if (response && response.success && response.data) {
        setParsedConfig(response.data as any);

        if (!name.trim()) {
          const protocol = response.data.protocol.toUpperCase();
          const address = response.data.address;
          setName(`${protocol} - ${address}`);
        }

        toast.success('URL解析成功');
      } else {
        toast.error(response?.error || 'URL解析失败');
        setParsedConfig(null);
      }
    } catch (error) {
      console.error('Parse URL error:', error);
      toast.error('URL解析失败');
      setParsedConfig(null);
    } finally {
      setIsParsing(false);
    }
  };

  const handleImportSingle = async () => {
    if (!parsedConfig || !name.trim()) {
      toast.error('请先解析URL并输入服务器名称');
      return;
    }

    setIsImporting(true);
    try {
      const response = await addServerFromUrl(url.trim(), name.trim());
      if (response && response.success) {
        onImportSuccess?.();
        handleClose();
      } else {
        toast.error(response?.error || '导入服务器失败');
      }
    } catch (error) {
      console.error('Import server error:', error);
      toast.error('导入服务器失败');
    } finally {
      setIsImporting(false);
    }
  };

  // ==================== 订阅导入 ====================

  const handleParseSubscription = async () => {
    const value = subInput.trim();
    if (!value) {
      toast.error('请输入订阅内容或订阅URL');
      return;
    }

    setIsParsing(true);
    setParsedServers(null);
    try {
      // 单行 URL → 作为订阅地址拉取；否则作为文本内容解析
      const input = /^https?:\/\//i.test(value) ? { url: value } : { content: value };
      const response = await parseSubscriptionUrl(input);
      if (response && response.success && response.data) {
        setParsedServers(response.data);
        toast.success(`解析到 ${response.data.length} 个服务器`);
      } else {
        toast.error(response?.error || '订阅解析失败');
      }
    } catch (error) {
      console.error('Parse subscription error:', error);
      toast.error('订阅解析失败');
    } finally {
      setIsParsing(false);
    }
  };

  const handleImportSubscription = async () => {
    const value = subInput.trim();
    if (!parsedServers || parsedServers.length === 0 || !value) {
      toast.error('请先解析订阅');
      return;
    }

    setIsImporting(true);
    try {
      const isUrl = /^https?:\/\//i.test(value);
      // 复用解析结果直接导入（避免二次拉取/解析导致前后不一致），
      // 订阅 URL 场景仍保留 URL 以复用同名分组
      const input = isUrl
        ? { servers: parsedServers, url: value }
        : { servers: parsedServers };
      const response = await addSubscription(input);
      if (response && response.success && response.data) {
        const { group } = response.data;
        toast.success('订阅导入成功', {
          description: group ? `已创建分组 "${group.name}" 并自动启用组内故障转移` : undefined,
        });
        onImportSuccess?.();
        handleClose();
      } else {
        toast.error(response?.error || '订阅导入失败');
      }
    } catch (error) {
      console.error('Import subscription error:', error);
      toast.error('订阅导入失败');
    } finally {
      setIsImporting(false);
    }
  };

  const handleInputChange = (value: string) => {
    setSubInput(value);
    setParsedServers(null);
    // 根据输入内容自动选择模式（仅当内容变化时）
    if (value.trim()) {
      setMode(isSubscriptionInput(value) ? 'subscription' : 'single');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : handleClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-5 w-5" />
            导入服务器
          </DialogTitle>
          <DialogDescription>
            支持导入 vless://、trojan://、hysteria2:// 和 hy2:// 协议链接，以及多节点订阅
          </DialogDescription>
        </DialogHeader>

        {/* 模式切换 */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={mode === 'single' ? 'default' : 'outline'}
            onClick={() => handleModeChange('single')}
            className="justify-start"
          >
            <Server className="h-4 w-4 mr-2" />
            单个服务器
          </Button>
          <Button
            type="button"
            variant={mode === 'subscription' ? 'default' : 'outline'}
            onClick={() => handleModeChange('subscription')}
            className="justify-start"
          >
            <ListPlus className="h-4 w-4 mr-2" />
            订阅导入
          </Button>
        </div>

        {mode === 'single' ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="protocol-url">协议URL</Label>
              <div className="flex gap-2">
                <Textarea
                  id="protocol-url"
                  placeholder="vless://uuid@server:port?encryption=none&security=tls&type=ws&host=example.com&path=/path#name"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="min-h-[80px] resize-none"
                />
                <Button
                  onClick={handleParseUrl}
                  disabled={!url.trim() || !isValidUrl(url.trim()) || isParsing}
                  className="shrink-0"
                >
                  {isParsing ? <Loader2 className="h-4 w-4 animate-spin" /> : '解析'}
                </Button>
              </div>
              {url.trim() && !isValidUrl(url.trim()) && (
                <p className="text-sm text-destructive">
                  请输入有效的 vless://、trojan://、hysteria2:// 或 hy2:// 协议链接
                </p>
              )}
            </div>

            {parsedConfig && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Server className="h-4 w-4" />
                    解析结果
                  </CardTitle>
                  <CardDescription>URL解析成功，请确认配置信息</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">协议:</span>
                      <Badge variant="outline" className="ml-2">
                        {parsedConfig.protocol}
                      </Badge>
                    </div>
                    <div>
                      <span className="text-muted-foreground">地址:</span>
                      <span className="ml-2 font-mono">
                        {parsedConfig.address}:{parsedConfig.port}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">传输:</span>
                      <span className="ml-2">{parsedConfig.network}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">加密:</span>
                      <span className="ml-2">{parsedConfig.security}</span>
                    </div>
                    {parsedConfig.protocol === 'vless' && parsedConfig.uuid && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">UUID:</span>
                        <span className="ml-2 font-mono text-xs">{parsedConfig.uuid}</span>
                      </div>
                    )}
                    {parsedConfig.protocol === 'trojan' && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">密码:</span>
                        <span className="ml-2">••••••••</span>
                      </div>
                    )}
                    {parsedConfig.protocol === 'hysteria2' && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">密码:</span>
                        <span className="ml-2">••••••••</span>
                      </div>
                    )}
                    {parsedConfig.wsSettings?.path && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">WebSocket路径:</span>
                        <span className="ml-2 font-mono">{parsedConfig.wsSettings.path}</span>
                      </div>
                    )}
                    {parsedConfig.tlsSettings?.serverName && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">TLS服务器名:</span>
                        <span className="ml-2">{parsedConfig.tlsSettings.serverName}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {parsedConfig && (
              <div className="space-y-2">
                <Label htmlFor="server-name">服务器名称</Label>
                <Input
                  id="server-name"
                  placeholder="输入服务器名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="subscription-input">订阅内容或订阅URL</Label>
              <div className="flex gap-2">
                <Textarea
                  id="subscription-input"
                  placeholder={
                    '订阅URL:  https://example.com/sub?token=xxx\n' +
                    '或直接粘贴多行协议链接:\n' +
                    'vless://uuid1@server1:443?...\n' +
                    'vless://uuid2@server2:443?...'
                  }
                  value={subInput}
                  onChange={(e) => handleInputChange(e.target.value)}
                  className="min-h-[120px] resize-none font-mono text-xs"
                />
                <Button
                  onClick={handleParseSubscription}
                  disabled={!subInput.trim() || isParsing}
                  className="shrink-0"
                >
                  {isParsing ? <Loader2 className="h-4 w-4 animate-spin" /> : '解析'}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                支持订阅 URL（自动 base64 解码）或直接粘贴多行协议链接
              </p>
            </div>

            {parsedServers && parsedServers.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <ListPlus className="h-4 w-4" />
                    解析到 {parsedServers.length} 个服务器
                  </CardTitle>
                  <CardDescription>确认后点击下方按钮批量导入</CardDescription>
                </CardHeader>
                <CardContent className="max-h-[220px] overflow-y-auto space-y-2">
                  {parsedServers.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge variant="outline" className="shrink-0">
                          {s.protocol}
                        </Badge>
                        <span className="truncate">{s.name}</span>
                      </div>
                      <span className="ml-2 font-mono text-xs text-muted-foreground shrink-0">
                        {s.address}:{s.port}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            取消
          </Button>
          {mode === 'single' ? (
            <Button
              onClick={handleImportSingle}
              disabled={!parsedConfig || !name.trim() || isImporting}
            >
              {isImporting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  导入中...
                </>
              ) : (
                '导入服务器'
              )}
            </Button>
          ) : (
            <Button
              onClick={handleImportSubscription}
              disabled={!parsedServers || parsedServers.length === 0 || isImporting}
            >
              {isImporting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  导入中...
                </>
              ) : (
                `导入 ${parsedServers?.length ?? 0} 个服务器`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
