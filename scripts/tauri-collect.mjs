/**
 * Tauri 打包后：把 src-tauri/target 下的 bundle 产物集中拷到根目录 dist-package/。
 *
 * 产物路径取决于构建时是否传了 --target：
 *   tauri build --target aarch64-apple-darwin -> target/aarch64-apple-darwin/release/bundle/
 *   tauri build（不带 --target）               -> target/release/bundle/
 */
import { renameSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-package');
const targetRoot = join(root, 'src-tauri', 'target');

// 传了 --target 时：target/<triple>/release/bundle
const triples = [
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
];
const bundleDirs = [
  ...triples.map((t) => join(targetRoot, t, 'release', 'bundle')),
  // 未传 --target 时：target/release/bundle
  join(targetRoot, 'release', 'bundle'),
];

function collectFiles(dir, exts) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      results.push(...collectFiles(p, exts));
    } else if (exts.some((e) => name.endsWith(e)) && !name.endsWith('.sig')) {
      results.push(p);
    }
  }
  return results;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const exts = ['.exe', '.msi', '.dmg', '.AppImage', '.deb', '.rpm'];
let copied = 0;
for (const bundleDir of bundleDirs) {
  for (const f of collectFiles(bundleDir, exts)) {
    const dest = join(outDir, basename(f));
    renameSync(f, dest);
    console.log(`[tauri-collect] ${f} -> ${dest}`);
    copied++;
  }
}

if (copied === 0) {
  console.error('[tauri-collect] 未找到任何安装包，请确认 tauri build 已成功。已查找以下目录：');
  for (const d of bundleDirs) {
    console.error(`  ${existsSync(d) ? '[存在]  ' : '[不存在]'} ${d}`);
  }
  process.exit(1);
}
console.log(`[tauri-collect] 共收集 ${copied} 个安装包到 dist-package/`);
