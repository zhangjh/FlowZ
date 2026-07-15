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

/**
 * 获取系统上游 DNS 服务器地址
 * 用于 TUN 模式下避免 DNS 查询因路由拦截而产生死循环
 *
 * - Linux: 解析 /etc/resolv.conf 或 systemd-resolved
 * - Windows: 通过 PowerShell / ipconfig 获取网卡 DNS 配置
 * - macOS: 返回空数组（macOS TUN 使用 gvisor stack + sniff_override_destination）
 */
export function getSystemDnsServers(): string[] {
  switch (process.platform) {
    case 'linux':
      return getLinuxDnsServers();
    case 'win32':
      return getWindowsDnsServers();
    default:
      return [];
  }
}
