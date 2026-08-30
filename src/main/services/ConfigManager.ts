/**
 * 配置管理服务
 * 负责用户配置的加载、保存、验证和管理
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { UserConfig } from '../../shared/types';
import { getConfigPath } from '../utils/paths';

export interface IConfigManager {
  loadConfig(): Promise<UserConfig>;
  saveConfig(config: UserConfig): Promise<void>;
  get<T>(key: keyof UserConfig): T | undefined;
  set(key: keyof UserConfig, value: any): Promise<void>;
  validateConfig(config: UserConfig): void;
  getConfigPath(): string;
}

export class ConfigManager implements IConfigManager {
  private configPath: string;
  private currentConfig: UserConfig | null = null;

  constructor(customConfigPath?: string) {
    if (customConfigPath) {
      this.configPath = customConfigPath;
    } else {
      // 使用统一的路径工具，确保始终使用正确的用户数据路径
      this.configPath = getConfigPath();
    }
  }

  /**
   * 获取配置文件路径
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * 加载配置文件
   * 如果文件不存在或损坏，返回默认配置
   */
  async loadConfig(): Promise<UserConfig> {
    try {
      await fs.access(this.configPath);
    } catch {
      // 文件不存在（首次启动），创建默认配置
      const defaultConfig = this.createDefaultConfig();
      this.currentConfig = defaultConfig;
      await this.saveConfig(defaultConfig);
      console.info('默认配置已创建:', this.configPath);
      return defaultConfig;
    }

    // 文件存在，读取并验证
    const content = await fs.readFile(this.configPath, 'utf-8');
    const config = JSON.parse(content) as UserConfig;
    this.validateConfig(config);
    this.currentConfig = config;
    return config;
  }

  /**
   * 保存配置文件
   */
  async saveConfig(config: UserConfig): Promise<void> {
    // 验证配置
    this.validateConfig(config);

    // 确保配置目录存在
    const configDir = path.dirname(this.configPath);
    await fs.mkdir(configDir, { recursive: true });

    // 写入配置文件
    const content = JSON.stringify(config, null, 2);
    await fs.writeFile(this.configPath, content, 'utf-8');

    // 设置文件权限（仅所有者可读写）
    if (process.platform !== 'win32') {
      await fs.chmod(this.configPath, 0o600);
    }

    // 更新缓存
    this.currentConfig = config;
  }

  /**
   * 获取配置项
   */
  get<T>(key: keyof UserConfig): T | undefined {
    if (!this.currentConfig) {
      return undefined;
    }
    return this.currentConfig[key] as T;
  }

  /**
   * 设置配置项
   */
  async set(key: keyof UserConfig, value: any): Promise<void> {
    if (!this.currentConfig) {
      this.currentConfig = this.createDefaultConfig();
    }

    // 更新配置项
    (this.currentConfig as any)[key] = value;

    // 保存配置
    await this.saveConfig(this.currentConfig);
  }

  /**
   * 验证配置有效性
   */
  validateConfig(config: UserConfig): void {
    // 验证必填字段
    if (!config) {
      throw new Error('Config is null or undefined');
    }

    // 验证 servers 数组
    if (!Array.isArray(config.servers)) {
      throw new Error('servers must be an array');
    }

    // 验证每个服务器配置
    for (const server of config.servers) {
      if (!server.id || typeof server.id !== 'string') {
        throw new Error('Server id is required and must be a string');
      }
      if (!server.name || typeof server.name !== 'string') {
        throw new Error('Server name is required and must be a string');
      }
      const protocolLower = server.protocol?.toLowerCase();
      if (!protocolLower || !['vless', 'trojan', 'hysteria2'].includes(protocolLower)) {
        throw new Error('Server protocol must be vless or trojan');
      }
      if (!server.address || typeof server.address !== 'string') {
        throw new Error('Server address is required and must be a string');
      }
      if (
        !server.port ||
        typeof server.port !== 'number' ||
        server.port < 1 ||
        server.port > 65535
      ) {
        throw new Error('Server port must be a number between 1 and 65535');
      }

      // VLESS 特定验证
      if (protocolLower === 'vless') {
        if (!server.uuid || typeof server.uuid !== 'string') {
          throw new Error('VLESS server requires uuid');
        }
      }

      // Trojan 特定验证
      if (protocolLower === 'trojan') {
        if (!server.password || typeof server.password !== 'string') {
          throw new Error('Trojan server requires password');
        }
      }
    }

    // 验证 selectedServerId
    if (config.selectedServerId !== null) {
      if (typeof config.selectedServerId !== 'string') {
        throw new Error('selectedServerId must be a string or null');
      }
      // 检查服务器是否存在
      const serverExists = config.servers.some((s) => s.id === config.selectedServerId);
      if (!serverExists) {
        throw new Error('selectedServerId references a non-existent server');
      }
    }

    // 兼容旧配置：serverGroups 缺失时初始化为空数组
    if (!Array.isArray(config.serverGroups)) {
      config.serverGroups = [];
    }

    // 验证 serverGroups
    for (const group of config.serverGroups) {
      if (!group.id || typeof group.id !== 'string') {
        throw new Error('Group id is required and must be a string');
      }
      if (!group.name || typeof group.name !== 'string') {
        throw new Error('Group name is required and must be a string');
      }
      if (!Array.isArray(group.serverIds)) {
        throw new Error('Group serverIds must be an array');
      }

      // 兼容已有订阅分组：历史成员全部视为订阅成员；无订阅 URL 的
      // 手动分组则视为手动成员。后续刷新可据此保留手动添加的节点。
      if (!Array.isArray(group.subscriptionServerIds)) {
        group.subscriptionServerIds = group.url ? [...group.serverIds] : [];
      }
      if (!Array.isArray(group.manualServerIds)) {
        group.manualServerIds = group.url ? [] : [...group.serverIds];
      }
      if (!Array.isArray(group.excludedSubscriptionKeys)) {
        group.excludedSubscriptionKeys = [];
      }

      group.serverIds = Array.from(
        new Set([...group.subscriptionServerIds, ...group.manualServerIds])
      );
    }

    // 验证 selectedGroupId
    if (config.selectedGroupId !== undefined && config.selectedGroupId !== null) {
      if (typeof config.selectedGroupId !== 'string') {
        throw new Error('selectedGroupId must be a string or null');
      }
      const groupExists = config.serverGroups.some((g) => g.id === config.selectedGroupId);
      if (!groupExists) {
        throw new Error('selectedGroupId references a non-existent group');
      }
    }
    // 兼容旧配置：selectedGroupId 缺失时初始化为 null
    if (config.selectedGroupId === undefined) {
      config.selectedGroupId = null;
    }

    // 分组和单节点是互斥出站。兼容早期分组实现曾可能保存两者的配置，
    // 沿用代理侧原有的分组优先级，避免加载后出现歧义。
    if (config.selectedGroupId && config.selectedServerId) {
      config.selectedServerId = null;
    }

    // 验证 proxyMode（不区分大小写）
    const proxyModeLower = config.proxyMode?.toLowerCase();
    if (!proxyModeLower || !['global', 'smart', 'direct'].includes(proxyModeLower)) {
      throw new Error('proxyMode must be global, smart, or direct');
    }

    // 验证 proxyModeType（不区分大小写）
    const modeTypeLower = config.proxyModeType?.toLowerCase();
    if (!modeTypeLower || !['systemproxy', 'tun'].includes(modeTypeLower)) {
      throw new Error('proxyModeType must be systemProxy or tun');
    }

    // 验证 tunConfig
    if (!config.tunConfig) {
      throw new Error('tunConfig is required');
    }
    if (
      typeof config.tunConfig.mtu !== 'number' ||
      config.tunConfig.mtu < 1280 ||
      config.tunConfig.mtu > 65535
    ) {
      throw new Error('tunConfig.mtu must be a number between 1280 and 65535');
    }
    if (!['system', 'gvisor', 'mixed'].includes(config.tunConfig.stack)) {
      throw new Error('tunConfig.stack must be system, gvisor, or mixed');
    }
    if (typeof config.tunConfig.autoRoute !== 'boolean') {
      throw new Error('tunConfig.autoRoute must be a boolean');
    }
    if (typeof config.tunConfig.strictRoute !== 'boolean') {
      throw new Error('tunConfig.strictRoute must be a boolean');
    }

    // 验证 customRules
    if (!Array.isArray(config.customRules)) {
      throw new Error('customRules must be an array');
    }
    for (const rule of config.customRules) {
      if (!rule.id || typeof rule.id !== 'string') {
        throw new Error('Rule id is required and must be a string');
      }
      if (!Array.isArray(rule.domains) || rule.domains.length === 0) {
        throw new Error('Rule domains is required and must be a non-empty array');
      }
      for (const domain of rule.domains) {
        if (typeof domain !== 'string' || !domain.trim()) {
          throw new Error('Each domain must be a non-empty string');
        }
      }
      if (!['proxy', 'direct', 'block'].includes(rule.action)) {
        throw new Error('Rule action must be proxy, direct, or block');
      }
      if (typeof rule.enabled !== 'boolean') {
        throw new Error('Rule enabled must be a boolean');
      }
    }

    // 验证布尔值字段
    if (typeof config.autoStart !== 'boolean') {
      throw new Error('autoStart must be a boolean');
    }
    if (typeof config.autoConnect !== 'boolean') {
      throw new Error('autoConnect must be a boolean');
    }
    if (typeof config.minimizeToTray !== 'boolean') {
      throw new Error('minimizeToTray must be a boolean');
    }
    // autoCheckUpdate 是可选字段，兼容旧配置
    if (config.autoCheckUpdate !== undefined && typeof config.autoCheckUpdate !== 'boolean') {
      throw new Error('autoCheckUpdate must be a boolean');
    }
    // 如果未定义，设置默认值
    if (config.autoCheckUpdate === undefined) {
      config.autoCheckUpdate = true;
    }

    // 验证端口
    if (typeof config.socksPort !== 'number' || config.socksPort < 1 || config.socksPort > 65535) {
      throw new Error('socksPort must be a number between 1 and 65535');
    }
    if (typeof config.httpPort !== 'number' || config.httpPort < 1 || config.httpPort > 65535) {
      throw new Error('httpPort must be a number between 1 and 65535');
    }

    // 验证日志级别
    if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(config.logLevel)) {
      throw new Error('logLevel must be debug, info, warn, error, or fatal');
    }

    // 验证 autoSelect 配置（可选字段，兼容旧配置）
    if (config.autoSelect === undefined) {
      config.autoSelect = {
        enabled: false,
        mode: 'latency',
        interval: 60,
        failoverEnabled: true,
      };
    } else {
      if (typeof config.autoSelect.enabled !== 'boolean') {
        throw new Error('autoSelect.enabled must be a boolean');
      }
      if (!['latency', 'speed'].includes(config.autoSelect.mode)) {
        throw new Error('autoSelect.mode must be latency or speed');
      }
      if (typeof config.autoSelect.interval !== 'number' || config.autoSelect.interval < 10) {
        throw new Error('autoSelect.interval must be a number >= 10');
      }
      if (typeof config.autoSelect.failoverEnabled !== 'boolean') {
        throw new Error('autoSelect.failoverEnabled must be a boolean');
      }
    }
  }

  /**
   * 创建默认配置
   */
  private createDefaultConfig(): UserConfig {
    return {
      servers: [],
      selectedServerId: null,
      serverGroups: [],
      selectedGroupId: null,
      proxyMode: 'global',
      proxyModeType: 'systemProxy', // 默认使用系统代理模式，不需要管理员权限
      tunConfig: {
        mtu: 9000,
        stack: 'system',
        autoRoute: true,
        strictRoute: true,
      },
      customRules: [],
      autoStart: false,
      autoConnect: false,
      minimizeToTray: true,
      autoCheckUpdate: true, // 默认启用启动时自动检查更新
      socksPort: 65534,
      httpPort: 65533,
      logLevel: 'info',
      autoSelect: {
        enabled: false,
        mode: 'latency',
        interval: 60,
        failoverEnabled: true,
      },
    };
  }
}
