import { useState } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '@/store/app-store';
import { ServerList } from '@/components/settings/server-list';
import { ServerConfigDialog } from '@/components/settings/server-config-dialog';
import type { ServerConfig } from '@/bridge/types';

type ServerConfigWithId = ServerConfig;

export function ServerPage() {
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const deleteServer = useAppStore((state) => state.deleteServer);
  const testAllServers = useAppStore((state) => state.testAllServers);
  const speedTestResults = useAppStore((state) => state.speedTestResults);
  const isSpeedTesting = useAppStore((state) => state.isSpeedTesting);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerConfigWithId | undefined>();

  const servers = config?.servers || [];
  const selectedServerId = config?.selectedServerId;

  const handleAddServer = () => {
    setEditingServer(undefined);
    setIsDialogOpen(true);
  };

  const handleEditServer = (server: ServerConfigWithId) => {
    setEditingServer(server);
    setIsDialogOpen(true);
  };

  const handleDeleteServer = async (serverId: string) => {
    try {
      await deleteServer(serverId);
      toast.success('服务器已删除');
    } catch (error) {
      toast.error('删除失败', {
        description: error instanceof Error ? error.message : '删除服务器时发生错误',
      });
    }
  };

  const handleSelectServer = async (serverId: string) => {
    if (!config) return;

    try {
      const updatedConfig = {
        ...config,
        selectedServerId: serverId,
      };

      await saveConfig(updatedConfig);
      toast.success('服务器已选择');
    } catch (error) {
      toast.error('选择失败', {
        description: error instanceof Error ? error.message : '选择服务器时发生错误',
      });
    }
  };

  const handleSaveServer = async (
    serverData: Omit<ServerConfigWithId, 'id' | 'createdAt' | 'updatedAt'>
  ) => {
    try {
      const now = new Date().toISOString();
      let updatedServers: ServerConfigWithId[];

      if (editingServer) {
        // Update existing server
        updatedServers = servers.map((s) =>
          s.id === editingServer.id
            ? {
                ...serverData,
                id: editingServer.id,
                createdAt: editingServer.createdAt,
                updatedAt: now,
              }
            : s
        );
      } else {
        // Add new server
        const newServer: ServerConfigWithId = {
          ...serverData,
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        };
        updatedServers = [...servers, newServer];
      }

      if (!config) {
        throw new Error('配置未加载');
      }

      const updatedConfig = {
        ...config,
        servers: updatedServers,
      };

      await saveConfig(updatedConfig);

      const action = editingServer ? '更新' : '添加';
      toast.success(`服务器配置已${action}`, {
        description: `${serverData.name} 配置已成功保存`,
      });
    } catch (error) {
      toast.error('保存失败', {
        description: error instanceof Error ? error.message : '保存服务器配置时发生错误',
      });
      throw error;
    }
  };

  const loadConfig = useAppStore((state) => state.loadConfig);

  const handleImportSuccess = async () => {
    // 导入成功后刷新配置
    await loadConfig();
    toast.success('服务器导入成功');
  };

  const handleSpeedTest = async () => {
    try {
      await testAllServers();
      toast.success('服务器测试完成');
    } catch (error) {
      toast.error('测试失败', {
        description: error instanceof Error ? error.message : '测试服务器时发生错误',
      });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">服务器配置</h2>
        <p className="text-muted-foreground mt-1">
          管理您的代理服务器配置，支持 VLESS、Trojan 和 Hysteria2 协议
        </p>
      </div>

      <ServerList
        servers={servers}
        selectedServerId={selectedServerId ?? undefined}
        speedTestResults={speedTestResults}
        isSpeedTesting={isSpeedTesting}
        onAddServer={handleAddServer}
        onEditServer={handleEditServer}
        onDeleteServer={handleDeleteServer}
        onSelectServer={handleSelectServer}
        onImportSuccess={handleImportSuccess}
        onSpeedTest={handleSpeedTest}
      />

      <ServerConfigDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        server={editingServer}
        onSave={handleSaveServer}
      />
    </div>
  );
}
