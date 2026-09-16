import * as fs from 'fs';
import { execSync } from 'child_process';

function parseResolvConf(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const servers: string[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('nameserver ')) {
        const ip = trimmed.slice(11).trim();
        if (ip) servers.push(ip);
      }
    }
    return servers;
  } catch {
    return [];
  }
}

function isLoopback(ip: string): boolean {
  if (ip.startsWith('127.')) return true;
  if (ip === '::1') return true;
  return false;
}

function isDockerBridge(ip: string): boolean {
  if (!ip.includes('.')) return false;
  const parts = ip.split('.').map(Number);
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function isUnusableIPv6(ip: string): boolean {
  if (!ip.includes(':')) return false;
  // fec0::/10 - site-local (deprecated, not routable)
  if (/^fec[0-9a-f]{1}:/i.test(ip)) return true;
  // fe80::/10 - link-local (not routable across networks)
  if (/^fe[89ab][0-9a-f]{1}:/i.test(ip)) return true;
  // ff00::/8 - multicast
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return true;
  // :: (unspecified)
  if (ip === '::') return true;
  return false;
}

function isValidIp(ip: string): boolean {
  // IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return ip.split('.').every(octet => {
      const n = parseInt(octet, 10);
      return n >= 0 && n <= 255;
    });
  }
  // IPv6
  if (ip.includes(':') && !ip.includes('.')) {
    return !isUnusableIPv6(ip);
  }
  return false;
}

function getWindowsDnsServers(): string[] {
  try {
    // 方法 1: PowerShell Get-DnsClientServerAddress (最可靠)
    const output = execSync(
      'powershell -NoProfile -Command "Get-DnsClientServerAddress -AddressFamily IPv4,IPv6 | Select-Object -ExpandProperty ServerAddresses"',
      { encoding: 'utf-8', timeout: 5000, windowsHide: true }
    );
    const servers = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .map(ip => ip.replace(/^\[|\]$/g, '')) // 移除 IPv6 方括号 [fec0::1] → fec0::1
      .filter(ip => ip.length > 0 && isValidIp(ip) && !isLoopback(ip));

    if (servers.length > 0) {
      // IPv4 优先（避免 IPv6 site-local 等不可用地址被优先使用）
      const unique = [...new Set(servers)];
      const ipv4 = unique.filter(ip => !ip.includes(':'));
      const ipv6 = unique.filter(ip => ip.includes(':'));
      return [...ipv4, ...ipv6];
    }
  } catch {
    // PowerShell 不可用或执行失败，回退到方法 2
  }

  try {
    // 方法 2: ipconfig /all 解析 DNS Servers 行
    const output = execSync('ipconfig /all', { encoding: 'utf-8', timeout: 5000, windowsHide: true });
    const servers: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      // Windows 英文: "DNS Servers . . . . . . . . . . . : 10.126.142.187"
      // Windows 中文: "DNS 服务器 . . . . . . . . . . . . : 10.126.142.187"
      const match = line.match(/DNS\s+(?:Servers?\s+)?[:：]\s*(.+)/i);
      if (match) {
        const parts = match[1].trim().split(/\s+/);
        for (const part of parts) {
          const cleaned = part.replace(/^\[|\]$/g, ''); // 移除 IPv6 方括号
          if (isValidIp(cleaned) && !isLoopback(cleaned)) {
            servers.push(cleaned);
          }
        }
      }
    }
    if (servers.length > 0) {
      const unique = [...new Set(servers)];
      const ipv4 = unique.filter(ip => !ip.includes(':'));
      const ipv6 = unique.filter(ip => ip.includes(':'));
      return [...ipv4, ...ipv6];
    }
  } catch {
    // ipconfig 不可用
  }

  return [];
}

function getLinuxDnsServers(): string[] {
  const isUsable = (ip: string) => !isLoopback(ip) && !isDockerBridge(ip);

  let servers = parseResolvConf('/etc/resolv.conf');
  let filtered = servers.filter(isUsable);

  if (filtered.length > 0) return filtered;

  servers = parseResolvConf('/run/systemd/resolve/resolv.conf');
  filtered = servers.filter(isUsable);

  if (filtered.length > 0) return filtered;

  return [];
}

/* ------------------------------------------------------------------ */
/* macOS DNS 支持                                                       */
/* ------------------------------------------------------------------ */

/**
 * TUN 内部地址判断：macOS 上 FlowZ 会把系统 DNS 指向 TUN 劫持地址，
 * 读取系统 DNS 时必须过滤这些内部地址，避免配置生成时拿到 TUN 自身地址。
 */
export function isTunInternalAddress(ip: string): boolean {
  if (ip.includes(':')) {
    return ip.startsWith('fdfe:dcba:9876:') || ip.startsWith('fdfe:dcba:9876::');
  }
  return ip.startsWith('172.19.');
}

function getMacNetworkServices(): string[] {
  try {
    const output = execSync('networksetup -listallnetworkservices', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('*'));
  } catch {
    return [];
  }
}

/**
 * 通过 scutil --dns 读取 macOS 实际生效的 DNS。
 * DHCP 网络下 networksetup -getdnsservers 返回 "There aren't any DNS Servers set"，
 * 但 scutil 能读到 mDNSResponder 实际使用的服务器（路由器下发的 DNS）。
 */
function readMacDnsServersFromScutil(): string[] {
  try {
    const output = execSync('scutil --dns', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const servers: string[] = [];
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^nameserver\[\d+\]\s*:\s*(.+)$/);
      if (match) {
        let ip = match[1].trim();
        // 去掉接口作用域后缀，如 fe80::2:1%en0
        if (ip.includes('%')) ip = ip.slice(0, ip.indexOf('%'));
        servers.push(ip);
      }
    }
    const valid = [...new Set(servers)].filter(
      (ip) => isValidIp(ip) && !isLoopback(ip) && !isTunInternalAddress(ip)
    );
    // IPv4 优先（IPv6 可能不可达）
    valid.sort((a, b) => (a.includes(':') ? 1 : 0) - (b.includes(':') ? 1 : 0));
    return valid;
  } catch {
    return [];
  }
}

/**
 * 通过 networksetup 读取 macOS 各网络服务显式配置的 DNS。
 */
function readMacDnsServersFromNetworksetup(): string[] {
  const servers: string[] = [];
  for (const service of getMacNetworkServices()) {
    try {
      const output = execSync(`networksetup -getdnsservers "${service}"`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      for (const line of output.split('\n')) {
        const match = line.trim().match(/^DNS\s+Servers?:\s+(.+)$/i);
        if (match) {
          for (const part of match[1].trim().split(/\s+/)) {
            if (isValidIp(part) && !isLoopback(part) && !isTunInternalAddress(part)) {
              servers.push(part);
            }
          }
        }
      }
    } catch {
      // 单个网络服务读取失败跳过
    }
  }
  return [...new Set(servers)];
}

/**
 * 读取 macOS 当前实际生效的系统 DNS 服务器地址。
 * 优先 scutil --dns（能读到 DHCP 下发的 DNS），fallback networksetup。
 * 返回去重后的 IPv4/IPv6 列表，过滤回环、链路本地与 TUN 内部地址。
 */
export function readMacDnsServers(): string[] {
  const fromScutil = readMacDnsServersFromScutil();
  if (fromScutil.length > 0) return fromScutil;
  return readMacDnsServersFromNetworksetup();
}

/**
 * macOS 原始 DNS 缓存。
 * FlowZ 会把系统 DNS 指向 TUN 劫持地址，之后 networksetup 读到的都是内部地址，
 * 因此首次读取（设置 TUN DNS 之前）的原始值需要缓存，供配置生成持续使用。
 */
let macDnsCache: string[] | null = null;

export function resetMacDnsCache(): void {
  macDnsCache = null;
}

/**
 * 设置/恢复 macOS 系统 DNS。
 * servers 为空时恢复 DHCP 自动获取（networksetup empty）。
 */
export function setSystemDnsServers(servers: string[]): void {
  if (process.platform !== 'darwin') return;
  const args = servers.length > 0 ? servers.join(' ') : 'empty';
  for (const service of getMacNetworkServices()) {
    execSync(`networksetup -setdnsservers "${service}" ${args}`, {
      timeout: 5000,
    });
  }
}

function incrementIpv4(ip: string): string | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  parts[3] += 1;
  for (let i = 3; i > 0 && parts[i] > 255; i--) {
    parts[i] = 0;
    parts[i - 1] += 1;
  }
  if (parts[0] > 255) return null;
  return parts.join('.');
}

function expandIpv6(ip: string): string[] | null {
  const doubleColon = ip.split('::');
  if (doubleColon.length > 2) return null;
  let groups: string[];
  if (doubleColon.length === 2) {
    const head = doubleColon[0] ? doubleColon[0].split(':') : [];
    const tail = doubleColon[1] ? doubleColon[1].split(':') : [];
    if (head.length + tail.length >= 8) return null;
    groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  } else {
    groups = ip.split(':');
  }
  if (groups.length !== 8) return null;
  const numbers = groups.map((g) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return NaN;
    return parseInt(g, 16);
  });
  if (numbers.some((n) => Number.isNaN(n))) return null;
  return numbers.map((n) => n.toString(16));
}

function incrementIpv6(ip: string): string | null {
  const groups = expandIpv6(ip);
  if (!groups) return null;
  const numbers = groups.map((g) => parseInt(g, 16));
  numbers[7] += 1;
  for (let i = 7; i > 0 && numbers[i] > 0xffff; i--) {
    numbers[i] = 0;
    numbers[i - 1] += 1;
  }
  if (numbers[0] > 0xffff) return null;
  return numbers.map((n) => n.toString(16)).join(':');
}

function incrementIp(ip: string): string | null {
  if (ip.includes(':')) return incrementIpv6(ip);
  return incrementIpv4(ip);
}

/**
 * 计算 TUN DNS 劫持地址列表。
 * sing-box 1.14 中 dns_mode=hijack 时，系统 DNS 应指向 TUN 地址的下一个 IP
 * （例如 172.19.0.1/30 → 172.19.0.2），发往该地址的 DNS 查询会被劫持进 sing-box DNS 模块。
 */
export function getTunDnsAddresses(addresses: string[]): string[] {
  const result: string[] = [];
  for (const entry of addresses) {
    const [ip] = entry.split('/');
    const next = incrementIp(ip);
    if (next) result.push(next);
  }
  return result;
}

/**
 * 获取系统上游 DNS 服务器地址
 * 用于 TUN 模式下避免 DNS 查询因路由拦截而产生死循环
 *
 * - Linux: 解析 /etc/resolv.conf 或 systemd-resolved
 * - Windows: 通过 PowerShell / ipconfig 获取网卡 DNS 配置
 * - macOS: 通过 networksetup 获取系统 DNS（首次读取后缓存原始值，
 *   过滤 TUN 内部地址，供 dns-local 显式上游与路由排除规则使用）
 */
export function getSystemDnsServers(): string[] {
  switch (process.platform) {
    case 'linux':
      return getLinuxDnsServers();
    case 'win32':
      return getWindowsDnsServers();
    case 'darwin':
      if (macDnsCache === null) {
        macDnsCache = readMacDnsServers().filter((ip) => !isTunInternalAddress(ip));
      }
      if (macDnsCache.length === 0) {
        // 兜底：极少数情况下 scutil/networksetup 都读不到 DNS 时，
        // 使用国内公共 DNS 作为显式上游，避免 dns-local 回退 type:'local'
        // 导致查询进 TUN 被劫持回 DNS 模块形成死循环
        return ['223.5.5.5', '119.29.29.29'];
      }
      return [...macDnsCache];
    default:
      return [];
  }
}
