import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * 资源文件管理器
 * 根据平台和架构返回对应的资源文件路径
 */
export class ResourceManager {
  private readonly isDev: boolean;
  private readonly platform: string;
  private readonly arch: string;

  constructor() {
    this.isDev = !app.isPackaged;
    this.platform = process.platform;
    this.arch = process.arch;
  }

  /**
   * 获取 sing-box 可执行文件路径
   */
  getSingBoxPath(): string {
    // Windows 平台需要 .exe 扩展名
    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
    const platformDir = this.getPlatformResourceDir();
    const singboxPath = path.join(platformDir, filename);

    return singboxPath;
  }

  /**
   * 获取应用图标路径（统一使用 app.png）
   */
  getAppIconPath(): string {
    if (this.isDev) {
      return path.join(process.cwd(), 'resources', 'app.png');
    }
    // 生产环境：app.png 在 process.resourcesPath 根目录
    return path.join(process.resourcesPath, 'app.png');
  }

  /**
   * 获取托盘图标路径
   * @param connected 是否已连接，true 返回彩色图标，false 返回灰色图标
   */
  getTrayIconPath(connected: boolean = false): string {
    const filename = connected ? 'app.png' : 'app-gray.png';
    if (this.isDev) {
      return path.join(process.cwd(), 'resources', filename);
    }
    return path.join(process.resourcesPath, filename);
  }

  /**
   * 获取 GeoIP 数据文件路径
   */
  getGeoIPPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geoip-cn.srs');
  }

  /**
   * 获取 GeoSite 中国数据文件路径
   */
  getGeoSiteCNPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geosite-cn.srs');
  }

  /**
   * 获取 GeoSite 非中国数据文件路径
   */
  getGeoSiteNonCNPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geosite-geolocation-!cn.srs');
  }

  /**
   * 检查资源文件是否存在
   */
  async checkResourcesExist(): Promise<{ exists: boolean; missing: string[] }> {
    const missing: string[] = [];

    // 检查 sing-box 可执行文件
    const singboxPath = this.getSingBoxPath();
    if (!(await this.fileExists(singboxPath))) {
      missing.push(`sing-box executable: ${singboxPath}`);
    }

    // 检查 GeoIP/GeoSite 数据文件
    const geoFiles = [
      { name: 'GeoIP CN', path: this.getGeoIPPath() },
      { name: 'GeoSite CN', path: this.getGeoSiteCNPath() },
      { name: 'GeoSite Non-CN', path: this.getGeoSiteNonCNPath() },
    ];

    for (const file of geoFiles) {
      if (!(await this.fileExists(file.path))) {
        missing.push(`${file.name}: ${file.path}`);
      }
    }

    return {
      exists: missing.length === 0,
      missing,
    };
  }

  /**
   * 获取平台特定的资源目录
   */
  private getPlatformResourceDir(): string {
    const baseDir = this.getResourcesBaseDir();

    if (this.platform === 'win32') {
      return path.join(baseDir, 'win');
    } else if (this.platform === 'darwin') {
      if (this.isDev) {
        // 开发环境：根据架构选择不同的目录
        if (this.arch === 'arm64') {
          return path.join(baseDir, 'mac-arm64');
        } else {
          return path.join(baseDir, 'mac-x64');
        }
      } else {
        // 生产环境：打包后统一使用 mac 目录
        return path.join(baseDir, 'mac');
      }
    } else if (this.platform === 'linux') {
      if (this.isDev) {
        return path.join(baseDir, `linux-${this.arch}`);
      }

      return path.join(baseDir, 'linux');
    }

    throw new Error(`Unsupported platform: ${this.platform}`);
  }

  /**
   * 获取数据文件目录
   */
  private getDataResourceDir(): string {
    const baseDir = this.getResourcesBaseDir();
    return path.join(baseDir, 'data');
  }

  /**
   * 获取资源文件基础目录
   * 开发环境和生产环境路径不同
   */
  private getResourcesBaseDir(): string {
    if (this.isDev) {
      // 开发环境：项目根目录下的 resources
      return path.join(process.cwd(), 'resources');
    } else {
      // 生产环境：打包后的 resources 目录
      // process.resourcesPath 指向 app.asar 所在的 resources 目录
      // extraResources 直接复制到 process.resourcesPath 下
      return process.resourcesPath;
    }
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取资源信息（用于调试）
   */
  getResourceInfo(): {
    isDev: boolean;
    platform: string;
    arch: string;
    baseDir: string;
    singboxPath: string;
    geoIPPath: string;
    geoSiteCNPath: string;
    geoSiteNonCNPath: string;
  } {
    return {
      isDev: this.isDev,
      platform: this.platform,
      arch: this.arch,
      baseDir: this.getResourcesBaseDir(),
      singboxPath: this.getSingBoxPath(),
      geoIPPath: this.getGeoIPPath(),
      geoSiteCNPath: this.getGeoSiteCNPath(),
      geoSiteNonCNPath: this.getGeoSiteNonCNPath(),
    };
  }
}

// 导出单例实例
export const resourceManager = new ResourceManager();
