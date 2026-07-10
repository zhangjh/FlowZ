import * as fs from 'fs';

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
  return ip.startsWith('127.');
}

function isDockerBridge(ip: string): boolean {
  if (!ip.includes('.')) return false;
  const parts = ip.split('.').map(Number);
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

export function getSystemDnsServers(): string[] {
  if (process.platform !== 'linux') return [];

  const isUsable = (ip: string) => !isLoopback(ip) && !isDockerBridge(ip);

  let servers = parseResolvConf('/etc/resolv.conf');
  let filtered = servers.filter(isUsable);

  if (filtered.length > 0) return filtered;

  servers = parseResolvConf('/run/systemd/resolve/resolv.conf');
  filtered = servers.filter(isUsable);

  if (filtered.length > 0) return filtered;

  return [];
}
