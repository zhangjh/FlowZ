import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/store/app-store';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { ServerGroup } from '@/bridge/types';

export function ConnectionStatusCard() {
  const connectionStatus = useAppStore((state) => state.connectionStatus);
  const config = useAppStore((state) => state.config);
  const error = useAppStore((state) => state.error);
  const isLoading = useAppStore((state) => state.isLoading);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const setCurrentView = useAppStore((state) => state.setCurrentView);

  const servers = config?.servers || [];
  const selectedServerId = config?.selectedServerId;
  const selectedServer = servers.find((s) => s.id === selectedServerId);

  const groups = config?.serverGroups || [];
  const selectedGroupId = config?.selectedGroupId;
  const selectedGroup = selectedGroupId
    ? groups.find((g) => g.id === selectedGroupId)
    : undefined;

  const groupNodeCount = (group: ServerGroup) =>
    group.serverIds.filter((id) => servers.some((s) => s.id === id)).length;

  // 已属于任何分组的节点 ID
  const groupedIds = new Set<string>();
  for (const g of groups) for (const id of g.serverIds) groupedIds.add(id);
  // 出站下拉只展示分组 + 未分组节点（分组内的节点由分组统一管理）
  const ungroupedServers = servers.filter((s) => !groupedIds.has(s.id));

  const outboundOptions = (
    <>
      {groups.map((group) => (
        <SelectItem key={`group:${group.id}`} value={`group:${group.id}`}>
          分组 · {group.name}（{groupNodeCount(group)}节点）
        </SelectItem>
      ))}
      {ungroupedServers.map((server) => (
        <SelectItem key={server.id} value={server.id}>
          {server.name} ({server.protocol})
        </SelectItem>
      ))}
    </>
  );

  const getStatusInfo = () => {
    const proxyModeType = config?.proxyModeType || connectionStatus?.proxyModeType || 'systemProxy';
    const isTunMode = proxyModeType === 'tun';
    const modeText = isTunMode ? 'TUN模式' : '系统代理模式';

    // Show error from store if present
    if (error) {
      return {
        label: '错误',
        variant: 'destructive' as const,
        description: error,
        mode: modeText,
      };
    }

    if (!connectionStatus) {
      return {
        label: '未知',
        variant: 'secondary' as const,
        description: '正在获取状态...',
        mode: modeText,
      };
    }

    const { proxyCore, proxy } = connectionStatus;

    // Handle proxy core errors with more specific messages
    if (proxyCore.error) {
      // Parse TUN mode specific errors
      let errorDescription = proxyCore.error;

      if (proxyCore.error.includes('权限不足') || proxyCore.error.includes('管理员权限')) {
        errorDescription = 'TUN模式需要管理员权限，请以管理员身份运行应用';
      } else if (proxyCore.error.includes('wintun') || proxyCore.error.includes('驱动')) {
        errorDescription = 'TUN驱动加载失败，请检查wintun.dll是否存在';
      } else if (proxyCore.error.includes('接口创建失败')) {
        errorDescription = 'TUN接口创建失败，请检查系统网络设置';
      } else if (proxyCore.error.includes('sing-box.exe')) {
        errorDescription = 'sing-box核心文件缺失或无法启动';
      }

      return {
        label: '错误',
        variant: 'destructive' as const,
        description: errorDescription,
        mode: modeText,
      };
    }

    // TUN模式下，只需要检查代理核心是否运行
    if (isTunMode) {
      if (proxyCore.running) {
        const uptime = proxyCore.uptime
          ? `运行时间: ${Math.floor(proxyCore.uptime / 60)} 分钟`
          : '';
        return {
          label: '已连接',
          variant: 'default' as const,
          description: `TUN模式已连接${uptime ? ' - ' + uptime : ''}`,
          mode: modeText,
        };
      }

      if (isLoading) {
        return {
          label: '连接中',
          variant: 'secondary' as const,
          description: '正在启动 TUN 模式...',
          mode: modeText,
        };
      }

      return {
        label: '已断开',
        variant: 'outline' as const,
        description: 'TUN模式未启用',
        mode: modeText,
      };
    }

    // 系统代理模式下，需要检查代理核心和系统代理
    if (proxyCore.running && proxy.enabled) {
      const uptime = proxyCore.uptime ? `运行时间: ${Math.floor(proxyCore.uptime / 60)} 分钟` : '';
      return {
        label: '已连接',
        variant: 'default' as const,
        description: `系统代理已连接${uptime ? ' - ' + uptime : ''}`,
        mode: modeText,
      };
    }

    if (proxyCore.running && !proxy.enabled) {
      return {
        label: '连接中',
        variant: 'secondary' as const,
        description: 'sing-box 运行中，正在启用系统代理...',
        mode: modeText,
      };
    }

    if (isLoading) {
      return {
        label: '连接中',
        variant: 'secondary' as const,
        description: '正在启动 sing-box 进程...',
        mode: modeText,
      };
    }

    return {
      label: '已断开',
      variant: 'outline' as const,
      description: '代理未启用',
      mode: modeText,
    };
  };

  const handleServerChange = async (value: string) => {
    if (!config) return;

    try {
      if (value.startsWith('group:')) {
        const groupId = value.slice('group:'.length);
        const group = groups.find((g) => g.id === groupId);
        if (!group || group.serverIds.length === 0) {
          toast.error('分组无效', { description: '分组不存在或没有成员服务器' });
          return;
        }
        const updatedConfig = {
          ...config,
          selectedGroupId: groupId,
          selectedServerId: null,
        };
        await saveConfig(updatedConfig);
        toast.success('分组已切换，启用组内自动故障转移');
      } else {
        const updatedConfig = {
          ...config,
          selectedServerId: value,
          selectedGroupId: null,
        };
        await saveConfig(updatedConfig);
        toast.success('服务器已切换');
      }
    } catch (error) {
      toast.error('切换失败', {
        description: error instanceof Error ? error.message : '切换时发生错误',
      });
    }
  };

  const handleGoToServers = () => {
    setCurrentView('server');
  };

  const statusInfo = getStatusInfo();

  return (
    <Card>
      <CardHeader>
        <CardTitle>连接状态</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">状态</span>
          <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">代理模式</span>
          <Badge variant="secondary">{statusInfo.mode}</Badge>
        </div>

        {/* 服务器选择区域 */}
        {servers.length === 0 ? (
          <div className="space-y-3">
            <div className="p-4 border border-dashed border-muted-foreground/25 rounded-lg text-center">
              <p className="text-sm text-muted-foreground mb-3">暂无服务器配置</p>
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGoToServers}
                  className="flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  添加服务器
                </Button>
              </div>
            </div>
          </div>
        ) : selectedGroup ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <span className="text-sm text-muted-foreground">当前出站</span>
              <Select
                value={selectedGroupId ? `group:${selectedGroupId}` : undefined}
                onValueChange={handleServerChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择出站" />
                </SelectTrigger>
                <SelectContent>{outboundOptions}</SelectContent>
              </Select>
            </div>

            {/* 分组详细信息 */}
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">分组</span>
                <Badge variant="outline" className="text-xs">
                  {selectedGroup.name}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">节点数</span>
                <span className="text-sm font-medium">{groupNodeCount(selectedGroup)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">模式</span>
                <span className="text-sm font-medium">自动故障转移（urltest）</span>
              </div>
            </div>
          </div>
        ) : !selectedServer ? (
          <div className="space-y-3">
            <div className="p-4 border border-yellow-500/50 bg-yellow-500/10 rounded-lg">
              <p className="text-sm text-yellow-600 dark:text-yellow-400 mb-3">
                ⚠️ 请选择一个服务器或分组以启用代理
              </p>
              <Select onValueChange={handleServerChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择服务器或分组" />
                </SelectTrigger>
                <SelectContent>{outboundOptions}</SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 出站切换 */}
            <div className="space-y-2">
              <div className="space-y-2">
                <span className="text-sm text-muted-foreground">当前服务器</span>
                <Select
                  value={selectedServerId ?? undefined}
                  onValueChange={handleServerChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择服务器或分组" />
                  </SelectTrigger>
                  <SelectContent>{outboundOptions}</SelectContent>
                </Select>
              </div>
            </div>

            {/* 服务器详细信息 */}
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">协议</span>
                <Badge variant="outline" className="text-xs">
                  {selectedServer.protocol}
                </Badge>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">地址</span>
                <span
                  className="text-sm font-medium truncate max-w-[150px]"
                  title={selectedServer.address}
                >
                  {selectedServer.address}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">端口</span>
                <span className="text-sm font-medium">{selectedServer.port}</span>
              </div>
            </div>
          </div>
        )}

        <div className="pt-2 border-t">
          <p className="text-xs text-muted-foreground">{statusInfo.description}</p>
        </div>
      </CardContent>
    </Card>
  );
}
