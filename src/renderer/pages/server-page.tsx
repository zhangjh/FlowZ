import { useState } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '@/store/app-store';
import { ServerList } from '@/components/settings/server-list';
import { ServerConfigDialog } from '@/components/settings/server-config-dialog';
import { GroupEditorDialog } from '@/components/settings/group-editor-dialog';
import { ShareGroupDialog } from '@/components/settings/share-group-dialog';
import type { ServerConfig, ServerGroup } from '@/bridge/types';

type ServerConfigWithId = ServerConfig;

export function ServerPage() {
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const deleteServer = useAppStore((state) => state.deleteServer);
  const createGroup = useAppStore((state) => state.createGroup);
  const updateGroup = useAppStore((state) => state.updateGroup);
  const moveServerToGroup = useAppStore((state) => state.moveServerToGroup);
  const deleteGroup = useAppStore((state) => state.deleteGroup);
  const testAllServers = useAppStore((state) => state.testAllServers);
  const speedTestResults = useAppStore((state) => state.speedTestResults);
  const isSpeedTesting = useAppStore((state) => state.isSpeedTesting);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerConfigWithId | undefined>();
  const [groupEditor, setGroupEditor] = useState<
    { mode: 'create' } | { mode: 'edit'; group: ServerGroup } | null
  >(null);
  const [sharingGroup, setSharingGroup] = useState<ServerGroup | null>(null);

  const servers = config?.servers || [];
  const selectedServerId = config?.selectedServerId;
  const groups = config?.serverGroups || [];
  const selectedGroupId = config?.selectedGroupId;

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
        selectedGroupId: null,
      };

      await saveConfig(updatedConfig);
      toast.success('服务器已选择');
    } catch (error) {
      toast.error('选择失败', {
        description: error instanceof Error ? error.message : '选择服务器时发生错误',
      });
    }
  };

  const handleSelectGroup = async (groupId: string) => {
    if (!config) return;

    const group = groups.find((g) => g.id === groupId);
    if (!group || group.serverIds.length === 0) {
      toast.error('分组无效', { description: '分组不存在或没有成员服务器' });
      return;
    }

    try {
      const updatedConfig = {
        ...config,
        selectedGroupId: groupId,
        selectedServerId: null,
      };

      await saveConfig(updatedConfig);
      toast.success('分组已选择，启用组内自动故障转移');
    } catch (error) {
      toast.error('选择失败', {
        description: error instanceof Error ? error.message : '选择分组时发生错误',
      });
    }
  };

  const handleUnselectGroup = async () => {
    if (!config) return;
    try {
      await saveConfig({ ...config, selectedGroupId: null });
      toast.success('已取消分组选择');
    } catch (error) {
      toast.error('操作失败', {
        description: error instanceof Error ? error.message : '取消分组选择时发生错误',
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
                groupId: editingServer.groupId,
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

  const handleManageGroup = (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    setGroupEditor({ mode: 'edit', group });
  };

  const handleCreateGroup = () => {
    setGroupEditor({ mode: 'create' });
  };

  const handleShareGroup = (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (group) setSharingGroup(group);
  };

  const handleSaveGroup = async (input: {
    name: string;
    addServerIds: string[];
    removeServerIds: string[];
  }) => {
    if (!groupEditor) return;
    if (groupEditor.mode === 'create') {
      // 创建分组（可带已有节点），一次原子保存：仅一次配置变更与代理重启
      await createGroup(input.name.trim(), input.addServerIds);
      setGroupEditor(null);
      toast.success('分组已创建');
      return;
    }
    // 编辑模式：单次原子保存：改名 + 增删成员一次完成，只触发一次配置变更与代理重启
    await updateGroup(groupEditor.group.id, {
      name: input.name.trim(),
      addServerIds: input.addServerIds,
      removeServerIds: input.removeServerIds,
    });
    setGroupEditor(null);
    toast.success('分组已保存');
  };

  const handleDeleteGroup = async (groupId: string) => {
    try {
      await deleteGroup(groupId);
      toast.success('分组已删除');
    } catch (error) {
      toast.error('删除失败', {
        description: error instanceof Error ? error.message : '删除分组时发生错误',
      });
    }
  };

  const handleMoveServerToGroup = async (serverId: string, targetGroupId: string) => {
    try {
      await moveServerToGroup(serverId, targetGroupId);
      toast.success('节点已移至分组');
    } catch (error) {
      toast.error('移动失败', {
        description: error instanceof Error ? error.message : '移动节点时发生错误',
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
        groups={groups}
        selectedGroupId={selectedGroupId ?? undefined}
        onAddServer={handleAddServer}
        onEditServer={handleEditServer}
        onDeleteServer={handleDeleteServer}
        onSelectServer={handleSelectServer}
        onSelectGroup={handleSelectGroup}
        onUnselectGroup={handleUnselectGroup}
        onManageGroup={handleManageGroup}
        onCreateGroup={handleCreateGroup}
        onShareGroup={handleShareGroup}
        onDeleteGroup={handleDeleteGroup}
        onMoveServerToGroup={handleMoveServerToGroup}
        onImportSuccess={handleImportSuccess}
        onSpeedTest={handleSpeedTest}
      />

      <ServerConfigDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        server={editingServer}
        onSave={handleSaveServer}
      />

      <GroupEditorDialog
        mode={groupEditor?.mode ?? 'edit'}
        group={groupEditor?.mode === 'edit' ? groupEditor.group : null}
        servers={servers}
        open={!!groupEditor}
        onOpenChange={(open) => {
          if (!open) setGroupEditor(null);
        }}
        onSave={handleSaveGroup}
      />

      <ShareGroupDialog
        open={!!sharingGroup}
        onOpenChange={(open) => {
          if (!open) setSharingGroup(null);
        }}
        group={sharingGroup}
      />
    </div>
  );
}
