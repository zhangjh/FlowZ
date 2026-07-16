/**
 * Bridge types for compatibility with old code
 * Re-exports types from shared types
 */

export type {
  UserConfig,
  ServerConfig,
  DomainRule,
  ProxyStatus,
  TrafficStats,
  LogEntry,
  ApiResponse,
  AutoSelectStatus,
  ServerSpeedResult,
  AutoSelectConfig,
} from '../../shared/types';
export type ProxyMode = 'global' | 'smart' | 'direct';
export type ProxyModeType = 'systemProxy' | 'tun';
export type ProtocolType = 'vless' | 'trojan' | 'hysteria2';

// 兼容旧代码的类型别名
export type ServerConfigWithId = import('../../shared/types').ServerConfig;

// 连接状态类型
export interface ConnectionStatus {
  proxyCore: {
    running: boolean;
    pid?: number;
    uptime?: number;
    error?: string;
  };
  proxy: {
    enabled: boolean;
    server?: string;
  };
  proxyModeType: ProxyModeType;
}

// TUN 模式配置
export interface TunModeConfig {
  mtu: number;
  stack: 'system' | 'gvisor' | 'mixed';
  autoRoute: boolean;
  strictRoute: boolean;
  interfaceName?: string;
  inet4Address?: string;
  inet6Address?: string;
}

// TLS 设置
export interface TlsSettings {
  serverName?: string;
  allowInsecure?: boolean;
}

// WebSocket 设置
export interface WsSettings {
  path?: string;
  host?: string;
}

// 事件数据类型
export interface NativeEventData {
  processStarted: { pid: number; timestamp: string };
  processStopped: { timestamp: string };
  processError: { error: string; timestamp: string };
  configChanged: { key?: string; oldValue?: any; newValue?: any };
  statsUpdated: any;
  navigateToPage: string;
  proxyModeSwitched: { success: boolean; newMode: string };
  proxyModeSwitchFailed: { success: boolean; error: string };
}

export type NativeEventListener<K extends keyof NativeEventData> = (
  data: NativeEventData[K]
) => void;
