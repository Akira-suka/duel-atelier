import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function quickTunnelOrigin(text: string): string | null {
  return text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s/|]|$)/)?.[0] ?? null;
}

/** Optional portable helper, fetched only when the owner explicitly starts public hosting. */
export async function tunnelBinary() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  const assetName = process.platform === 'win32' && process.arch === 'x64' ? 'cloudflared-windows-amd64.exe'
    : process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch) ? `cloudflared-linux-${process.arch === 'x64' ? 'amd64' : 'arm64'}` : null;
  if (!assetName) throw Error('此平台请自行安装 cloudflared，并设置 CLOUDFLARED 为其可执行文件路径。');
  const directory = resolve('tools'); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, assetName), digestPath = path + '.sha256';
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  if (existsSync(path) && existsSync(digestPath) && sha256(readFileSync(path)) === readFileSync(digestPath, 'utf8').trim()) return path;
  console.log('首次公网开服：从 Cloudflare 官方 GitHub 下载便携 cloudflared，并核验 SHA-256（无需管理员权限）。');
  const response = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'duel-atelier-host' }, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error(`无法获取 cloudflared：HTTP ${response.status}。可手动下载后设置 CLOUDFLARED。`);
  const release = await response.json() as { assets?: { name: string; digest?: string; browser_download_url: string; size: number }[] };
  const asset = release.assets?.find(asset => asset.name === assetName);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') || !asset.browser_download_url.startsWith('https://github.com/cloudflare/cloudflared/releases/download/') || asset.size > 128 * 1024 * 1024) throw Error('官方发布缺少可核验的下载信息，请手动安装 cloudflared。');
  const binary = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180000) });
  if (!binary.ok || !binary.body) throw Error(`下载失败：HTTP ${binary.status}`);
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = binary.body.getReader();
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    size += chunk.length;
    if (size > asset.size || size > 128 * 1024 * 1024) throw Error('下载大小超过预期');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks), digest = sha256(bytes);
  if (size !== asset.size || `sha256:${digest}` !== asset.digest) throw Error('cloudflared 校验失败，未执行下载文件。');
  const temporary = path + '.download'; writeFileSync(temporary, bytes); renameSync(temporary, path);
  if (process.platform !== 'win32') chmodSync(path, 0o700);
  writeFileSync(digestPath, digest + '\n');
  return path;
}
