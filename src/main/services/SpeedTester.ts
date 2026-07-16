/**
 * 服务器速度测试服务
 * 通过启动临时 sing-box 进程来测试服务器延迟（与托盘测速相同方式）
 */

import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import type { ServerConfig } from '../../shared/types';
import { resourceManager } from './ResourceManager';
import { getUserDataPath } from '../utils/paths';

export interface SpeedTestResult {
  latency: number | null;
  downloadSpeed: number | null;
  error?: string;
}

export interface ISpeedTester {
  testLatency(server: ServerConfig, timeout?: number): Promise<number | null>;
  testDownloadSpeed(proxyPort: number, timeout?: number): Promise<number | null>;
  testServer(server: ServerConfig, proxyPort?: number): Promise<SpeedTestResult>;
  testMultipleServers(
    servers: ServerConfig[],
    proxyPort?: number,
    concurrency?: number
  ): Promise<Map<string, SpeedTestResult>>;
}

const BASE_PORT = 65401;
const TEST_TIMEOUT = 12000;
const SINGBOX_STARTUP_TIMEOUT = 20000;

function isIPAddress(value: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  // IPv6
  if (value.includes(':')) return true;
  return false;
}

function buildOutbound(server: ServerConfig, tag: string): any {
  const protocol = server.protocol.toLowerCase();
  const outbound: any = {
    type: protocol,
    tag,
    server: server.address,
    server_port: server.port,
  };

  if (protocol === 'vless') {
    outbound.uuid = server.uuid;
    if (server.flow) outbound.flow = server.flow;
    outbound.packet_encoding = 'xudp';
  }
  if (protocol === 'trojan') {
    outbound.password = server.password;
  }
  if (protocol === 'hysteria2') {
    outbound.password = server.password;
    if (server.hysteria2Settings?.upMbps) outbound.up_mbps = server.hysteria2Settings.upMbps;
    if (server.hysteria2Settings?.downMbps) outbound.down_mbps = server.hysteria2Settings.downMbps;
    if (server.hysteria2Settings?.obfs?.type && server.hysteria2Settings?.obfs?.password) {
      outbound.obfs = {
        type: server.hysteria2Settings.obfs.type,
        password: server.hysteria2Settings.obfs.password,
      };
    }
    if (server.hysteria2Settings?.network) outbound.network = server.hysteria2Settings.network;
  }

  // TLS / Reality
  if (server.security === 'reality' && server.realitySettings) {
    outbound.tls = {
      enabled: true,
      server_name: server.tlsSettings?.serverName || server.address,
      utls: { enabled: true, fingerprint: server.tlsSettings?.fingerprint || 'chrome' },
      reality: {
        enabled: true,
        public_key: server.realitySettings.publicKey,
        short_id: server.realitySettings.shortId || '',
      },
    };
  } else if (server.security === 'tls' || server.tlsSettings) {
    outbound.tls = {
      enabled: true,
      server_name: server.tlsSettings?.serverName || server.address,
      insecure: server.tlsSettings?.allowInsecure || false,
    };
    if (protocol !== 'hysteria2') {
      outbound.tls.utls = {
        enabled: true,
        fingerprint: server.tlsSettings?.fingerprint || 'chrome',
      };
    }
    if (server.tlsSettings?.alpn) outbound.tls.alpn = server.tlsSettings.alpn;
  }

  // 传输层 (WS/gRPC)
  const network = server.network?.toLowerCase();
  if (protocol !== 'hysteria2' && network && network !== 'tcp') {
    outbound.transport = { type: network };
    if (network === 'ws' && server.wsSettings) {
      outbound.transport.path = server.wsSettings.path || '/';
      if (server.wsSettings.headers) outbound.transport.headers = server.wsSettings.headers;
    }
    if (network === 'grpc' && server.grpcSettings) {
      outbound.transport.service_name = server.grpcSettings.serviceName || '';
    }
  }

  return outbound;
}

function buildTestConfig(servers: ServerConfig[]): any {
  const inbounds: any[] = [];
  const outbounds: any[] = [];
  const routeRules: any[] = [];
  const serverDomains: string[] = [];
  const serverIPs: string[] = [];

  servers.forEach((server, i) => {
    const outboundTag = `proxy-${i}`;
    const inboundTag = `speed-in-${i}`;

    inbounds.push({
      type: 'http',
      tag: inboundTag,
      listen: '127.0.0.1',
      listen_port: BASE_PORT + i,
    });

    outbounds.push(buildOutbound(server, outboundTag));

    routeRules.push({
      inbound: [inboundTag],
      outbound: outboundTag,
    });

    if (isIPAddress(server.address)) {
      const cidr = server.address.includes(':')
        ? `${server.address}/128`
        : `${server.address}/32`;
      if (!serverIPs.includes(cidr)) serverIPs.push(cidr);
    } else {
      if (!serverDomains.includes(server.address)) {
        serverDomains.push(server.address);
      }
    }
  });

  outbounds.push({ type: 'direct', tag: 'direct' });
  outbounds.push({ type: 'block', tag: 'block' });

  if (serverDomains.length > 0) {
    routeRules.unshift({ domain: serverDomains, outbound: 'direct' });
  }
  if (serverIPs.length > 0) {
    routeRules.unshift({ ip_cidr: serverIPs, outbound: 'direct' });
  }

  const dnsConfig: any = {
    servers: [{ tag: 'dns-local', type: 'local' }],
    rules: [],
    final: 'dns-local',
  };
  if (serverDomains.length > 0) {
    dnsConfig.rules.push({ domain: serverDomains, server: 'dns-local' });
  }

  return {
    log: { level: 'info', timestamp: true },
    dns: dnsConfig,
    inbounds,
    outbounds,
    route: {
      rules: routeRules,
      auto_detect_interface: true,
      default_domain_resolver: 'dns-local',
      final: 'direct',
    },
  };
}

function doOneRequest(port: number, timeout: number): Promise<{ ok: boolean; latency: number; statusCode?: number; error?: string }> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const testUrl = 'http://www.gstatic.com/generate_204';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: testUrl,
        method: 'GET',
        timeout,
        headers: { Host: 'www.gstatic.com', 'User-Agent': 'FlowZ-SpeedTest/1.0' },
      },
      (res) => {
        const latency = Date.now() - startTime;
        res.resume();
        res.on('end', () => resolve({ ok: true, latency, statusCode: res.statusCode }));
      }
    );
    req.on('error', (err) => resolve({ ok: false, latency: Date.now() - startTime, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, latency: Date.now() - startTime, error: 'TIMEOUT' }); });
    req.end();
  });
}

export class SpeedTester implements ISpeedTester {
  /**
   * 测试单个服务器延迟（通过临时 sing-box 代理）
   */
  async testLatency(server: ServerConfig, _timeout?: number): Promise<number | null> {
    const results = await this.testMultipleServers([server]);
    const result = results.get(server.id);
    return result?.latency ?? null;
  }

  /**
   * 测试下载速度（通过本地代理下载测试文件）
   * 注：当前版本暂不支持通过临时 sing-box 测速时的下载速度测试
   */
  async testDownloadSpeed(_proxyPort: number, _timeout?: number): Promise<number | null> {
    return null;
  }

  /**
   * 综合测试服务器
   */
  async testServer(server: ServerConfig, proxyPort?: number): Promise<SpeedTestResult> {
    const latency = await this.testLatency(server);

    let downloadSpeed: number | null = null;
    if (proxyPort && latency !== null) {
      downloadSpeed = await this.testDownloadSpeed(proxyPort);
    }

    return {
      latency,
      downloadSpeed,
    };
  }

  /**
   * 批量测试多个服务器（启动临时 sing-box 进程，与托盘测速相同方式）
   */
  async testMultipleServers(
    servers: ServerConfig[],
    _proxyPort?: number,
    _concurrency?: number
  ): Promise<Map<string, SpeedTestResult>> {
    if (servers.length === 0) {
      return new Map();
    }

    const results = new Map<string, SpeedTestResult>();
    let testProc: ReturnType<typeof spawn> | null = null;
    let testConfigPath = '';

    try {
      // 构建测试配置
      const testConfig = buildTestConfig(servers);
      const userDataPath = getUserDataPath();
      testConfigPath = path.join(userDataPath, 'speedtest_config.json');
      await fs.writeFile(testConfigPath, JSON.stringify(testConfig, null, 2));

      // 验证配置
      const singboxPath = resourceManager.getSingBoxPath();
      try {
        execSync(`"${singboxPath}" check -c "${testConfigPath}"`, {
          encoding: 'utf-8',
          timeout: 10000,
        });
      } catch {
        // 配置校验失败，所有服务器标记为不可用
        for (const server of servers) {
          results.set(server.id, { latency: null, downloadSpeed: null, error: '配置校验失败' });
        }
        return results;
      }

      // 启动临时 sing-box
      testProc = spawn(singboxPath, ['run', '-c', testConfigPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let processExited = false;
      testProc.on('exit', () => { processExited = true; });

      // 等待 sing-box 就绪
      const startupOk = await new Promise<boolean>((resolve) => {
        const startTime = Date.now();
        const check = () => {
          if (processExited) { resolve(false); return; }
          if (Date.now() - startTime > SINGBOX_STARTUP_TIMEOUT) { resolve(false); return; }
          const sock = new net.Socket();
          sock.setTimeout(500);
          sock.on('connect', () => { sock.destroy(); resolve(true); });
          sock.on('error', () => { sock.destroy(); setTimeout(check, 500); });
          sock.on('timeout', () => { sock.destroy(); setTimeout(check, 500); });
          sock.connect(BASE_PORT, '127.0.0.1');
        };
        setTimeout(check, 1000);
      });

      if (!startupOk) {
        for (const server of servers) {
          results.set(server.id, { latency: null, downloadSpeed: null, error: 'sing-box 启动失败' });
        }
        return results;
      }

      // 逐个测试服务器（每个先预热再实测）
      for (let i = 0; i < servers.length; i++) {
        const server = servers[i];
        const port = BASE_PORT + i;

        if (processExited) {
          results.set(server.id, { latency: null, downloadSpeed: null, error: 'sing-box 已退出' });
          continue;
        }

        // 预热请求
        const warmResult = await doOneRequest(port, TEST_TIMEOUT);
        if (!warmResult.ok) {
          results.set(server.id, { latency: null, downloadSpeed: null, error: warmResult.error || '连接失败' });
          continue;
        }

        // 实测请求
        const measuredResult = await doOneRequest(port, TEST_TIMEOUT);
        if (measuredResult.ok) {
          results.set(server.id, { latency: measuredResult.latency, downloadSpeed: null });
        } else {
          results.set(server.id, { latency: null, downloadSpeed: null, error: measuredResult.error || '连接失败' });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const server of servers) {
        if (!results.has(server.id)) {
          results.set(server.id, { latency: null, downloadSpeed: null, error: message });
        }
      }
    } finally {
      // 清理 sing-box 进程
      if (testProc && !testProc.killed) {
        testProc.kill();
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3000);
          testProc!.on('close', () => { clearTimeout(t); resolve(); });
        });
      }
      // 清理配置文件
      try { await fs.unlink(testConfigPath); } catch { /* ignore */ }
    }

    return results;
  }

  /**
   * 批量测试服务器延迟，返回 Map<serverId, latencyMs | null>
   * 供托盘测速等只需要延迟值的场景使用
   */
  async testMultipleServersLatency(servers: ServerConfig[]): Promise<Map<string, number | null>> {
    const fullResults = await this.testMultipleServers(servers);
    const latencyMap = new Map<string, number | null>();
    for (const [serverId, result] of fullResults) {
      latencyMap.set(serverId, result.latency);
    }
    return latencyMap;
  }
}
