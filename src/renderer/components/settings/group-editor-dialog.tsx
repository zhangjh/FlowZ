import { useEffect, useMemo, useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Layers, Server, Link } from 'lucide-react';
import type { ServerConfig, ServerGroup } from '@/bridge/types';

interface GroupEditorDialogProps {
  mode?: 'edit' | 'create';
  group: ServerGroup | null;
  servers: ServerConfig[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: {
    name: string;
    addServerIds: string[];
    removeServerIds: string[];
  }) => Promise<void>;
}

export function GroupEditorDialog({
  mode = 'edit',
  group,
  servers,
  open,
  onOpenChange,
  onSave,
}: GroupEditorDialogProps) {
  const isCreate = mode === 'create';
  const [name, setName] = useState('');
  // 勾选后即将加入的节点
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  // 勾选后即将移除的节点
  const [toRemove, setToRemove] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);

  // 打开时初始化本地状态
  useEffect(() => {
    if (open) {
      setName(isCreate ? '' : group?.name || '');
      setToAdd(new Set());
      setToRemove(new Set());
    }
  }, [open, group, isCreate]);

  const memberIds = useMemo(() => new Set(group?.serverIds || []), [group]);

  const members = useMemo(() => servers.filter((s) => memberIds.has(s.id)), [servers, memberIds]);

  const nonMembers = useMemo(
    () => servers.filter((s) => !memberIds.has(s.id)),
    [servers, memberIds]
  );

  // 创建模式下左侧展示全部节点供勾选加入
  const addableServers = isCreate ? servers : nonMembers;

  const memberLabel = (serverId: string): string => {
    const sub = group?.subscriptionServerIds || [];
    return sub.includes(serverId) ? '订阅节点' : '手动加入';
  };

  const toggleAdd = (id: string, checked: boolean) => {
    setToAdd((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleRemove = (id: string, checked: boolean) => {
    setToRemove((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // 创建模式：只要有名称即可创建（可先建空组，稍后再移入节点）
  const hasChanges = isCreate
    ? name.trim() !== ''
    : toAdd.size > 0 || toRemove.size > 0 || (name.trim() !== group?.name && name.trim() !== '');

  const handleSave = async () => {
    if (!group && !isCreate) return;
    if (!name.trim()) {
      toast.error('分组名称不能为空');
      return;
    }
    setIsSaving(true);
    try {
      await onSave({
        name: name.trim(),
        addServerIds: Array.from(toAdd),
        removeServerIds: Array.from(toRemove),
      });
      onOpenChange(false);
    } catch (error) {
      toast.error('保存失败', {
        description: error instanceof Error ? error.message : '保存分组时发生错误',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            {isCreate ? '新建分组' : '管理分组'}
          </DialogTitle>
          <DialogDescription>
            {isCreate
              ? '创建一个新的分组，并勾选已有节点加入（可先建空组稍后再加入节点）'
              : '编辑分组名称、订阅地址并调整成员，一次保存生效'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="group-name">分组名称</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入分组名称"
              autoFocus={isCreate}
            />
          </div>

          {group?.url && (
            <div className="space-y-1">
              <Label>订阅地址</Label>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono text-muted-foreground break-all">
                <Link className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{group.url}</span>
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Server className="h-4 w-4 text-muted-foreground" />
                {isCreate ? '选择要加入的节点' : '未加入本组的节点'}
              </div>
              {addableServers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {isCreate ? '暂无可用节点，可先创建空分组' : '所有节点都已加入本组'}
                </p>
              ) : (
                <ScrollArea className="h-64 rounded-md border p-2">
                  <div className="space-y-1">
                    {addableServers.map((server) => (
                      <label
                        key={server.id}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
                      >
                        <Checkbox
                          checked={toAdd.has(server.id)}
                          onCheckedChange={(checked) => toggleAdd(server.id, !!checked)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{server.name}</div>
                          <div className="text-xs text-muted-foreground font-mono truncate">
                            {server.address}:{server.port}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Layers className="h-4 w-4 text-muted-foreground" />
                当前成员
              </div>
              {members.length === 0 ? (
                <p className="text-sm text-muted-foreground">该分组暂无成员</p>
              ) : (
                <ScrollArea className="h-64 rounded-md border p-2">
                  <div className="space-y-1">
                    {members.map((server) => (
                      <label
                        key={server.id}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
                      >
                        <Checkbox
                          checked={toRemove.has(server.id)}
                          onCheckedChange={(checked) => toggleRemove(server.id, !!checked)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{server.name}</div>
                          <div className="text-xs text-muted-foreground font-mono truncate">
                            {server.address}:{server.port}
                          </div>
                        </div>
                        <Badge variant="outline" className="shrink-0">
                          {memberLabel(server.id)}
                        </Badge>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              )}
              <p className="text-xs text-muted-foreground">
                勾选成员并保存即可将其移除；从订阅分组移除的节点下次刷新时不会自动加回
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!hasChanges || isSaving}>
            {isSaving ? '保存中...' : isCreate ? '创建分组' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
