/**
 * 协议解析服务
 * 负责解析 VLESS 和 Trojan 协议 URL
 */

import { randomUUID } from 'crypto';
import type {
  ServerConfig,
  Protocol,
  Network,
  Security,
  TlsSettings,
  RealitySettings,
  WebSocketSettings,
  GrpcSettings,
  HttpSettings,
  Hysteria2Settings,
  Hysteria2Network,
} from '../../shared/types';

export interface IProtocolParser {
  /**
   * 检查 URL 是否为支持的协议
   */
  isSupported(url: string): boolean;

  /**
   * 解析协议 URL 为服务器配置
   */
  parseUrl(url: string): ServerConfig;

  /**
   * 将服务器配置生成为分享 URL
   */
  generateUrl(config: ServerConfig): string;

  /**
   * 批量解析订阅文本（多行协议链接）
   * 会自动过滤空行、注释行和无法识别的行，单行失败不会影响其他行
   * @param text 订阅文本，每行一个协议链接
   * @returns 解析出的服务器配置数组
   */
  parseMany(text: string): ServerConfig[];
}

export class ProtocolParser implements IProtocolParser {
  /**
   * 检查 URL 是否为支持的协议
   */
  isSupported(url: string): boolean {
    return (
      url.startsWith('vless://') ||
      url.startsWith('trojan://') ||
      url.startsWith('hysteria2://') ||
      url.startsWith('hy2://')
    );
  }

  /**
   * 批量解析订阅文本（多行协议链接）
   */
  parseMany(text: string): ServerConfig[] {
    if (!text) return [];

    // 按行拆分，兼容 \r\n 和 \n
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      // 过滤空行、注释行（# 开头）、非协议行
      .filter((line) => line && !line.startsWith('#') && this.isSupported(line));

    const servers: ServerConfig[] = [];

    for (const line of lines) {
      try {
        servers.push(this.parseUrl(line));
      } catch (error) {
        // 单行解析失败不影响其他行，记录日志并跳过
        console.warn(
          `[订阅解析] 跳过无效链接: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return servers;
  }

  /**
   * 解析协议 URL 为服务器配置
   */
  parseUrl(url: string): ServerConfig {
    if (!this.isSupported(url)) {
      throw new Error(`不支持的协议: ${url.split('://')[0]}`);
    }

    try {
      const urlObj = new URL(url);
      let protocolStr = urlObj.protocol.replace(':', '');

      // hy2 是 hysteria2 的别名
      if (protocolStr === 'hy2') {
        protocolStr = 'hysteria2';
      }

      const protocol = protocolStr as Protocol;

      if (protocol === 'vless') {
        return this.parseVless(urlObj);
      } else if (protocol === 'trojan') {
        return this.parseTrojan(urlObj);
      } else if (protocol === 'hysteria2') {
        return this.parseHysteria2(urlObj);
      }

      throw new Error(`不支持的协议: ${protocol}`);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`URL 解析失败: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 解析 VLESS URL
   * 格式: vless://uuid@address:port?encryption=none&security=tls&type=ws&host=example.com&path=/path#name
   */
  private parseVless(url: URL): ServerConfig {
    const uuid = url.username;
    const address = url.hostname;
    const port = parseInt(url.port) || 443;
    const params = new URLSearchParams(url.search);
    const name = decodeURIComponent(url.hash.slice(1)) || `${address}:${port}`;

    if (!uuid) {
      throw new Error('VLESS URL 缺少 UUID');
    }

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'vless',
      address,
      port,
      uuid,
      encryption: params.get('encryption') || 'none',
      flow: params.get('flow') || undefined,
    };

    // 解析传输层配置
    const network = params.get('type') as Network | null;
    if (network) {
      config.network = network;
      this.parseTransportSettings(config, params, network);
    }

    // 解析安全配置
    const security = params.get('security') as Security | null;
    if (security) {
      config.security = security;
      if (security === 'tls' || security === 'reality') {
        config.tlsSettings = this.parseTlsSettings(params);
      }
      if (security === 'reality') {
        config.realitySettings = this.parseRealitySettings(params);
      }
    }

    return config;
  }

  /**
   * 解析 Trojan URL
   * 格式: trojan://password@address:port?security=tls&type=ws&host=example.com&path=/path#name
   */
  private parseTrojan(url: URL): ServerConfig {
    const password = decodeURIComponent(url.username);
    const address = url.hostname;
    const port = parseInt(url.port) || 443;
    const params = new URLSearchParams(url.search);
    const name = decodeURIComponent(url.hash.slice(1)) || `${address}:${port}`;

    if (!password) {
      throw new Error('Trojan URL 缺少密码');
    }

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'trojan',
      address,
      port,
      password,
    };

    // 解析传输层配置
    const network = params.get('type') as Network | null;
    if (network) {
      config.network = network;
      this.parseTransportSettings(config, params, network);
    }

    // 解析安全配置
    const security = params.get('security') as Security | null;
    if (security) {
      config.security = security;
      if (security === 'tls' || security === 'reality') {
        config.tlsSettings = this.parseTlsSettings(params);
      }
      if (security === 'reality') {
        config.realitySettings = this.parseRealitySettings(params);
      }
    }

    return config;
  }

  /**
   * 解析 Hysteria2 URL
   * 格式: hysteria2://password@address:port?obfs=salamander&obfs-password=xxx&sni=example.com&insecure=1#name
   * 或者: hy2://password@address:port?...
   */
  private parseHysteria2(url: URL): ServerConfig {
    const password = decodeURIComponent(url.username);
    const address = url.hostname;
    const port = parseInt(url.port) || 443;
    const params = new URLSearchParams(url.search);
    const name = decodeURIComponent(url.hash.slice(1)) || `${address}:${port}`;

    if (!password) {
      throw new Error('Hysteria2 URL 缺少密码');
    }

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'hysteria2',
      address,
      port,
      password,
      // Hysteria2 协议必须使用 TLS
      security: 'tls',
    };

    // 解析 Hysteria2 特定配置
    const hysteria2Settings: Hysteria2Settings = {};

    // 解析带宽限制
    const upMbps = params.get('up_mbps') || params.get('up');
    const downMbps = params.get('down_mbps') || params.get('down');
    if (upMbps) {
      hysteria2Settings.upMbps = parseInt(upMbps);
    }
    if (downMbps) {
      hysteria2Settings.downMbps = parseInt(downMbps);
    }

    // 解析混淆配置
    const obfs = params.get('obfs');
    const obfsPassword = params.get('obfs-password');
    if (obfs === 'salamander' && obfsPassword) {
      hysteria2Settings.obfs = {
        type: 'salamander',
        password: obfsPassword,
      };
    }

    // 解析网络类型（tcp 或 udp）
    const network = params.get('network') as Hysteria2Network | null;
    if (network) {
      hysteria2Settings.network = network;
    }

    // 只有在有设置时才添加
    if (Object.keys(hysteria2Settings).length > 0) {
      config.hysteria2Settings = hysteria2Settings;
    }

    // 解析 TLS 配置
    const tlsSettings: TlsSettings = {};

    const sni = params.get('sni') || params.get('peer');
    if (sni) {
      tlsSettings.serverName = sni;
    }

    const insecure = params.get('insecure') || params.get('allowInsecure');
    if (insecure === '1' || insecure === 'true') {
      tlsSettings.allowInsecure = true;
    }

    const alpn = params.get('alpn');
    if (alpn) {
      tlsSettings.alpn = alpn.split(',');
    }

    if (Object.keys(tlsSettings).length > 0) {
      config.tlsSettings = tlsSettings;
    }

    return config;
  }

  /**
   * 解析传输层配置
   */
  private parseTransportSettings(
    config: ServerConfig,
    params: URLSearchParams,
    network: Network
  ): void {
    switch (network) {
      case 'ws':
        config.wsSettings = this.parseWebSocketSettings(params);
        break;
      case 'grpc':
        config.grpcSettings = this.parseGrpcSettings(params);
        break;
      case 'http':
        config.httpSettings = this.parseHttpSettings(params);
        break;
      case 'tcp':
        // TCP 不需要额外配置
        break;
      default:
        throw new Error(`不支持的传输层类型: ${network}`);
    }
  }

  /**
   * 解析 WebSocket 配置
   */
  private parseWebSocketSettings(params: URLSearchParams): WebSocketSettings {
    const settings: WebSocketSettings = {};

    const path = params.get('path');
    if (path) {
      settings.path = path;
    }

    const host = params.get('host');
    if (host) {
      settings.headers = { Host: host };
    }

    const maxEarlyData = params.get('maxEarlyData');
    if (maxEarlyData) {
      settings.maxEarlyData = parseInt(maxEarlyData);
    }

    const earlyDataHeaderName = params.get('earlyDataHeaderName');
    if (earlyDataHeaderName) {
      settings.earlyDataHeaderName = earlyDataHeaderName;
    }

    return settings;
  }

  /**
   * 解析 gRPC 配置
   */
  private parseGrpcSettings(params: URLSearchParams): GrpcSettings {
    const settings: GrpcSettings = {};

    const serviceName = params.get('serviceName');
    if (serviceName) {
      settings.serviceName = serviceName;
    }

    const multiMode = params.get('mode');
    if (multiMode === 'multi') {
      settings.multiMode = true;
    }

    return settings;
  }

  /**
   * 解析 HTTP 配置
   */
  private parseHttpSettings(params: URLSearchParams): HttpSettings {
    const settings: HttpSettings = {};

    const host = params.get('host');
    if (host) {
      settings.host = host.split(',');
    }

    const path = params.get('path');
    if (path) {
      settings.path = path;
    }

    const method = params.get('method');
    if (method) {
      settings.method = method;
    }

    return settings;
  }

  /**
   * 解析 TLS 配置
   */
  private parseTlsSettings(params: URLSearchParams): TlsSettings {
    const settings: TlsSettings = {};

    // SNI / Server Name
    const sni = params.get('sni') || params.get('host');
    if (sni) {
      settings.serverName = sni;
    }

    // Allow Insecure
    const allowInsecure = params.get('allowInsecure');
    if (allowInsecure !== null) {
      settings.allowInsecure = allowInsecure === '1' || allowInsecure === 'true';
    }

    // ALPN
    const alpn = params.get('alpn');
    if (alpn) {
      settings.alpn = alpn.split(',');
    }

    // Fingerprint
    const fingerprint = params.get('fp') || params.get('fingerprint');
    if (fingerprint) {
      settings.fingerprint = fingerprint;
    }

    return settings;
  }

  /**
   * 解析 Reality 配置
   */
  private parseRealitySettings(params: URLSearchParams): RealitySettings | undefined {
    const publicKey = params.get('pbk');
    if (!publicKey) {
      return undefined;
    }

    const settings: RealitySettings = {
      publicKey,
    };

    const shortId = params.get('sid');
    if (shortId) {
      settings.shortId = shortId;
    }

    return settings;
  }

  /**
   * 将服务器配置生成为分享 URL
   */
  generateUrl(config: ServerConfig): string {
    // 统一转换为小写进行比较，因为存储的协议值可能是大写或小写
    const protocol = config.protocol?.toLowerCase();

    if (protocol === 'vless') {
      return this.generateVlessUrl(config);
    } else if (protocol === 'trojan') {
      return this.generateTrojanUrl(config);
    } else if (protocol === 'hysteria2') {
      return this.generateHysteria2Url(config);
    }
    throw new Error(`不支持的协议: ${config.protocol}`);
  }

  /**
   * 生成 VLESS URL
   */
  private generateVlessUrl(config: ServerConfig): string {
    const params = new URLSearchParams();

    // 加密方式
    if (config.encryption) {
      params.set('encryption', config.encryption);
    }

    // Flow
    if (config.flow) {
      params.set('flow', config.flow);
    }

    // 传输层配置
    this.appendTransportParams(params, config);

    // 安全配置
    this.appendSecurityParams(params, config);

    const name = encodeURIComponent(config.name || `${config.address}:${config.port}`);
    const queryString = params.toString();
    const queryPart = queryString ? `?${queryString}` : '';
    return `vless://${config.uuid}@${config.address}:${config.port}${queryPart}#${name}`;
  }

  /**
   * 生成 Trojan URL
   */
  private generateTrojanUrl(config: ServerConfig): string {
    const params = new URLSearchParams();

    // 传输层配置
    this.appendTransportParams(params, config);

    // 安全配置
    this.appendSecurityParams(params, config);

    const name = encodeURIComponent(config.name || `${config.address}:${config.port}`);
    const password = encodeURIComponent(config.password || '');
    const queryString = params.toString();
    const queryPart = queryString ? `?${queryString}` : '';
    return `trojan://${password}@${config.address}:${config.port}${queryPart}#${name}`;
  }

  /**
   * 生成 Hysteria2 URL
   */
  private generateHysteria2Url(config: ServerConfig): string {
    const params = new URLSearchParams();

    // Hysteria2 特定配置
    if (config.hysteria2Settings) {
      if (config.hysteria2Settings.upMbps) {
        params.set('up_mbps', config.hysteria2Settings.upMbps.toString());
      }
      if (config.hysteria2Settings.downMbps) {
        params.set('down_mbps', config.hysteria2Settings.downMbps.toString());
      }
      if (config.hysteria2Settings.obfs) {
        params.set('obfs', config.hysteria2Settings.obfs.type || 'salamander');
        if (config.hysteria2Settings.obfs.password) {
          params.set('obfs-password', config.hysteria2Settings.obfs.password);
        }
      }
      if (config.hysteria2Settings.network) {
        params.set('network', config.hysteria2Settings.network);
      }
    }

    // TLS 配置
    if (config.tlsSettings) {
      if (config.tlsSettings.serverName) {
        params.set('sni', config.tlsSettings.serverName);
      }
      if (config.tlsSettings.allowInsecure) {
        params.set('insecure', '1');
      }
      if (config.tlsSettings.alpn && config.tlsSettings.alpn.length > 0) {
        params.set('alpn', config.tlsSettings.alpn.join(','));
      }
    }

    const name = encodeURIComponent(config.name || `${config.address}:${config.port}`);
    const password = encodeURIComponent(config.password || '');
    const queryString = params.toString();
    const queryPart = queryString ? `?${queryString}` : '';
    return `hysteria2://${password}@${config.address}:${config.port}${queryPart}#${name}`;
  }

  /**
   * 添加传输层参数
   */
  private appendTransportParams(params: URLSearchParams, config: ServerConfig): void {
    if (config.network) {
      params.set('type', config.network);
    }

    // WebSocket 配置
    if (config.network === 'ws' && config.wsSettings) {
      if (config.wsSettings.path) {
        params.set('path', config.wsSettings.path);
      }
      if (config.wsSettings.headers?.Host) {
        params.set('host', config.wsSettings.headers.Host);
      }
      if (config.wsSettings.maxEarlyData) {
        params.set('maxEarlyData', config.wsSettings.maxEarlyData.toString());
      }
      if (config.wsSettings.earlyDataHeaderName) {
        params.set('earlyDataHeaderName', config.wsSettings.earlyDataHeaderName);
      }
    }

    // gRPC 配置
    if (config.network === 'grpc' && config.grpcSettings) {
      if (config.grpcSettings.serviceName) {
        params.set('serviceName', config.grpcSettings.serviceName);
      }
      if (config.grpcSettings.multiMode) {
        params.set('mode', 'multi');
      }
    }

    // HTTP 配置
    if (config.network === 'http' && config.httpSettings) {
      if (config.httpSettings.host) {
        params.set('host', config.httpSettings.host.join(','));
      }
      if (config.httpSettings.path) {
        params.set('path', config.httpSettings.path);
      }
      if (config.httpSettings.method) {
        params.set('method', config.httpSettings.method);
      }
    }
  }

  /**
   * 添加安全参数
   */
  private appendSecurityParams(params: URLSearchParams, config: ServerConfig): void {
    if (config.security) {
      params.set('security', config.security);
    }

    if (config.tlsSettings) {
      if (config.tlsSettings.serverName) {
        params.set('sni', config.tlsSettings.serverName);
      }
      if (config.tlsSettings.allowInsecure) {
        params.set('allowInsecure', '1');
      }
      if (config.tlsSettings.alpn && config.tlsSettings.alpn.length > 0) {
        params.set('alpn', config.tlsSettings.alpn.join(','));
      }
      if (config.tlsSettings.fingerprint) {
        params.set('fp', config.tlsSettings.fingerprint);
      }
    }

    if (config.security === 'reality' && config.realitySettings) {
      params.set('pbk', config.realitySettings.publicKey);
      if (config.realitySettings.shortId) {
        params.set('sid', config.realitySettings.shortId);
      }
    }
  }
}
