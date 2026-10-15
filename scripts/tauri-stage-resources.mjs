/**
 * Tauri 打包前：把当前平台的 sing-box 二进制 + 通用资源
 * 集中到 src-tauri/bundle-resources/，tauri.conf.json 的 bundle.resources
 * 会把整个目录打进安装包。
 *
 * 布局（与 Rust 端 resolve 逻辑对应）：
 *   bundle-resources/sing-box[.exe]
 *   bundle-resources/data/*.srs
 *   bundle-resources/app.png / app-gray.png
 *   bundle-resources/status-{connected,disconnected,error}.png（托盘菜单状态圆点）
 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src-tauri', 'bundle-resources');

const platform = process.platform; // win32 | darwin | linux
const arch = process.arch; // x64 | arm64

let binDir;
if (platform === 'win32') binDir = 'win';
else if (platform === 'darwin') binDir = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
else binDir = `linux-${arch}`;

const binName = platform === 'win32' ? 'sing-box.exe' : 'sing-box';
const binSrc = join(root, 'resources', binDir, binName);
if (!existsSync(binSrc)) {
  console.error(`[tauri-stage] 找不到 sing-box 二进制: ${binSrc}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'data'), { recursive: true });

cpSync(binSrc, join(out, binName));
cpSync(join(root, 'resources', 'data'), join(out, 'data'), { recursive: true });
for (const icon of ['app.png', 'app-gray.png', 'status-connected.png', 'status-disconnected.png', 'status-error.png']) {
  const src = join(root, 'resources', icon);
  if (existsSync(src)) cpSync(src, join(out, icon));
}

console.log(`[tauri-stage] 已 staging: ${binDir}/${binName} -> src-tauri/bundle-resources/`);
