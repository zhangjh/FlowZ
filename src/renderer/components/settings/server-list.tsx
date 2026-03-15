import { useState } from 'react';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Plus, Edit, Trash2, Server, ChevronDown, Link, Share2 } from 'lucide-react';
import { ImportUrlDialog } from './import-url-dialog';
import { ShareServerDialog } from './share-server-dialog';
import type { ServerConfig } from '@/bridge/types';

type ServerConfigWithId = ServerConfig;

interface ServerListProps {
  servers: ServerConfigWithId[];
  selectedServerId?: string;
  onAddServer: () => void;
  onEditServer: (server: ServerConfigWithId) => void;
  onDeleteServer: (serverId: string) => void;
  onSelectServer: (serverId: string) => void;
  onImportSuccess?: () => void;
}

export function ServerList({
  servers,
  selectedServerId,
  onAddServer,
  onEditServer,
  onDeleteServer,
  onSelectServer,
  onImportSuccess,
}: ServerListProps) {
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [sharingServer, setSharingServer] = useState<ServerConfigWithId | null>(null);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">服务器列表</h3>
          <p className="text-sm text-muted-foreground">管理您的代理服务器配置</p>
        </div>
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
        <div className="grid gap-4">
          {servers.map((server) => (
            <Card
              key={server.id}
              className={`cursor-pointer transition-colors ${
                selectedServerId === server.id
                  ? 'ring-2 ring-primary bg-primary/5'
                  : 'hover:bg-muted/50'
              }`}
              onClick={() => onSelectServer(server.id)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-base">{server.name}</CardTitle>
                    <Badge variant={getProtocolBadgeVariant(server.protocol)}>
                      {server.protocol}
                    </Badge>
                    {selectedServerId === server.id && (
                      <Badge variant="outline" className="text-xs">
                        当前选中
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
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
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
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
                          <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
                            取消
                          </AlertDialogCancel>
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
          ))}
        </div>
      )}

      <ImportUrlDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        onImportSuccess={onImportSuccess}
      />

      <ShareServerDialog
        open={!!sharingServer}
        onOpenChange={(open) => { if (!open) setSharingServer(null); }}
        server={sharingServer}
      />
    </div>
  );
}
