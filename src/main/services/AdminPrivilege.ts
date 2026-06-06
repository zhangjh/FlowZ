/**
 * 管理员权限管理服务
 * 用于检测权限状态
 * 
 * 重要说明：
 * 在 macOS 上，整个 Electron 应用不应以 root 权限运行，否则会导致：
 * - 托盘图标不显示
 * - Dock 栏显示"应用程序没有响应"  
 * - 配置文件路径变为 /var/root/...，导致配置隔离
 * 
 * 正确的做法是：Electron 应用以普通用户身份运行，只有需要特权的
 * 子进程（如 TUN 模式的 sing-box）通过平台权限工具请求管理员权限运行。
 * 这部分逻辑已在 ProxyManager.ts 中实现。
 */

export interface IAdminPrivilege {
  isAdmin(): boolean;
  needsElevationForTun(): boolean;
}

/**
 * 检测当前进程是否以管理员权限运行
 */
export function isRunningAsAdmin(): boolean {
  if (process.platform === 'win32') {
    return isWindowsAdmin();
  } else if (process.platform === 'darwin') {
    return isMacOSAdmin();
  } else if (process.platform === 'linux') {
    return isLinuxRoot();
  }
  return false;
}

/**
 * Windows 管理员权限检测
 * 通过 whoami /groups 检查是否包含管理员组 SID
 */
function isWindowsAdmin(): boolean {
  try {
    const { execSync } = require('child_process');
    const result = execSync('whoami /groups', {
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // S-1-16-12288 是 High Mandatory Level（管理员完整性级别）
    return result.includes('S-1-16-12288');
  } catch {
    return false;
  }
}

/**
 * macOS 管理员权限检测
 */
function isMacOSAdmin(): boolean {
  try {
    const { execSync } = require('child_process');
    const result = execSync('id -u', { encoding: 'utf-8' }).trim();
    return result === '0';
  } catch {
    return false;
  }
}

/**
 * Linux root 权限检测
 */
function isLinuxRoot(): boolean {
  try {
    const { execSync } = require('child_process');
    const result = execSync('id -u', { encoding: 'utf-8' }).trim();
    return result === '0';
  } catch {
    return false;
  }
}

/**
 * 管理员权限服务类
 */
export class AdminPrivilegeService implements IAdminPrivilege {
  private _isAdmin: boolean | null = null;

  /**
   * 检测当前是否有管理员权限（带缓存）
   */
  isAdmin(): boolean {
    if (this._isAdmin === null) {
      this._isAdmin = isRunningAsAdmin();
    }
    return this._isAdmin;
  }

  /**
   * 检查 TUN 模式是否需要提升权限
   * 返回 false 因为我们不再通过重启应用来提升权限
   * sing-box 进程会在 TUN 模式下通过平台权限工具自己请求管理员权限
   */
  needsElevationForTun(): boolean {
    return false;
  }

  /**
   * 清除缓存的权限状态
   */
  clearCache(): void {
    this._isAdmin = null;
  }
}

// 导出单例
export const adminPrivilegeService = new AdminPrivilegeService();
