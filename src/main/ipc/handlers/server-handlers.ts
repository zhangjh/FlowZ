/**
 * 服务器管理 IPC 处理器
 * 处理服务器配置相关的 IPC 请求
 */

import { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { ServerConfig, ServerGroup } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { ProtocolParser } from '../../services/ProtocolParser';
import { ConfigManager } from '../../services/ConfigManager';
import {
  fetchSubscriptionContent,
  decodeSubscriptionText,
} from '../../services/SubscriptionService';
import { ipcEventEmitter } from '../ipc-events';
import { mainEventEmitter, MAIN_EVENTS } from '../main-events';
import { IPC_CHANNELS as CHANNELS } from '../../../shared/ipc-channels';

/**
 * 注册服务器管理相关的 IPC 处理器
 */
export function registerServerHandlers(
  protocolParser: ProtocolParser,
  configManager: ConfigManager
): void {
  // 解析协议 URL
  registerIpcHandler<{ url: string }, ServerConfig>(
    IPC_CHANNELS.SERVER_PARSE_URL,
    async (_event: IpcMainInvokeEvent, args: { url: string }) => {
      return protocolParser.parseUrl(args.url);
    }
  );

  // 生成分享 URL
  registerIpcHandler<{ server: ServerConfig }, string>(
    IPC_CHANNELS.SERVER_GENERATE_URL,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      return protocolParser.generateUrl(args.server);
    }
  );

  // 从 URL 添加服务器
  registerIpcHandler<{ url: string; name?: string }, ServerConfig>(
    IPC_CHANNELS.SERVER_ADD_FROM_URL,
    async (_event: IpcMainInvokeEvent, args: { url: string; name?: string }) => {
      // 解析 URL
      const serverConfig = protocolParser.parseUrl(args.url);

      // 如果传入了自定义名称，使用自定义名称
      if (args.name) {
        serverConfig.name = args.name;
      }

      // 设置创建时间和更新时间
      const now = new Date().toISOString();
      serverConfig.createdAt = now;
      serverConfig.updatedAt = now;

      // 加载当前配置
      const config = await configManager.loadConfig();

      // 添加服务器到配置
      config.servers.push(serverConfig);

      // 保存配置
      await configManager.saveConfig(config);

      return serverConfig;
    }
  );

  // 添加服务器
  registerIpcHandler<{ server: ServerConfig }, void>(
    IPC_CHANNELS.SERVER_ADD,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      const config = await configManager.loadConfig();
      config.servers.push(args.server);
      await configManager.saveConfig(config);
    }
  );

  // 更新服务器
  registerIpcHandler<{ server: ServerConfig }, void>(
    IPC_CHANNELS.SERVER_UPDATE,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      const config = await configManager.loadConfig();
      const index = config.servers.findIndex((s) => s.id === args.server.id);

      if (index === -1) {
        throw new Error(`服务器不存在: ${args.server.id}`);
      }

      config.servers[index] = args.server;
      await configManager.saveConfig(config);
    }
  );

  // 删除服务器
  registerIpcHandler<{ serverId: string }, void>(
    IPC_CHANNELS.SERVER_DELETE,
    async (_event: IpcMainInvokeEvent, args: { serverId: string }) => {
      const config = await configManager.loadConfig();
      const index = config.servers.findIndex((s) => s.id === args.serverId);

      if (index === -1) {
        throw new Error(`服务器不存在: ${args.serverId}`);
      }

      // 如果删除的是当前选中的服务器，清除选中状态
      if (config.selectedServerId === args.serverId) {
        config.selectedServerId = null;
      }

      // 先从所在分组的成员列表中移除（含手动/订阅/排除列表）。
      // 注意：必须在 splice 之前执行，否则 removeServerFromGroup 找不到
      // 服务器对象会提前返回，导致分组残留已删除节点 ID。
      for (const group of config.serverGroups) {
        removeServerFromGroup(config, group, args.serverId);
        // 分组清空后，若正被选择则解除选择
        if (group.serverIds.length === 0 && config.selectedGroupId === group.id) {
          config.selectedGroupId = null;
        }
      }

      config.servers.splice(index, 1);

      await configManager.saveConfig(config);
      broadcastConfigChanged(config);
    }
  );

  // 获取所有服务器
  registerIpcHandler<void, ServerConfig[]>(
    IPC_CHANNELS.SERVER_GET_ALL,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      return config.servers;
    }
  );

  // 切换服务器
  registerIpcHandler<{ serverId: string }, void>(
    IPC_CHANNELS.SERVER_SWITCH,
    async (_event: IpcMainInvokeEvent, args: { serverId: string }) => {
      const config = await configManager.loadConfig();
      const server = config.servers.find((s) => s.id === args.serverId);

      if (!server) {
        throw new Error(`服务器不存在: ${args.serverId}`);
      }

      config.selectedServerId = args.serverId;
      config.selectedGroupId = null;
      await configManager.saveConfig(config);
    }
  );

  // 解析订阅内容：支持直接粘贴的协议文本，或订阅 URL（http/https, 自动 base64 解码）
  registerIpcHandler<{ content?: string; url?: string }, ServerConfig[]>(
    IPC_CHANNELS.SERVER_PARSE_SUBSCRIPTION,
    async (_event: IpcMainInvokeEvent, args: { content?: string; url?: string }) => {
      const { content: rawContent, url } = args;

      // 若提供 url 且未提供 content，则拉取订阅
      let content = rawContent;
      if (!content && url) {
        const fetched = await fetchSubscriptionContent(url);
        content = fetched.text;
      }
      if (!content) {
        throw new Error('订阅内容为空，请输入协议链接或订阅 URL');
      }
      // 直接粘贴的内容可能是 base64/base64url 编码，先统一解码
      content = decodeSubscriptionText(content).text;

      const servers = protocolParser.parseMany(content);
      if (servers.length === 0) {
        throw new Error('未解析出任何有效的服务器链接');
      }

      // 打上时间戳，但不写入配置（仅预览）
      const now = new Date().toISOString();
      for (const s of servers) {
        s.createdAt = now;
        s.updatedAt = now;
      }

      return servers;
    }
  );

  // 从订阅批量添加服务器到配置（自动归为一个分组，供组内故障转移）
  // servers 为可选：若调用方已解析（预览后直接导入），则复用其结果，避免二次拉取
  registerIpcHandler<
    { servers?: ServerConfig[]; content?: string; url?: string; groupName?: string },
    { servers: ServerConfig[]; group: ServerGroup }
  >(
    IPC_CHANNELS.SERVER_ADD_SUBSCRIPTION,
    async (
      _event: IpcMainInvokeEvent,
      args: { servers?: ServerConfig[]; content?: string; url?: string; groupName?: string }
    ) => {
      const { servers: preParsed, content: rawContent, url, groupName } = args;

      let servers = preParsed;
      if (!servers) {
        let content = rawContent;
        if (!content && url) {
          const fetched = await fetchSubscriptionContent(url);
          content = fetched.text;
        }
        if (!content) {
          throw new Error('订阅内容为空，请输入协议链接或订阅 URL');
        }
        // 直接粘贴的内容可能是 base64/base64url 编码，先统一解码
        content = decodeSubscriptionText(content).text;

        servers = protocolParser.parseMany(content);
        if (servers.length === 0) {
          throw new Error('未解析出任何有效的服务器链接');
        }

        const now = new Date().toISOString();
        for (const s of servers) {
          s.createdAt = now;
          s.updatedAt = now;
        }
      }

      const config = await configManager.loadConfig();

      // 生成或复用分组：以 url 作为分组标识；无 url（直接粘贴文本）时新建分组
      const name = (groupName && groupName.trim()) || deriveGroupName(url, servers.length);
      let group: ServerGroup | undefined;
      if (url) {
        group = config.serverGroups.find(
          (g) => g.url && g.url.replace(/\/+$/, '') === url.replace(/\/+$/, '')
        );
      }

      const now = new Date().toISOString();
      if (group) {
        // 已有分组（订阅刷新）：仅更新 url，保留用户编辑后的分组名称，
        // 不再被 URL 推导的名称覆盖。
        group.url = url;
        group.updatedAt = now;
      } else {
        group = {
          id: randomUUID(),
          name,
          url,
          serverIds: [],
          subscriptionServerIds: [],
          manualServerIds: [],
          excludedSubscriptionKeys: [],
          createdAt: now,
          updatedAt: now,
        };
        config.serverGroups.push(group);
      }

      // 成员分两类：
      //  - 订阅同步成员（subscriptionServerIds）：随本次刷新重置。
      //  - 手动成员（manualServerIds）：用户在分组管理中手动加入的节点，刷新时保留。
      //  - 被排除的订阅节点（excludedSubscriptionKeys）：用户主动移除，再次刷新时不会被加回。
      // serverIds 始终是两者的并集。
      const groupId = group.id;
      const previousAllIds = new Set(group.serverIds);
      const excludedKeys = new Set(group.excludedSubscriptionKeys || []);

      // 将所有当前成员（订阅 + 手动）建立 key -> serverId 映射，便于去重与就地更新
      const memberByKey = new Map<string, string>();
      for (const memberId of group.serverIds) {
        const member = config.servers.find((s) => s.id === memberId);
        if (member) {
          memberByKey.set(buildServerKey(member), member.id);
        }
      }

      // 计算本次订阅同步的订阅成员
      const nextSubscriptionIds: string[] = [];
      for (const s of servers) {
        const key = buildServerKey(s);
        // 用户主动移除过的节点不再作为订阅成员自动加回
        if (excludedKeys.has(key)) continue;
        const existingId = memberByKey.get(key);
        if (existingId) {
          const idx = config.servers.findIndex((sv) => sv.id === existingId);
          if (idx !== -1) {
            const prev = config.servers[idx];
            config.servers[idx] = {
              ...s,
              id: existingId,
              groupId,
              createdAt: prev.createdAt,
              updatedAt: now,
            };
          }
          if (!nextSubscriptionIds.includes(existingId)) {
            nextSubscriptionIds.push(existingId);
          }
          continue;
        }
        s.groupId = groupId;
        config.servers.push(s);
        nextSubscriptionIds.push(s.id);
        memberByKey.set(key, s.id);
      }

      // 更新订阅成员；手动成员保持不变
      group.subscriptionServerIds = nextSubscriptionIds;
      if (!group.manualServerIds) group.manualServerIds = [];
      if (!group.excludedSubscriptionKeys) group.excludedSubscriptionKeys = [];

      // serverIds = 订阅成员 ∪ 手动成员
      const finalIds = Array.from(new Set([...nextSubscriptionIds, ...group.manualServerIds]));
      const finalIdSet = new Set(finalIds);
      group.serverIds = finalIds;

      // 曾是成员但不在本次并集中的节点，从该分组摘除并清除 groupId
      for (const memberId of previousAllIds) {
        if (finalIdSet.has(memberId)) continue;
        const previousServer = config.servers.find((server) => server.id === memberId);
        if (previousServer?.groupId === groupId) {
          delete previousServer.groupId;
        }
      }

      // 导入后默认选中该分组（启用组内故障转移）
      config.selectedGroupId = groupId;
      config.selectedServerId = null;

      await configManager.saveConfig(config);
      broadcastConfigChanged(config);

      return { servers, group };
    }
  );

  // 创建分组
  registerIpcHandler<{ name: string; serverIds?: string[] }, ServerGroup>(
    IPC_CHANNELS.GROUP_CREATE,
    async (_event: IpcMainInvokeEvent, args: { name: string; serverIds?: string[] }) => {
      const config = await configManager.loadConfig();
      const now = new Date().toISOString();
      const group: ServerGroup = {
        id: randomUUID(),
        name: args.name,
        serverIds: [],
        subscriptionServerIds: [],
        manualServerIds: [],
        excludedSubscriptionKeys: [],
        createdAt: now,
        updatedAt: now,
      };
      config.serverGroups.push(group);
      // 通过 addServerToGroup 加入成员：一个节点只能属于一个分组，
      // 会从其它分组移除并设置 groupId，避免同节点出现在多个分组。
      if (args.serverIds) {
        for (const id of args.serverIds) {
          addServerToGroup(config, group, id);
        }
      }
      await configManager.saveConfig(config);
      broadcastConfigChanged(config);
      return group;
    }
  );

  // 单个原子更新分组：改名 + 批量增删成员。
  // 一次保存、一次广播、一次重启，避免重复触发热更新/重启以应用新的 urltest。
  registerIpcHandler<
    { groupId: string; name?: string; addServerIds?: string[]; removeServerIds?: string[] },
    ServerGroup
  >(
    IPC_CHANNELS.GROUP_UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      args: { groupId: string; name?: string; addServerIds?: string[]; removeServerIds?: string[] }
    ) => {
      const config = await configManager.loadConfig();
      const index = config.serverGroups.findIndex((g) => g.id === args.groupId);
      if (index === -1) {
        throw new Error(`分组不存在: ${args.groupId}`);
      }
      const group = config.serverGroups[index];

      // 改名（编辑后的名称在下次订阅刷新时被保留，不被 URL 推导覆盖）
      if (args.name !== undefined && args.name.trim()) {
        group.name = args.name.trim();
      }

      // 批量增删成员（先加入，再移除，保证最终一致）
      if (args.addServerIds) {
        for (const id of args.addServerIds) {
          addServerToGroup(config, group, id);
        }
      }
      if (args.removeServerIds) {
        for (const id of args.removeServerIds) {
          removeServerFromGroup(config, group, id);
        }
      }

      group.updatedAt = new Date().toISOString();
      await configManager.saveConfig(config);
      broadcastConfigChanged(config);
      return group;
    }
  );

  // 删除分组
  registerIpcHandler<{ groupId: string }, void>(
    IPC_CHANNELS.GROUP_DELETE,
    async (_event: IpcMainInvokeEvent, args: { groupId: string }) => {
      const config = await configManager.loadConfig();
      const index = config.serverGroups.findIndex((g) => g.id === args.groupId);
      if (index === -1) {
        throw new Error(`分组不存在: ${args.groupId}`);
      }
      config.serverGroups.splice(index, 1);
      // 清理组内服务器的 groupId，并移除选中状态
      for (const s of config.servers) {
        if (s.groupId === args.groupId) {
          delete s.groupId;
        }
      }
      if (config.selectedGroupId === args.groupId) {
        config.selectedGroupId = null;
      }
      await configManager.saveConfig(config);
      broadcastConfigChanged(config);
    }
  );

  // 选择分组（切换出口为分组故障转移）
  registerIpcHandler<{ groupId: string | null }, void>(
    IPC_CHANNELS.GROUP_SELECT,
    async (_event: IpcMainInvokeEvent, args: { groupId: string | null }) => {
      const config = await configManager.loadConfig();
      if (args.groupId !== null) {
        const group = config.serverGroups.find((g) => g.id === args.groupId);
        if (!group || group.serverIds.length === 0) {
          throw new Error('分组不存在或没有成员服务器');
        }
        config.selectedGroupId = args.groupId;
        config.selectedServerId = null;
      } else {
        config.selectedGroupId = null;
      }
      await configManager.saveConfig(config);
      broadcastConfigChanged(config);
    }
  );

  // 赋予已有服务器到指定分组
  registerIpcHandler<{ serverIds: string[]; groupId: string }, void>(
    IPC_CHANNELS.GROUP_ADD_SERVERS,
    async (_event: IpcMainInvokeEvent, args: { serverIds: string[]; groupId: string }) => {
      const config = await configManager.loadConfig();
      const group = config.serverGroups.find((g) => g.id === args.groupId);
      if (!group) {
        throw new Error(`分组不存在: ${args.groupId}`);
      }
      for (const id of args.serverIds) {
        addServerToGroup(config, group, id);
      }
      await configManager.saveConfig(config);
      broadcastConfigChanged(config);
    }
  );

  // 移动节点到指定分组（拖拽或菜单）；自动从旧分组移除
  registerIpcHandler<{ serverId: string; targetGroupId: string }, void>(
    IPC_CHANNELS.GROUP_MOVE_SERVER,
    async (_event: IpcMainInvokeEvent, args: { serverId: string; targetGroupId: string }) => {
      const config = await configManager.loadConfig();
      const target = config.serverGroups.find((g) => g.id === args.targetGroupId);
      if (!target) {
        throw new Error(`目标分组不存在: ${args.targetGroupId}`);
      }
      const server = config.servers.find((s) => s.id === args.serverId);
      if (!server) {
        throw new Error(`服务器不存在: ${args.serverId}`);
      }

      // 从所有其它分组（含当前旧分组）移除
      for (const other of config.serverGroups) {
        if (other.id === target.id) continue;
        removeServerFromGroup(config, other, args.serverId);
      }
      // 加入目标分组（作为手动成员）
      addServerToGroup(config, target, args.serverId);

      target.updatedAt = new Date().toISOString();
      await configManager.saveConfig(config);
      broadcastConfigChanged(config);
    }
  );

  // 生成分组分享文本：组内每个成员生成一个协议链接，换行拼接
  registerIpcHandler<{ groupId: string }, string>(
    IPC_CHANNELS.GROUP_SHARE,
    async (_event: IpcMainInvokeEvent, args: { groupId: string }) => {
      const config = await configManager.loadConfig();
      const group = config.serverGroups.find((g) => g.id === args.groupId);
      if (!group) {
        throw new Error(`分组不存在: ${args.groupId}`);
      }
      const members = config.servers.filter((s) => group.serverIds.includes(s.id));
      if (members.length === 0) {
        throw new Error('该分组暂无成员，无法生成分享');
      }
      return members.map((s) => protocolParser.generateUrl(s)).join('\n');
    }
  );

  // 获取所有分组
  registerIpcHandler<void, ServerGroup[]>(
    IPC_CHANNELS.GROUP_GET_ALL,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      return config.serverGroups;
    }
  );

  console.log('[Server Handlers] Registered all server IPC handlers');
}

/**
 * 将服务器加入指定分组（作为手动成员）。
 * 一个服务器只能属于一个分组：会从其它分组移除其成员身份。
 * 若该服务器曾是订阅节点，从旧订阅成员列表中移除并加入排除列表，避免刷新时加回。
 */
function addServerToGroup(
  config: import('../../../shared/types').UserConfig,
  group: ServerGroup,
  serverId: string
): void {
  const server = config.servers.find((s) => s.id === serverId);
  if (!server) return;
  if (!Array.isArray(group.manualServerIds)) group.manualServerIds = [];
  if (!Array.isArray(group.excludedSubscriptionKeys)) group.excludedSubscriptionKeys = [];

  // 若已在该组，则无需调整
  if (group.serverIds.includes(serverId)) {
    server.groupId = group.id;
    return;
  }

  // 从其它分组移除其成员身份
  for (const other of config.serverGroups) {
    if (other.id === group.id) continue;
    removeServerFromGroup(config, other, serverId);
  }

  server.groupId = group.id;
  if (!group.manualServerIds.includes(serverId)) {
    group.manualServerIds.push(serverId);
  }
  if (!group.serverIds.includes(serverId)) {
    group.serverIds.push(serverId);
  }
}

/**
 * 将服务器从指定分组移除。
 * 若该节点是订阅成员，则将其特征加入排除列表，下次订阅刷新时不会被自动加回。
 */
function removeServerFromGroup(
  config: import('../../../shared/types').UserConfig,
  group: ServerGroup,
  serverId: string
): void {
  const server = config.servers.find((s) => s.id === serverId);
  if (!server) return;
  if (!Array.isArray(group.manualServerIds)) group.manualServerIds = [];
  if (!Array.isArray(group.subscriptionServerIds)) group.subscriptionServerIds = [];
  if (!Array.isArray(group.excludedSubscriptionKeys)) group.excludedSubscriptionKeys = [];
  if (!Array.isArray(group.serverIds)) group.serverIds = [];

  const wasSubscriptionMember = group.subscriptionServerIds.includes(serverId);

  group.serverIds = group.serverIds.filter((id) => id !== serverId);
  group.manualServerIds = group.manualServerIds.filter((id) => id !== serverId);
  group.subscriptionServerIds = group.subscriptionServerIds.filter((id) => id !== serverId);

  // 用户从订阅分组主动移除的节点，标记为排除，避免下次刷新自动加回
  if (wasSubscriptionMember) {
    const key = buildServerKey(server);
    if (!group.excludedSubscriptionKeys.includes(key)) {
      group.excludedSubscriptionKeys.push(key);
    }
  }

  if (server.groupId === group.id) {
    delete server.groupId;
  }
}

/**
 * 保存后统一广播配置变更（触发主进程的代理热更新 / 重启逻辑）
 */
function broadcastConfigChanged(config: import('../../../shared/types').UserConfig): void {
  ipcEventEmitter.sendToAll(CHANNELS.EVENT_CONFIG_CHANGED, { newValue: config });
  mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
}

/**
 * 根据订阅 URL 推导分组名
 */
function deriveGroupName(url: string | undefined, count: number): string {
  let base = '订阅分组';
  if (url) {
    try {
      const u = new URL(url);
      const host = u.hostname || '';
      const seg = u.pathname.split('/').filter(Boolean).pop() || '';
      base = seg && seg.length <= 20 ? seg : host || '订阅分组';
    } catch {
      // 忽略解析失败
    }
  }
  return `${base} (${count})`;
}

/**
 * 生成服务器的去重特征键
 * 用于订阅重复导入时判断是否为同一节点
 */
function buildServerKey(server: ServerConfig): string {
  return [
    server.protocol?.toLowerCase(),
    server.address,
    server.port,
    server.uuid || '',
    server.password || '',
    server.flow || '',
    server.network || '',
    server.wsSettings?.path || '',
    server.grpcSettings?.serviceName || '',
    server.tlsSettings?.serverName || '',
  ].join('|');
}
