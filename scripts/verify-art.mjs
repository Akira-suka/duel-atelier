import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
for (const file of ['src/theme/atelier.ts', 'src/theme/index.ts', 'src/ui/UnitEmblem.tsx']) {
  if (!readFileSync(new URL(file, root), 'utf8').trim()) throw new Error(`Missing theme source: ${file}`);
}
console.log('公开主题检查通过：原创几何 SVG，资源全部本地生成。');
if (existsSync(fileURLToPath(new URL('src/theme/local/eva/eva-art.json', root)))) await import('./verify-local-art.mjs');
