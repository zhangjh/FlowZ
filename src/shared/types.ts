/**
 * 共享类型定义
 * 用于主进程和渲染进程之间的数据传输
 */

// ============================================================================
// 基础类型
// ============================================================================

export type ProxyMode = 'global' | 'smart' | 'direct';
export type ProxyModeType = 'systemProxy' | 'tun';
export type Protocol = 'vless' | 'trojan' | 'hysteria2';
export type Network = 'tcp' | 'ws' | 'grpc' | 'http';
export type Hysteria2Network = 'tcp' | 'udp';
export type Security = 'none' | 'tls' | 'reality';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type RuleAction = 'proxy' | 'direct' | 'block';
export type TunStack = 'system' | 'gvisor' | 'mixed';

// ============================================================================
// 服务器配置
// ============================================================================

export interface TlsSettings {
  serverName?: string;
  allowInsecure?: boolean;
  alpn?: string[];
  fingerprint?: string;
}

export interface RealitySettings {
  publicKey: string;
  shortId?: string;
}

export interface WebSocketSettings {
  path?: string;
  headers?: Record<string, string>;
  maxEarlyData?: number;
  earlyDataHeaderName?: string;
}

export interface GrpcSettings {
  serviceName?: string;
  multiMode?: boolean;
}

export interface HttpSettings {
  host?: string[];
  path?: string;
  method?: string;
  headers?: Record<string, string[]>;
}

// Hysteria2 混淆设置
export interface Hysteria2ObfsSettings {
  type?: 'salamander';
  password?: string;
}

// Hysteria2 协议设置
export interface Hysteria2Settings {
  upMbps?: number;
  downMbps?: number;
  obfs?: Hysteria2ObfsSettings;
  network?: Hysteria2Network;
}

export interface ServerConfig {
  id: string;
  name: string;
  protocol: Protocol;
  address: string;
  port: number;

  // VLESS 特定
  uuid?: string;
  encryption?: string;
  flow?: string;

  // Trojan 和 Hysteria2 通用
  password?: string;

  // Hysteria2 特定
  hysteria2Settings?: Hysteria2Settings;

  // 传输层配置
  network?: Network;
  security?: Security;

  // TLS 配置
  tlsSettings?: TlsSettings;

  // Reality 配置
  realitySettings?: RealitySettings;

  // 传输层特定配置
  wsSettings?: WebSocketSettings;
  grpcSettings?: GrpcSettings;
  httpSettings?: HttpSettings;

  // 元数据
  createdAt?: string;
  updatedAt?: string;
}

// ============================================================================
// 路由规则
// ============================================================================

export interface DomainRule {
  id: string;
  domains: string[];
  action: RuleAction;
  enabled: boolean;
  /** 绕过 FakeIP，使用真实 DNS 解析（解决 QUIC 等协议兼容性问题） */
  bypassFakeIP?: boolean;
}

// ============================================================================
// TUN 模式配置
// ============================================================================

export interface TunModeConfig {
  mtu: number;
  stack: TunStack;
  autoRoute: boolean;
  strictRoute: boolean;
  interfaceName?: string;
  inet4Address?: string;
  inet6Address?: string;
}

// ============================================================================
// 自动选择配置
// ============================================================================

export type AutoSelectMode = 'latency' | 'speed';

export interface AutoSelectConfig {
  enabled: boolean;
  mode: AutoSelectMode;
  interval: number;
  failoverEnabled: boolean;
}

// 服务器测速结果
export interface ServerSpeedResult {
  serverId: string;
  latency: number | null;
  downloadSpeed: number | null;
  lastTestTime: string;
  error?: string;
}

// 自动选择状态
export interface AutoSelectStatus {
  enabled: boolean;
  currentBestServerId: string | null;
  lastTestResults: ServerSpeedResult[];
  lastTestTime: string | null;
  failoverCount: number;
}

// ============================================================================
// 用户配置
// ============================================================================

export interface UserConfig {
  // 服务器配置
  servers: ServerConfig[];
  selectedServerId: string | null;

  // 代理模式
  proxyMode: ProxyMode;
  proxyModeType: ProxyModeType;

  // TUN 模式配置
  tunConfig: TunModeConfig;

  // 路由规则
  customRules: DomainRule[];

  // 应用设置
  autoStart: boolean;
  autoConnect: boolean;
  minimizeToTray: boolean;
  autoCheckUpdate: boolean;

  // 端口配置
  socksPort: number;
  httpPort: number;

  // 日志设置
  logLevel: LogLevel;

  // 自动选择配置
  autoSelect: AutoSelectConfig;
}

// ============================================================================
// 代理状态
// ============================================================================

export interface ProxyStatus {
  running: boolean;
  pid?: number;
  startTime?: Date;
  uptime?: number;
  error?: string;
  currentServer?: ServerConfig;
}

// ============================================================================
// 系统代理状态
// ============================================================================

export interface SystemProxyStatus {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  bypassList?: string[];
}

// ============================================================================
// 日志条目
// ============================================================================

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
  stack?: string;
}

// ============================================================================
// 流量统计
// ============================================================================

export interface TrafficStats {
  uploadSpeed: number;
  downloadSpeed: number;
  totalUpload: number;
  totalDownload: number;
}

// ============================================================================
// API 响应
// ============================================================================

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

// ============================================================================
// 连接状态
// ============================================================================

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error';

export interface ConnectionStateInfo {
  state: ConnectionState;
  message?: string;
  error?: string;
}

// ============================================================================
// 自启动状态
// ============================================================================

export interface AutoStartStatus {
  enabled: boolean;
  path?: string;
}

// ============================================================================
// 平台信息
// ============================================================================

export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  isAdmin: boolean;
}
