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

export function getSystemDnsServers(): string[] {
  if (process.platform !== 'linux') return [];

  let servers = parseResolvConf('/etc/resolv.conf');
  let filtered = servers.filter(ip => !isLoopback(ip));

  if (filtered.length > 0) return filtered;

  servers = parseResolvConf('/run/systemd/resolve/resolv.conf');
  filtered = servers.filter(ip => !isLoopback(ip));

  if (filtered.length > 0) return filtered;

  return [];
}
