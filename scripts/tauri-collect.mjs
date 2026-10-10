/**
 * Tauri 打包后：把 src-tauri/target/<triple>/release/bundle/ 下的产物
 * 集中拷到根目录 dist-package/（与之前 electron-builder 的输出目录一致）。
 */
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-package');

// 支持的 target triple（按平台）
const triples = [
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'release', // 默认 target（无 --target 时）
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
for (const triple of triples) {
  const bundleDir = join(root, 'src-tauri', 'target', triple, 'release', 'bundle');
  for (const f of collectFiles(bundleDir, exts)) {
    const dest = join(outDir, f.split('/').pop());
    cpSync(f, dest);
    console.log(`[tauri-collect] ${f} -> ${dest}`);
    copied++;
  }
}

if (copied === 0) {
  console.error('[tauri-collect] 未找到任何安装包，请确认 tauri build 已成功');
  process.exit(1);
}
console.log(`[tauri-collect] 共收集 ${copied} 个安装包到 dist-package/`);
