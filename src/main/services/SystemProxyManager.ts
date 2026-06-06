/**
 * 系统代理管理服务
 * 负责跨平台的系统代理设置和管理
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { retry } from '../utils/retry';

const execAsync = promisify(exec);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 系统代理状态
 */
export interface SystemProxyStatus {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
}

/**
 * 系统代理管理器接口
 */
export interface ISystemProxyManager {
  /**
   * 启用系统代理
   */
  enableProxy(address: string, httpPort: number, socksPort: number): Promise<void>;

  /**
   * 禁用系统代理
   */
  disableProxy(): Promise<void>;

  /**
   * 获取代理状态
   */
  getProxyStatus(): Promise<SystemProxyStatus>;
}

/**
 * 系统代理管理器基类
 */
export abstract class SystemProxyBase implements ISystemProxyManager {
  protected originalSettings: SystemProxyStatus | null = null;

  abstract enableProxy(address: string, httpPort: number, socksPort: number): Promise<void>;
  abstract disableProxy(): Promise<void>;
  abstract getProxyStatus(): Promise<SystemProxyStatus>;
}

/**
 * Windows 系统代理管理器
 * 使用注册表修改 Internet Settings
 */
export class WindowsSystemProxy extends SystemProxyBase {
  private readonly regPath =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

  /**
   * 启用系统代理
   */
  async enableProxy(address: string, httpPort: number, socksPort: number): Promise<void> {
    console.log(`正在设置 Windows 系统代理: ${address}:${httpPort}`);

    // 保存原始设置
    try {
      this.originalSettings = await this.getProxyStatus();
      console.log('已保存原始代理设置:', this.originalSettings);
    } catch (error) {
      console.warn('无法获取原始代理设置:', error);
      // 继续执行，即使无法获取原始设置
    }

    try {
      // 使用重试机制设置代理
      await retry(
        async () => {
          // 设置代理服务器地址
          const proxyServer = `http=${address}:${httpPort};https=${address}:${httpPort};socks=${address}:${socksPort}`;
          await execAsync(
            `reg add "${this.regPath}" /v ProxyServer /t REG_SZ /d "${proxyServer}" /f`
          );

          // 启用代理
          await execAsync(`reg add "${this.regPath}" /v ProxyEnable /t REG_DWORD /d 1 /f`);

          // 设置代理覆盖（本地地址不走代理）
          const proxyOverride =
            'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>';
          await execAsync(
            `reg add "${this.regPath}" /v ProxyOverride /t REG_SZ /d "${proxyOverride}" /f`
          );

          // 通知系统代理设置已更改
          await this.notifyProxyChange();
        },
        {
          maxRetries: 2,
          delay: 500,
          shouldRetry: (error) => {
            // 权限错误不重试
            const message = error.message.toLowerCase();
            if (message.includes('access denied') || message.includes('permission')) {
              return false;
            }
            return true;
          },
          onRetry: (error, attempt) => {
            console.log(`设置系统代理失败，正在进行第 ${attempt} 次重试:`, error.message);
          },
        }
      );

      console.log('Windows 系统代理设置成功');
    } catch (error) {
      console.error('设置 Windows 系统代理失败:', error);

      // 如果设置失败，尝试恢复原始设置
      if (this.originalSettings) {
        console.log('正在回滚到原始代理设置...');
        try {
          await this.restoreProxySettings(this.originalSettings);
          console.log('已成功回滚到原始代理设置');
        } catch (rollbackError) {
          console.error('回滚代理设置失败:', rollbackError);
          // 即使回滚失败，也要抛出原始错误
        }
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `设置 Windows 系统代理失败: ${errorMessage}\n\n可能的原因:\n1. 权限不足，请以管理员身份运行\n2. 注册表访问被阻止\n3. 系统策略限制`
      );
    }
  }

  /**
   * 禁用系统代理
   */
  async disableProxy(): Promise<void> {
    console.log('正在禁用 Windows 系统代理...');

    try {
      if (this.originalSettings) {
        // 恢复原始设置
        console.log('正在恢复原始代理设置:', this.originalSettings);
        await this.restoreProxySettings(this.originalSettings);
        this.originalSettings = null;
        console.log('已恢复原始代理设置');
      } else {
        // 简单禁用代理
        await execAsync(`reg add "${this.regPath}" /v ProxyEnable /t REG_DWORD /d 0 /f`);
        await this.notifyProxyChange();
        console.log('已禁用系统代理');
      }
    } catch (error) {
      console.error('禁用 Windows 系统代理失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`禁用 Windows 系统代理失败: ${errorMessage}\n\n建议手动检查系统代理设置`);
    }
  }

  /**
   * 获取代理状态
   */
  async getProxyStatus(): Promise<SystemProxyStatus> {
    try {
      // 查询 ProxyEnable
      const enableResult = await execAsync(`reg query "${this.regPath}" /v ProxyEnable`);
      const enabled = enableResult.stdout.includes('0x1');

      if (!enabled) {
        return { enabled: false };
      }

      // 查询 ProxyServer
      const serverResult = await execAsync(`reg query "${this.regPath}" /v ProxyServer`);
      const proxyServerMatch = serverResult.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/);

      if (!proxyServerMatch) {
        return { enabled: true };
      }

      const proxyServer = proxyServerMatch[1].trim();
      const status: SystemProxyStatus = { enabled: true };

      // 解析代理服务器字符串
      // 格式: http=127.0.0.1:8080;https=127.0.0.1:8080;socks=127.0.0.1:1080
      const parts = proxyServer.split(';');
      for (const part of parts) {
        const [protocol, address] = part.split('=');
        if (protocol && address) {
          const key = `${protocol.toLowerCase()}Proxy` as keyof SystemProxyStatus;
          if (key === 'httpProxy' || key === 'httpsProxy' || key === 'socksProxy') {
            status[key] = address;
          }
        }
      }

      return status;
    } catch {
      // 查询失败，返回禁用状态
      return { enabled: false };
    }
  }

  /**
   * 恢复代理设置
   */
  private async restoreProxySettings(settings: SystemProxyStatus): Promise<void> {
    if (settings.enabled && (settings.httpProxy || settings.httpsProxy || settings.socksProxy)) {
      // 恢复代理服务器设置
      const parts: string[] = [];
      if (settings.httpProxy) parts.push(`http=${settings.httpProxy}`);
      if (settings.httpsProxy) parts.push(`https=${settings.httpsProxy}`);
      if (settings.socksProxy) parts.push(`socks=${settings.socksProxy}`);

      if (parts.length > 0) {
        const proxyServer = parts.join(';');
        await execAsync(
          `reg add "${this.regPath}" /v ProxyServer /t REG_SZ /d "${proxyServer}" /f`
        );
      }

      // 启用代理
      await execAsync(`reg add "${this.regPath}" /v ProxyEnable /t REG_DWORD /d 1 /f`);
    } else {
      // 禁用代理
      await execAsync(`reg add "${this.regPath}" /v ProxyEnable /t REG_DWORD /d 0 /f`);
    }

    await this.notifyProxyChange();
  }

  /**
   * 通知系统代理设置已更改
   * 使用 Windows API 通知系统刷新代理设置
   */
  private async notifyProxyChange(): Promise<void> {
    // 在 Windows 上，修改注册表后需要通知系统刷新设置
    // 这里使用 PowerShell 调用 WinAPI
    const script = `
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class WinInet {
        [DllImport("wininet.dll")]
        public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
        public const int INTERNET_OPTION_SETTINGS_CHANGED = 39;
        public const int INTERNET_OPTION_REFRESH = 37;
      }
"@
      [WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
      [WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
    `;

    try {
      await execAsync(`powershell -Command "${script.replace(/\n/g, ' ')}"`);
    } catch (error) {
      // 通知失败不影响代理设置，只记录警告
      console.warn('Failed to notify proxy change:', error);
    }
  }
}

/**
 * macOS 系统代理管理器
 * 使用 networksetup 命令配置网络服务代理
 */
export class MacOSSystemProxy extends SystemProxyBase {
  /**
   * 启用系统代理
   */
  async enableProxy(address: string, httpPort: number, socksPort: number): Promise<void> {
    console.log(`正在设置 macOS 系统代理: ${address}:${httpPort}`);

    // 保存原始设置
    try {
      this.originalSettings = await this.getProxyStatus();
      console.log('已保存原始代理设置:', this.originalSettings);
    } catch (error) {
      console.warn('无法获取原始代理设置:', error);
      // 继续执行，即使无法获取原始设置
    }

    try {
      // 使用重试机制设置代理
      await retry(
        async () => {
          // 获取所有网络服务
          const services = await this.getNetworkServices();
          console.log(`找到 ${services.length} 个网络服务:`, services);

          // 为每个网络服务设置代理
          for (const service of services) {
            console.log(`正在为网络服务 "${service}" 设置代理...`);

            // 设置 HTTP 代理
            await execAsync(`networksetup -setwebproxy "${service}" ${address} ${httpPort}`);
            await execAsync(`networksetup -setwebproxystate "${service}" on`);

            // 设置 HTTPS 代理
            await execAsync(`networksetup -setsecurewebproxy "${service}" ${address} ${httpPort}`);
            await execAsync(`networksetup -setsecurewebproxystate "${service}" on`);

            // 设置 SOCKS 代理
            await execAsync(
              `networksetup -setsocksfirewallproxy "${service}" ${address} ${socksPort}`
            );
            await execAsync(`networksetup -setsocksfirewallproxystate "${service}" on`);

            // 设置代理绕过列表（本地地址不走代理）
            const bypassDomains = [
              'localhost',
              '127.0.0.1',
              '*.local',
              '169.254.0.0/16',
              '10.0.0.0/8',
              '172.16.0.0/12',
              '192.168.0.0/16',
            ];
            await execAsync(
              `networksetup -setproxybypassdomains "${service}" ${bypassDomains.join(' ')}`
            );

            console.log(`网络服务 "${service}" 代理设置完成`);
          }
        },
        {
          maxRetries: 2,
          delay: 500,
          shouldRetry: (error) => {
            // 权限错误不重试
            const message = error.message.toLowerCase();
            if (message.includes('permission') || message.includes('not authorized')) {
              return false;
            }
            return true;
          },
          onRetry: (error, attempt) => {
            console.log(`设置系统代理失败，正在进行第 ${attempt} 次重试:`, error.message);
          },
        }
      );

      console.log('macOS 系统代理设置成功');
    } catch (error) {
      console.error('设置 macOS 系统代理失败:', error);

      // 如果设置失败，尝试恢复原始设置
      if (this.originalSettings) {
        console.log('正在回滚到原始代理设置...');
        try {
          await this.restoreProxySettings(this.originalSettings);
          console.log('已成功回滚到原始代理设置');
        } catch (rollbackError) {
          console.error('回滚代理设置失败:', rollbackError);
          // 即使回滚失败，也要抛出原始错误
        }
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `设置 macOS 系统代理失败: ${errorMessage}\n\n可能的原因:\n1. 权限不足，请授予应用网络设置权限\n2. networksetup 命令不可用\n3. 网络服务配置异常`
      );
    }
  }

  /**
   * 禁用系统代理
   */
  async disableProxy(): Promise<void> {
    console.log('正在禁用 macOS 系统代理...');

    try {
      if (this.originalSettings) {
        // 恢复原始设置
        console.log('正在恢复原始代理设置:', this.originalSettings);
        await this.restoreProxySettings(this.originalSettings);
        this.originalSettings = null;
        console.log('已恢复原始代理设置');
      } else {
        // 简单禁用代理
        const services = await this.getNetworkServices();
        for (const service of services) {
          console.log(`正在禁用网络服务 "${service}" 的代理...`);
          await execAsync(`networksetup -setwebproxystate "${service}" off`);
          await execAsync(`networksetup -setsecurewebproxystate "${service}" off`);
          await execAsync(`networksetup -setsocksfirewallproxystate "${service}" off`);
        }
        console.log('已禁用系统代理');
      }
    } catch (error) {
      console.error('禁用 macOS 系统代理失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`禁用 macOS 系统代理失败: ${errorMessage}\n\n建议手动检查系统代理设置`);
    }
  }

  /**
   * 获取代理状态
   */
  async getProxyStatus(): Promise<SystemProxyStatus> {
    try {
      // 获取第一个网络服务的代理状态
      const services = await this.getNetworkServices();
      if (services.length === 0) {
        return { enabled: false };
      }

      const service = services[0];
      const status: SystemProxyStatus = { enabled: false };

      // 检查 HTTP 代理
      const httpResult = await execAsync(`networksetup -getwebproxy "${service}"`);
      const httpEnabled = httpResult.stdout.includes('Enabled: Yes');
      if (httpEnabled) {
        const serverMatch = httpResult.stdout.match(/Server: (.+)/);
        const portMatch = httpResult.stdout.match(/Port: (\d+)/);
        if (serverMatch && portMatch) {
          status.httpProxy = `${serverMatch[1].trim()}:${portMatch[1].trim()}`;
          status.enabled = true;
        }
      }

      // 检查 HTTPS 代理
      const httpsResult = await execAsync(`networksetup -getsecurewebproxy "${service}"`);
      const httpsEnabled = httpsResult.stdout.includes('Enabled: Yes');
      if (httpsEnabled) {
        const serverMatch = httpsResult.stdout.match(/Server: (.+)/);
        const portMatch = httpsResult.stdout.match(/Port: (\d+)/);
        if (serverMatch && portMatch) {
          status.httpsProxy = `${serverMatch[1].trim()}:${portMatch[1].trim()}`;
          status.enabled = true;
        }
      }

      // 检查 SOCKS 代理
      const socksResult = await execAsync(`networksetup -getsocksfirewallproxy "${service}"`);
      const socksEnabled = socksResult.stdout.includes('Enabled: Yes');
      if (socksEnabled) {
        const serverMatch = socksResult.stdout.match(/Server: (.+)/);
        const portMatch = socksResult.stdout.match(/Port: (\d+)/);
        if (serverMatch && portMatch) {
          status.socksProxy = `${serverMatch[1].trim()}:${portMatch[1].trim()}`;
          status.enabled = true;
        }
      }

      return status;
    } catch {
      // 查询失败，返回禁用状态
      return { enabled: false };
    }
  }

  /**
   * 获取所有网络服务
   */
  private async getNetworkServices(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('networksetup -listallnetworkservices');
      const lines = stdout.split('\n');

      // 第一行是提示信息，跳过
      // 过滤掉空行和以 * 开头的禁用服务
      return lines
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('*'));
    } catch (error) {
      throw new Error(
        `获取网络服务列表失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 恢复代理设置
   */
  private async restoreProxySettings(settings: SystemProxyStatus): Promise<void> {
    const services = await this.getNetworkServices();

    for (const service of services) {
      if (settings.enabled) {
        // 恢复 HTTP 代理
        if (settings.httpProxy) {
          const [server, port] = settings.httpProxy.split(':');
          await execAsync(`networksetup -setwebproxy "${service}" ${server} ${port}`);
          await execAsync(`networksetup -setwebproxystate "${service}" on`);
        } else {
          await execAsync(`networksetup -setwebproxystate "${service}" off`);
        }

        // 恢复 HTTPS 代理
        if (settings.httpsProxy) {
          const [server, port] = settings.httpsProxy.split(':');
          await execAsync(`networksetup -setsecurewebproxy "${service}" ${server} ${port}`);
          await execAsync(`networksetup -setsecurewebproxystate "${service}" on`);
        } else {
          await execAsync(`networksetup -setsecurewebproxystate "${service}" off`);
        }

        // 恢复 SOCKS 代理
        if (settings.socksProxy) {
          const [server, port] = settings.socksProxy.split(':');
          await execAsync(`networksetup -setsocksfirewallproxy "${service}" ${server} ${port}`);
          await execAsync(`networksetup -setsocksfirewallproxystate "${service}" on`);
        } else {
          await execAsync(`networksetup -setsocksfirewallproxystate "${service}" off`);
        }
      } else {
        // 禁用所有代理
        await execAsync(`networksetup -setwebproxystate "${service}" off`);
        await execAsync(`networksetup -setsecurewebproxystate "${service}" off`);
        await execAsync(`networksetup -setsocksfirewallproxystate "${service}" off`);
      }
    }
  }
}

interface LinuxProxySettings {
  mode: string;
  httpHost: string;
  httpPort: number;
  httpsHost: string;
  httpsPort: number;
  socksHost: string;
  socksPort: number;
  ignoreHosts: string;
}

/**
 * Linux 系统代理管理器
 * 使用 GNOME gsettings 配置桌面环境代理（Ubuntu 默认支持）
 */
export class LinuxSystemProxy extends SystemProxyBase {
  private originalLinuxSettings: LinuxProxySettings | null = null;

  /**
   * 启用系统代理
   */
  async enableProxy(address: string, httpPort: number, socksPort: number): Promise<void> {
    console.log(`正在设置 Linux 系统代理: ${address}:${httpPort}`);

    await this.ensureGsettingsAvailable();

    try {
      this.originalSettings = await this.getProxyStatus();
      this.originalLinuxSettings = await this.getCurrentSettings();
      console.log('已保存原始 Linux 代理设置:', this.originalLinuxSettings);
    } catch (error) {
      console.warn('无法获取原始 Linux 代理设置:', error);
    }

    try {
      await retry(
        async () => {
          await this.setString('org.gnome.system.proxy.http', 'host', address);
          await this.setInt('org.gnome.system.proxy.http', 'port', httpPort);
          await this.setString('org.gnome.system.proxy.https', 'host', address);
          await this.setInt('org.gnome.system.proxy.https', 'port', httpPort);
          await this.setString('org.gnome.system.proxy.socks', 'host', address);
          await this.setInt('org.gnome.system.proxy.socks', 'port', socksPort);
          await this.setRaw(
            'org.gnome.system.proxy',
            'ignore-hosts',
            shellQuote(
              "['localhost', '127.0.0.0/8', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']"
            )
          );
          await this.setString('org.gnome.system.proxy', 'mode', 'manual');
        },
        {
          maxRetries: 2,
          delay: 500,
          shouldRetry: (error) => {
            const message = error.message.toLowerCase();
            return !message.includes('no such schema') && !message.includes('permission');
          },
          onRetry: (error, attempt) => {
            console.log(`设置 Linux 系统代理失败，正在进行第 ${attempt} 次重试:`, error.message);
          },
        }
      );

      console.log('Linux 系统代理设置成功');
    } catch (error) {
      console.error('设置 Linux 系统代理失败:', error);

      if (this.originalLinuxSettings) {
        try {
          await this.restoreLinuxSettings(this.originalLinuxSettings);
        } catch (rollbackError) {
          console.error('回滚 Linux 代理设置失败:', rollbackError);
        }
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `设置 Linux 系统代理失败: ${errorMessage}\n\n可能的原因:\n1. 当前桌面环境不支持 GNOME gsettings 代理配置\n2. gsettings 命令不可用\n3. 系统策略限制修改代理设置`
      );
    }
  }

  /**
   * 禁用系统代理
   */
  async disableProxy(): Promise<void> {
    console.log('正在禁用 Linux 系统代理...');

    await this.ensureGsettingsAvailable();

    try {
      if (this.originalLinuxSettings) {
        await this.restoreLinuxSettings(this.originalLinuxSettings);
        this.originalLinuxSettings = null;
        this.originalSettings = null;
        console.log('已恢复原始 Linux 代理设置');
      } else {
        await this.setString('org.gnome.system.proxy', 'mode', 'none');
        console.log('已禁用 Linux 系统代理');
      }
    } catch (error) {
      console.error('禁用 Linux 系统代理失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`禁用 Linux 系统代理失败: ${errorMessage}\n\n建议手动检查系统代理设置`);
    }
  }

  /**
   * 获取代理状态
   */
  async getProxyStatus(): Promise<SystemProxyStatus> {
    try {
      await this.ensureGsettingsAvailable();

      const mode = await this.getString('org.gnome.system.proxy', 'mode');
      if (mode !== 'manual') {
        return { enabled: false };
      }

      const httpHost = await this.getString('org.gnome.system.proxy.http', 'host');
      const httpPort = await this.getInt('org.gnome.system.proxy.http', 'port');
      const httpsHost = await this.getString('org.gnome.system.proxy.https', 'host');
      const httpsPort = await this.getInt('org.gnome.system.proxy.https', 'port');
      const socksHost = await this.getString('org.gnome.system.proxy.socks', 'host');
      const socksPort = await this.getInt('org.gnome.system.proxy.socks', 'port');

      const status: SystemProxyStatus = { enabled: true };
      if (httpHost && httpPort > 0) status.httpProxy = `${httpHost}:${httpPort}`;
      if (httpsHost && httpsPort > 0) status.httpsProxy = `${httpsHost}:${httpsPort}`;
      if (socksHost && socksPort > 0) status.socksProxy = `${socksHost}:${socksPort}`;

      return status;
    } catch {
      return { enabled: false };
    }
  }

  private async ensureGsettingsAvailable(): Promise<void> {
    try {
      await execAsync('command -v gsettings');
    } catch {
      throw new Error('未找到 gsettings，当前 Linux 桌面环境暂不支持自动设置系统代理');
    }
  }

  private async getCurrentSettings(): Promise<LinuxProxySettings> {
    return {
      mode: await this.getString('org.gnome.system.proxy', 'mode'),
      httpHost: await this.getString('org.gnome.system.proxy.http', 'host'),
      httpPort: await this.getInt('org.gnome.system.proxy.http', 'port'),
      httpsHost: await this.getString('org.gnome.system.proxy.https', 'host'),
      httpsPort: await this.getInt('org.gnome.system.proxy.https', 'port'),
      socksHost: await this.getString('org.gnome.system.proxy.socks', 'host'),
      socksPort: await this.getInt('org.gnome.system.proxy.socks', 'port'),
      ignoreHosts: await this.getRaw('org.gnome.system.proxy', 'ignore-hosts'),
    };
  }

  private async restoreLinuxSettings(settings: LinuxProxySettings): Promise<void> {
    await this.setString('org.gnome.system.proxy.http', 'host', settings.httpHost);
    await this.setInt('org.gnome.system.proxy.http', 'port', settings.httpPort);
    await this.setString('org.gnome.system.proxy.https', 'host', settings.httpsHost);
    await this.setInt('org.gnome.system.proxy.https', 'port', settings.httpsPort);
    await this.setString('org.gnome.system.proxy.socks', 'host', settings.socksHost);
    await this.setInt('org.gnome.system.proxy.socks', 'port', settings.socksPort);
    await this.setRaw('org.gnome.system.proxy', 'ignore-hosts', shellQuote(settings.ignoreHosts));
    await this.setString('org.gnome.system.proxy', 'mode', settings.mode);
  }

  private async getString(schema: string, key: string): Promise<string> {
    const rawValue = await this.getRaw(schema, key);
    return rawValue.replace(/^'/, '').replace(/'$/, '').replace(/\\'/g, "'");
  }

  private async getInt(schema: string, key: string): Promise<number> {
    const rawValue = await this.getRaw(schema, key);
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private async getRaw(schema: string, key: string): Promise<string> {
    const { stdout } = await execAsync(`gsettings get ${schema} ${key}`);
    return stdout.trim();
  }

  private async setString(schema: string, key: string, value: string): Promise<void> {
    await this.setRaw(schema, key, shellQuote(value));
  }

  private async setInt(schema: string, key: string, value: number): Promise<void> {
    await this.setRaw(schema, key, String(value));
  }

  private async setRaw(schema: string, key: string, value: string): Promise<void> {
    await execAsync(`gsettings set ${schema} ${key} ${value}`);
  }
}

/**
 * 创建系统代理管理器
 * 根据当前平台返回对应的实现
 */
export function createSystemProxyManager(): ISystemProxyManager {
  const platform = process.platform;

  if (platform === 'win32') {
    return new WindowsSystemProxy();
  } else if (platform === 'darwin') {
    return new MacOSSystemProxy();
  } else if (platform === 'linux') {
    return new LinuxSystemProxy();
  }

  throw new Error(`不支持的平台: ${platform}`);
}
