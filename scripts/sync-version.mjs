/**
 * 版本同步：以 package.json 的 version 为唯一源，
 * 同步到 src-tauri/Cargo.toml（Tauri 打包时实际读取的版本）。
 * tauri.conf.json 里不写 version（已移除），避免三处不一致。
 *
 * 用法：node scripts/sync-version.mjs
 * 已接入 beforeBuildCommand，打包前自动执行。
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!version) {
  console.error('[sync-version] package.json 缺少 version 字段');
  process.exit(1);
}

const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
let cargo = readFileSync(cargoPath, 'utf8');
if (!/^version = ".*"$/m.test(cargo)) {
  console.error('[sync-version] Cargo.toml 未找到 version 字段');
  process.exit(1);
}
const updated = cargo.replace(
  /^version = ".*"$/m,
  `version = "${version}"`
);
if (updated !== cargo) {
  writeFileSync(cargoPath, updated);
  console.log(`[sync-version] 已同步版本 ${version} 到 src-tauri/Cargo.toml`);
} else {
  console.log(`[sync-version] 版本已是最新 (${version})，无需更新`);
}
