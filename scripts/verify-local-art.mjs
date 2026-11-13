import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const errors = [];
const fail = message => errors.push(message);
const read = file => readFileSync(path.join(root, file));
const json = file => JSON.parse(read(file).toString('utf8').replace(/^\uFEFF/, ''));
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function array(value, label, expected) {
  if (!Array.isArray(value)) {
    fail(`${label} 必须是数组。`);
    return [];
  }
  if (value.length !== expected) fail(`${label} 应有 ${expected} 项，实际 ${value.length} 项。`);
  return value;
}

// Read the two literal tables, without evaluating TypeScript or importing build tools.
function catalogIds(source, name, pattern, expected) {
  const body = source.match(new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)^\\];`, 'm'))?.[1];
  if (!body) {
    fail(`无法读取 catalog.ts 的 ${name} 字面量表，请更新校验器。`);
    return [];
  }
  const ids = [...body.matchAll(pattern)].map(match => match[2]);
  if (ids.length !== expected || new Set(ids).size !== expected) {
    fail(`catalog.ts 的 ${name} 应有 ${expected} 个唯一 ID，实际读取 ${ids.length} 个；请检查目录或校验器。`);
  }
  return ids;
}

function checkMapping(entries, ids, label) {
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) {
      fail(`${label} 包含缺少有效 ID 的条目。`);
      continue;
    }
    if (seen.has(entry.id)) fail(`${label} 重复 ID：${entry.id}。`);
    seen.add(entry.id);
  }
  const catalog = new Set(ids);
  for (const id of catalog) if (!seen.has(id)) fail(`${label} 缺少 catalog 映射：${id}。`);
  for (const id of seen) if (!catalog.has(id)) fail(`${label} 含有 catalog 未定义的 ID：${id}。`);
}

function pngInfo(data) {
  if (data.length < 33 || !data.subarray(0, 8).equals(signature)) throw new Error('不是有效的 PNG 签名或文件过短');
  if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('首块不是长度为 13 的 IHDR');
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const depth = data[24];
  const colorType = data[25];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!width || !height || !depths[colorType]?.includes(depth) || data[26] !== 0 || data[27] !== 0 || data[28] > 1) {
    throw new Error('IHDR 尺寸、色彩类型、位深或编码字段无效');
  }
  let offset = 8;
  let imageBytes = 0;
  let ended = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > data.length) throw new Error(`${type} 数据块被截断`);
    if (type === 'IHDR' && offset !== 8) throw new Error('重复 IHDR');
    if (type === 'IDAT') imageBytes += length;
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== data.length) throw new Error('IEND 非空或其后还有额外数据');
      ended = true;
      break;
    }
  }
  if (!ended || !imageBytes) throw new Error('缺少完整 IEND 或非空 IDAT 图像数据');
  return { width, height };
}

function main() {
  const art = json('src/theme/local/eva/eva-art.json');
  const interfaceArt = array(json('src/theme/local/eva/eva-interface.json'), '界面素材清单', 4);
  const jewels = array(art?.cards, '宝石牌素材清单', 67);
  const royals = array(art?.royals, '王室牌素材清单', 4);
  const catalog = read('src/game/catalog.ts').toString('utf8');
  const jewelIds = catalogIds(catalog, 'JEWEL_CARDS', /\bjewel\(\s*(['"])([^'"]+)\1/g, 67);
  const royalIds = catalogIds(catalog, 'ROYAL_CARDS', /\{\s*id\s*:\s*(['"])([^'"]+)\1/g, 4);
  checkMapping(jewels, jewelIds, '宝石牌素材清单');
  checkMapping(royals, royalIds, '王室牌素材清单');
  const expectedInterface = {
    'deck-1': 'deck', 'deck-2': 'deck', 'deck-3': 'deck', table: 'table',
  };
  checkMapping(interfaceArt, Object.keys(expectedInterface), '界面素材清单');
  for (const entry of interfaceArt) {
    if (entry && entry.kind !== expectedInterface[entry.id]) fail(`${entry.id} 的 kind 应为 ${expectedInterface[entry.id] ?? '已定义类型'}，实际 ${entry.kind}。`);
  }

  const entries = [
    ...jewels.map(entry => ({ ...entry, category: 'card' })),
    ...royals.map(entry => ({ ...entry, category: 'card' })),
    ...interfaceArt.map(entry => ({ ...entry, category: entry?.kind })),
  ];
  const paths = new Map();
  const hashes = new Map();
  let checked = 0;
  for (const entry of entries) {
    const label = `${entry.id ?? '未知 ID'} (${entry.file ?? '未指定路径'})`;
    if (typeof entry.file !== 'string' || !/^\/art\/eva\/(?:[\w-]+\/)*[\w-]+\.png$/.test(entry.file)) {
      fail(`${label}：必须使用 /art/eva/ 下无路径跳转的 PNG 路径。`);
      continue;
    }
    const key = entry.file.toLowerCase();
    if (paths.has(key)) fail(`${label}：与 ${paths.get(key)} 使用同一路径。`);
    paths.set(key, entry.id);
    try {
      const data = read(`public${entry.file}`);
      if (!data.length) throw new Error('文件为空');
      const digest = createHash('sha256').update(data).digest('hex');
      if (hashes.has(digest)) fail(`${label}：内容与 ${hashes.get(digest)} 完全重复 (SHA-256)。`);
      hashes.set(digest, entry.id);
      const { width, height } = pngInfo(data);
      if (entry.category === 'card' || entry.category === 'deck') {
        if (width < 1000 || Math.abs(width / height - 3 / 4) > 0.01) {
          fail(`${label}：卡面/牌背要求宽度 >= 1000 且宽高比 3:4 (容差 0.01)，实际 ${width}×${height}。`);
        }
      } else if (entry.category === 'table') {
        if (width < 1500 || width <= height) fail(`${label}：桌面必须为横版且宽度 >= 1500，实际 ${width}×${height}。`);
      }
      checked++;
    } catch (error) {
      fail(`${label}：${error.code === 'ENOENT' ? '文件缺失' : error.message}。`);
    }
  }
  if (errors.length) {
    console.error(`EVA 素材校验失败（${errors.length} 项问题，已读取 ${checked}/${entries.length} 项）：\n${errors.map(error => `- ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`EVA 素材校验通过：67 宝石牌 + 4 王室牌 + 4 界面素材 = ${checked} 项；PNG、尺寸、独立 SHA-256 与 catalog 映射均通过。`);
  }
}

try {
  main();
} catch (error) {
  console.error(`EVA 素材校验无法完成：${error.message}`);
  process.exitCode = 1;
}
