import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Plus,
  Edit,
  Trash2,
  Server,
  ChevronDown,
  Link,
  Share2,
  Zap,
  Layers,
  GripVertical,
  Settings,
  FolderInput,
} from 'lucide-react';
import { ImportUrlDialog } from './import-url-dialog';
import { ShareServerDialog } from './share-server-dialog';
import { ServerSpeedBadge } from '@/components/server/server-speed-badge';
import type { ServerConfig, ServerGroup, ServerSpeedResult } from '@/bridge/types';

type ServerConfigWithId = ServerConfig;

interface ServerListProps {
  servers: ServerConfigWithId[];
  selectedServerId?: string;
  speedTestResults?: ServerSpeedResult[];
  isSpeedTesting?: boolean;
  groups?: ServerGroup[];
  selectedGroupId?: string;
  onAddServer: () => void;
  onEditServer: (server: ServerConfigWithId) => void;
  onDeleteServer: (serverId: string) => void;
  onSelectServer: (serverId: string) => void;
  onSelectGroup: (groupId: string) => void;
  onUnselectGroup: () => void;
  onManageGroup: (groupId: string) => void;
  onCreateGroup?: () => void;
  onShareGroup: (groupId: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onMoveServerToGroup: (serverId: string, targetGroupId: string) => void;
  onImportSuccess?: () => void;
  onSpeedTest?: () => void;
}

// 节点拖拽的数据类型
const DND_SERVER_TYPE = 'application/x-flowz-server-id';

export function ServerList({
  servers,
  selectedServerId,
  speedTestResults = [],
  isSpeedTesting = false,
  groups = [],
  selectedGroupId,
  onAddServer,
  onEditServer,
  onDeleteServer,
  onSelectServer,
  onSelectGroup,
  onUnselectGroup,
  onManageGroup,
  onCreateGroup,
  onShareGroup,
  onDeleteGroup,
  onMoveServerToGroup,
  onImportSuccess,
  onSpeedTest,
}: ServerListProps) {
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [sharingServer, setSharingServer] = useState<ServerConfigWithId | null>(null);
  // 拖拽时高亮的目标分组
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  // 展开显示成员节点的分组
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  // 移动确认弹窗（节点已属于其它分组时）
  const [pendingMove, setPendingMove] = useState<{
    server: ServerConfigWithId;
    fromGroupName: string | null;
    targetGroupId: string;
    targetGroupName: string;
  } | null>(null);

  const handleDelete = (serverId: string) => {
    onDeleteServer(serverId);
  };

  const handleShare = (server: ServerConfigWithId, e: React.MouseEvent) => {
    e.stopPropagation();
    setSharingServer(server);
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '未知';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '无效日期';
    return date.toLocaleString('zh-CN');
  };

  const getProtocolBadgeVariant = (protocol: string) => {
    return protocol === 'Vless' ? 'default' : 'secondary';
  };

  const getSpeedResult = (serverId: string): ServerSpeedResult | undefined => {
    return speedTestResults.find((r) => r.serverId === serverId);
  };

  const groupMemberCount = (group: ServerGroup) => {
    return group.serverIds.filter((id) => servers.some((s) => s.id === id)).length;
  };

  /** 节点当前所属分组名称（无则为 null） */
  const groupOfServer = (server: ServerConfigWithId): ServerGroup | undefined => {
    return groups.find((g) => g.serverIds.includes(server.id));
  };

  /** 请求移动节点到目标分组；若已在其它分组则先弹确认 */
  const requestMove = (server: ServerConfigWithId, targetGroupId: string) => {
    // 已在目标分组，无需移动
    if (server.id && groups.find((g) => g.id === targetGroupId)?.serverIds.includes(server.id)) {
      return;
    }
    const fromGroup = groupOfServer(server);
    if (fromGroup && fromGroup.id !== targetGroupId) {
      setPendingMove({
        server,
        fromGroupName: fromGroup.name,
        targetGroupId,
        targetGroupName: groups.find((g) => g.id === targetGroupId)?.name || '',
      });
    } else {
      onMoveServerToGroup(server.id, targetGroupId);
    }
  };

  const confirmMove = () => {
    if (!pendingMove) return;
    onMoveServerToGroup(pendingMove.server.id, pendingMove.targetGroupId);
    setPendingMove(null);
  };

  // ==================== 节点拖拽 ====================

  const handleServerDragStart = (e: React.DragEvent, server: ServerConfigWithId) => {
    e.dataTransfer.setData(DND_SERVER_TYPE, server.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleGroupDragOver = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverGroupId(groupId);
  };

  const handleGroupDragLeave = (groupId: string) => {
    setDragOverGroupId((prev) => (prev === groupId ? null : prev));
  };

  const handleGroupDrop = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    setDragOverGroupId(null);
    const serverId = e.dataTransfer.getData(DND_SERVER_TYPE);
    if (!serverId) return;
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;
    requestMove(server, groupId);
  };

  // ==================== 派生数据 ====================

  // 已属于任何分组的节点 ID
  const groupedIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) for (const id of g.serverIds) set.add(id);
    return set;
  }, [groups]);

  // 未分组的节点：单独渲染在下方列表中
  const ungroupedServers = useMemo(
    () => servers.filter((s) => !groupedIds.has(s.id)),
    [servers, groupedIds]
  );

  const groupMembers = (group: ServerGroup) =>
    servers.filter((s) => group.serverIds.includes(s.id));

  const toggleGroupExpand = (groupId: string) => {
    setExpandedGroupId((prev) => (prev === groupId ? null : groupId));
  };

  // ==================== 节点卡片（分组成员 / 未分组节点共用） ====================

  const renderServerCard = (server: ServerConfigWithId, showGroupBadge: boolean) => {
    const fromGroup = groupOfServer(server);
    return (
      <Card
        key={server.id}
        className={`cursor-pointer transition-colors ${
          selectedServerId === server.id ? 'ring-2 ring-primary bg-primary/5' : 'hover:bg-muted/50'
        }`}
        onClick={() => onSelectServer(server.id)}
      >
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span
                className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
                title="拖拽到分组"
                draggable
                onDragStart={(e) => handleServerDragStart(e, server)}
                onClick={(e) => e.stopPropagation()}
              >
                <GripVertical className="h-4 w-4" />
              </span>
              <CardTitle className="text-base">{server.name}</CardTitle>
              <Badge variant={getProtocolBadgeVariant(server.protocol)}>{server.protocol}</Badge>
              {selectedServerId === server.id && (
                <Badge variant="outline" className="text-xs">
                  当前选中
                </Badge>
              )}
              {showGroupBadge && fromGroup && (
                <Badge variant="secondary" className="text-xs">
                  {fromGroup.name}
                </Badge>
              )}
              <ServerSpeedBadge result={getSpeedResult(server.id)} isLoading={isSpeedTesting} />
            </div>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="移至分组"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <FolderInput className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>移至分组</DropdownMenuLabel>
                  {groups.length === 0 ? (
                    <DropdownMenuItem disabled>暂无分组</DropdownMenuItem>
                  ) : (
                    groups.map(
                      (group) =>
                        group.id !== fromGroup?.id && (
                          <DropdownMenuItem
                            key={group.id}
                            disabled={group.serverIds.includes(server.id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              requestMove(server, group.id);
                            }}
                          >
                            <Layers className="h-4 w-4 mr-2" />
                            {group.name}
                          </DropdownMenuItem>
                        )
                    )
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="sm"
                title="分享"
                onClick={(e) => handleShare(server, e)}
              >
                <Share2 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="编辑"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditServer(server);
                }}
              >
                <Edit className="h-4 w-4" />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>删除服务器配置</AlertDialogTitle>
                    <AlertDialogDescription>
                      确定要删除服务器 "{server.name}" 吗？此操作无法撤销。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel onClick={(e) => e.stopPropagation()}>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(server.id);
                      }}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      删除
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
          <CardDescription>
            {server.address}:{server.port}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">传输协议:</span>
              <span className="ml-2 font-medium">{server.network}</span>
            </div>
            <div>
              <span className="text-muted-foreground">加密:</span>
              <span className="ml-2 font-medium">{server.security}</span>
            </div>
            <div className="col-span-2">
              <span className="text-muted-foreground">创建时间:</span>
              <span className="ml-2 font-medium">{formatDate(server.createdAt)}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">服务器列表</h3>
          <p className="text-sm text-muted-foreground">管理您的代理服务器配置</p>
        </div>
        <div className="flex items-center gap-2">
          {onSpeedTest && servers.length > 0 && (
            <Button
              variant="outline"
              onClick={onSpeedTest}
              disabled={isSpeedTesting}
              className="flex items-center gap-2"
            >
              <Zap className={`h-4 w-4 ${isSpeedTesting ? 'animate-pulse' : ''}`} />
              {isSpeedTesting ? '测试中...' : '测速'}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                添加服务器
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onAddServer}>
                <Plus className="h-4 w-4 mr-2" />
                手动添加
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsImportDialogOpen(true)}>
                <Link className="h-4 w-4 mr-2" />
                从URL导入
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {groups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-medium">订阅分组</h4>
              {onCreateGroup && (
                <Button variant="ghost" size="sm" onClick={onCreateGroup} className="h-6 gap-1">
                  <Plus className="h-3.5 w-3.5" />
                  新建分组
                </Button>
              )}
            </div>
            {selectedGroupId && (
              <Button variant="ghost" size="sm" onClick={onUnselectGroup}>
                取消分组
              </Button>
            )}
          </div>
          <div className="grid gap-2">
            {groups.map((group) => (
              <Card
                key={group.id}
                className={`transition-colors ${
                  dragOverGroupId === group.id
                    ? 'ring-2 ring-primary border-primary'
                    : selectedGroupId === group.id
                      ? 'ring-2 ring-primary bg-primary/5'
                      : 'hover:bg-muted/50'
                }`}
                onDragOver={(e) => handleGroupDragOver(e, group.id)}
                onDragLeave={() => handleGroupDragLeave(group.id)}
                onDrop={(e) => handleGroupDrop(e, group.id)}
              >
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      className="flex items-center gap-2 text-left cursor-pointer hover:opacity-80"
                      onClick={() => toggleGroupExpand(group.id)}
                    >
                      <ChevronDown
                        className={`h-4 w-4 text-muted-foreground transition-transform ${
                          expandedGroupId === group.id ? 'rotate-0' : '-rotate-90'
                        }`}
                      />
                      <Layers className="h-4 w-4 text-muted-foreground" />
                      <CardTitle className="text-sm font-medium">{group.name}</CardTitle>
                      {selectedGroupId === group.id && (
                        <Badge variant="outline" className="text-xs">
                          故障转移中
                        </Badge>
                      )}
                    </button>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-muted-foreground">
                        {groupMemberCount(group)} 个节点
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => e.stopPropagation()}
                            title="管理分组"
                          >
                            <Settings className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              onManageGroup(group.id);
                            }}
                          >
                            <Settings className="h-4 w-4 mr-2" />
                            管理
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              onShareGroup(group.id);
                            }}
                          >
                            <Share2 className="h-4 w-4 mr-2" />
                            分享
                          </DropdownMenuItem>
                          {selectedGroupId === group.id ? (
                            <DropdownMenuItem onClick={(e) => e.stopPropagation()}>
                              <Zap className="h-4 w-4 mr-2" />
                              故障转移中
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectGroup(group.id);
                              }}
                            >
                              <Zap className="h-4 w-4 mr-2" />
                              启用故障转移
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteGroup(group.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            删除分组
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  <CardDescription className="text-xs">
                    {dragOverGroupId === group.id
                      ? '释放以移入此分组'
                      : '点击分组可展开查看成员，选择分组启用组内自动故障转移（urltest）'}
                  </CardDescription>
                </CardHeader>
                {expandedGroupId === group.id && (
                  <CardContent className="space-y-2 border-t pt-3">
                    {groupMembers(group).length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        该分组暂无成员，可拖拽节点到此处或使用「管理」添加
                      </p>
                    ) : (
                      groupMembers(group).map((server) => renderServerCard(server, false))
                    )}
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {servers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">暂无服务器配置</h3>
            <p className="text-sm text-muted-foreground mb-4 text-center">
              您还没有添加任何服务器配置。点击上方按钮添加您的第一个服务器。
            </p>
            <div className="flex gap-2">
              <Button onClick={onAddServer} className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                手动添加
              </Button>
              <Button
                variant="outline"
                onClick={() => setIsImportDialogOpen(true)}
                className="flex items-center gap-2"
              >
                <Link className="h-4 w-4" />
                从URL导入
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {groups.length === 0 && onCreateGroup && (
            <div className="flex items-center justify-between rounded-md border border-dashed px-4 py-3">
              <div>
                <div className="text-sm font-medium">创建订阅分组</div>
                <div className="text-xs text-muted-foreground">
                  将节点归入分组可启用组内自动故障转移，并可批量管理成员
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={onCreateGroup} className="gap-1">
                <Plus className="h-4 w-4" />
                新建分组
              </Button>
            </div>
          )}
          <div className="space-y-2">
            {ungroupedServers.length > 0 && (
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <h4 className="text-sm font-medium">未分组的节点</h4>
                <span className="text-xs text-muted-foreground">{ungroupedServers.length} 个</span>
              </div>
            )}
            {ungroupedServers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                所有节点都已归入分组，展开上方分组即可查看其成员
              </p>
            ) : (
              <div className="grid gap-4">
                {ungroupedServers.map((server) => renderServerCard(server, true))}
              </div>
            )}
          </div>
        </>
      )}

      <ImportUrlDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        onImportSuccess={onImportSuccess}
      />

      <ShareServerDialog
        open={!!sharingServer}
        onOpenChange={(open) => {
          if (!open) setSharingServer(null);
        }}
        server={sharingServer}
      />

      {/* 移动确认弹窗：节点已属于其它分组 */}
      <AlertDialog
        open={!!pendingMove}
        onOpenChange={(open) => {
          if (!open) setPendingMove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移动到分组</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingMove?.fromGroupName
                ? `节点 "${pendingMove.server.name}" 当前属于分组 "${pendingMove.fromGroupName}"，将从该分组移至 "${pendingMove.targetGroupName}"。一个节点只能属于一个分组。`
                : `确定将节点 "${pendingMove?.server.name}" 移至 "${pendingMove?.targetGroupName}" 吗？`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmMove}>确认移动</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
