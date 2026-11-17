import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import sharp from 'sharp';

// Build-time derivatives only. Original artwork and its checksum manifest are untouched.
// One image at a time keeps peak memory bounded; the running server never encodes images.
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 8 });
async function* pngs(directory) {
  if (!existsSync(directory)) return;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) yield* pngs(path);
    else if (item.isFile() && /\.png$/i.test(item.name)) yield path;
  }
}
let count = 0, original = 0, optimized = 0;
for await (const path of pngs('dist/art')) {
  const width = basename(path) === 'table.png' ? 1920 : 480;
  const output = path.replace(/\.png$/i, '.webp');
  const result = await sharp(path).resize({ width, withoutEnlargement: true }).webp({ quality: 86, effort: 4 }).toFile(output);
  const decoded = await sharp(output).metadata();
  if (decoded.format !== 'webp' || decoded.width !== result.width || decoded.height !== result.height) throw Error(`Invalid derivative: ${output}`);
  count++; original += (await stat(path)).size; optimized += result.size;
}
if (count) console.log(`联网卡图：${count} 张，${(original / 1048576).toFixed(1)} → ${(optimized / 1048576).toFixed(1)} MiB；原图保留。`);
