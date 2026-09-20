/**
 * 服务器真实测速服务
 *
 * 与移动端（FlowZ Android）一致：启动一个临时 sing-box 内核，挂 N 个 loopback 入站
 * （每节点独立端口 + 独立出站，按 inbound 路由），并行（并发度 4）对每个节点依次
 * 真实拨号测速：
 *   1. 建连延迟（首个成功请求，含 QUIC/TCP/TLS 握手，UDP 系协议可能数秒）
 *   2. 会话延迟（隧道建立后稳定延迟）
 * 每节点整体 30s 超时，慢节点不拖死整批。
 *
 * 说明：不做带宽（下载）测试。并行测速时 N 路下载共享同一条本地出口链路，
 * 测得的下行只是"份额"而非节点真实带宽，数值会随并发与时段大幅波动、误导用户。
 */

import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as net from 'net';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import type { ServerConfig } from '../../shared/types';
import { resourceManager } from './ResourceManager';
import { getUserDataPath } from '../utils/paths';

export interface SpeedTestResult {
  /** 隧道建立后会话内的稳定延迟（毫秒），不可达为 null */
  latency: number | null;
  /** 建连耗时（首个成功请求，含 QUIC/TCP 握手），单独记录，UDP 系协议可能数秒 */
  dialLatency: number | null;
  /** 不可达时为失败原因 */
  error?: string;
}

export interface ISpeedTester {
  testLatency(server: ServerConfig, timeout?: number): Promise<number | null>;
  testServer(server: ServerConfig, proxyPort?: number): Promise<SpeedTestResult>;
  testMultipleServers(
    servers: ServerConfig[],
    proxyPort?: number,
    concurrency?: number
  ): Promise<Map<string, SpeedTestResult>>;
}

/** 单节点整体超时（含建连、会话），与移动端一致。 */
const NODE_TIMEOUT_MS = 30_000;
/** 并行并发度。 */
const DEFAULT_CONCURRENCY = 4;
/** 单次请求连接/读取超时。 */
const REQUEST_TIMEOUT_MS = 8_000;
const SINGBOX_STARTUP_TIMEOUT = 20_000;

/** 与移动端同一组境外连通性目标。 */
const PROBE_URLS = [
  'https://www.gstatic.com/generate_204',
  'https://cp.cloudflare.com/generate_204',
  'https://www.google.com/generate_204',
];

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

function buildTestConfig(servers: ServerConfig[], ports: number[]): any {
  const inbounds: any[] = [];
  const outbounds: any[] = [];
  const routeRules: any[] = [];
  const serverDomains: string[] = [];
  const serverIPs: string[] = [];

  servers.forEach((server, i) => {
    const outboundTag = `proxy-${i}`;
    const inboundTag = `speed-in-${i}`;

    inbounds.push({
      type: 'mixed',
      tag: inboundTag,
      listen: '127.0.0.1',
      listen_port: ports[i],
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
    log: { level: 'warn', timestamp: false },
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

/** 逐个分配本机空闲 loopback 端口（避免与运行中的代理/其他测速实例冲突）。 */
async function allocatePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    const port: number = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const p = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(p));
      });
    });
    ports.push(port);
  }
  return ports;
}

/** 经本地代理建立到目标站点的 CONNECT + TLS 隧道，返回已握手完成的 TLS socket。 */
function createTunnel(
  port: number,
  host: string,
  targetPort: number,
  timeout: number
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const proxyReq = http.request({
      host: '127.0.0.1',
      port,
      method: 'CONNECT',
      path: `${host}:${targetPort}`,
      headers: { Host: host, 'User-Agent': 'FlowZ-SpeedTest/1.0' },
    });
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    proxyReq.setTimeout(timeout, () => proxyReq.destroy(new Error('CONNECT 超时')));
    proxyReq.on('error', fail);
    proxyReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`CONNECT ${res.statusCode}`));
        return;
      }
      socket.setTimeout(timeout, () => socket.destroy());
      const tlsSocket = tls.connect({ socket, servername: host });
      tlsSocket.on('secureConnect', () => {
        if (!settled) {
          settled = true;
          resolve(tlsSocket);
        }
      });
      tlsSocket.on('error', fail);
    });
    proxyReq.end();
  });
}

interface RequestOutcome {
  ok: boolean;
  statusCode?: number;
  latency: number;
  error?: string;
}

/** 通过本地代理完成一次真实 https GET（全新隧道，与移动端同源目标）。 */
function requestOnce(port: number, targetUrl: string, timeout: number): Promise<RequestOutcome> {
  const target = new URL(targetUrl);
  const host = target.hostname;
  const targetPort = Number(target.port) || 443;
  const start = Date.now();

  return createTunnel(port, host, targetPort, timeout)
    .then((tlsSocket) => {
      return new Promise<RequestOutcome>((resolve) => {
        const request = https.request({
          createConnection: () => tlsSocket,
          hostname: host,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: {
            Host: host,
            'User-Agent': 'FlowZ-SpeedTest/1.0',
            Connection: 'close',
          },
        });
        request.setTimeout(timeout, () => request.destroy(new Error('请求超时')));
        request.on('error', (e) => {
          tlsSocket.destroy();
          resolve({ ok: false, latency: Date.now() - start, error: e.message });
        });
        request.on('response', (res) => {
          const statusCode = res.statusCode ?? 0;
          res.resume();
          res.on('end', () => {
            tlsSocket.destroy();
            const ok = statusCode >= 200 && statusCode < 300;
            resolve({
              ok,
              statusCode,
              latency: Date.now() - start,
              error: ok ? undefined : `HTTP ${statusCode}`,
            });
          });
          res.on('error', (e) => {
            tlsSocket.destroy();
            resolve({ ok: false, latency: Date.now() - start, error: e.message });
          });
        });
        request.end();
      });
    })
    .catch((e) => ({ ok: false, latency: Date.now() - start, error: e.message }));
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function runParallel<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index], index);
    }
  };
  const count = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
}

/** 探测单个节点：建连延迟 → 会话延迟，整体受节点超时约束。 */
async function probeNode(
  port: number,
  requestTimeoutMs: number
): Promise<SpeedTestResult> {
  const nodeTask = async (): Promise<SpeedTestResult> => {
    // 建连阶段：首个成功请求 = 拨号（含 QUIC/TCP/TLS 握手耗时），单独记录
    let dialLatency: number | null = null;
    let dialError: string | undefined;
    for (const url of PROBE_URLS) {
      const r = await requestOnce(port, url, requestTimeoutMs);
      if (r.ok) {
        dialLatency = r.latency;
        break;
      }
      dialError = r.error;
    }
    if (dialLatency === null) {
      return {
        latency: null,
        dialLatency: null,
        error: dialError || '无有效响应',
      };
    }

    // 会话阶段：隧道已建立，再测一次得到稳定会话延迟
    let sessionLatency: number | null = null;
    for (const url of PROBE_URLS) {
      const r = await requestOnce(port, url, requestTimeoutMs);
      if (r.ok) {
        sessionLatency = r.latency;
        break;
      }
    }
    const latencyMs = sessionLatency ?? dialLatency;
    return {
      latency: latencyMs,
      dialLatency,
    };
  };

  return withTimeout(nodeTask(), NODE_TIMEOUT_MS, () => new Error(`测速超时（${NODE_TIMEOUT_MS / 1000}s）`));
}

interface RunBatchOptions {
  concurrency: number;
  requestTimeoutMs: number;
}

/** 启动一个临时 sing-box 探针内核，并行对全部节点做真实测速。 */
async function runBatch(
  servers: ServerConfig[],
  opts: RunBatchOptions
): Promise<Map<string, SpeedTestResult>> {
  const results = new Map<string, SpeedTestResult>();
  if (servers.length === 0) {
    return results;
  }

  let testProc: ReturnType<typeof spawn> | null = null;
  let testConfigPath = '';

  try {
    // 构建测试配置（每节点独立 loopback 端口 + 独立出站，按 inbound 路由）
    const ports = await allocatePorts(servers.length);
    const testConfig = buildTestConfig(servers, ports);
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
      for (const server of servers) {
        results.set(server.id, {
          latency: null,
          dialLatency: null,
          error: '配置校验失败',
        });
      }
      return results;
    }

    // 启动临时 sing-box
    testProc = spawn(singboxPath, ['run', '-c', testConfigPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let processExited = false;
    testProc.on('exit', () => {
      processExited = true;
    });

    // 等待 sing-box 就绪
    const startupOk = await new Promise<boolean>((resolve) => {
      const startTime = Date.now();
      const check = () => {
        if (processExited) {
          resolve(false);
          return;
        }
        if (Date.now() - startTime > SINGBOX_STARTUP_TIMEOUT) {
          resolve(false);
          return;
        }
        const sock = new net.Socket();
        sock.setTimeout(500);
        sock.on('connect', () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => {
          sock.destroy();
          setTimeout(check, 500);
        });
        sock.on('timeout', () => {
          sock.destroy();
          setTimeout(check, 500);
        });
        sock.connect(ports[0], '127.0.0.1');
      };
      setTimeout(check, 1000);
    });

    if (!startupOk) {
      for (const server of servers) {
        results.set(server.id, {
          latency: null,
          dialLatency: null,
          error: 'sing-box 启动失败',
        });
      }
      return results;
    }

    // 并行测速（并发限流），每个节点独立端口独立超时，慢节点不拖死整批
    await runParallel(servers, opts.concurrency, async (server, index) => {
      if (processExited) {
        results.set(server.id, {
          latency: null,
          dialLatency: null,
          error: 'sing-box 已退出',
        });
        return;
      }
      const result = await probeNode(ports[index], opts.requestTimeoutMs);
      results.set(server.id, result);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const server of servers) {
      if (!results.has(server.id)) {
        results.set(server.id, {
          latency: null,
          dialLatency: null,
          error: message,
        });
      }
    }
  } finally {
    // 清理 sing-box 进程
    if (testProc && !testProc.killed) {
      testProc.kill();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        testProc!.on('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    // 清理配置文件
    try {
      await fs.unlink(testConfigPath);
    } catch {
      /* ignore */
    }
  }

  return results;
}

export class SpeedTester implements ISpeedTester {
  /**
   * 测试单个服务器延迟（只测建连 + 会话延迟，不下载）
   */
  async testLatency(server: ServerConfig, timeout = 12_000): Promise<number | null> {
    const results = await runBatch([server], {
      concurrency: 1,
      requestTimeoutMs: Math.max(3_000, Math.min(timeout, 30_000)),
    });
    return results.get(server.id)?.latency ?? null;
  }

  /**
   * 综合测试单个服务器（真实测速逻辑）
   */
  async testServer(server: ServerConfig, _proxyPort?: number): Promise<SpeedTestResult> {
    const results = await runBatch([server], {
      concurrency: 1,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    return (
      results.get(server.id) ?? {
        latency: null,
        dialLatency: null,
        error: '测速失败',
      }
    );
  }

  /**
   * 并行真实测速多个服务器（与移动端一致：并发 4，单节点 30s 超时）
   */
  async testMultipleServers(
    servers: ServerConfig[],
    _proxyPort?: number,
    concurrency: number = DEFAULT_CONCURRENCY
  ): Promise<Map<string, SpeedTestResult>> {
    return runBatch(servers, {
      concurrency,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  /**
   * 批量测试服务器延迟（只测延迟，不下载），供托盘测速场景使用
   */
  async testMultipleServersLatency(servers: ServerConfig[]): Promise<Map<string, number | null>> {
    const fullResults = await runBatch(servers, {
      concurrency: DEFAULT_CONCURRENCY,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    const latencyMap = new Map<string, number | null>();
    for (const [serverId, result] of fullResults) {
      latencyMap.set(serverId, result.latency);
    }
    return latencyMap;
  }
}