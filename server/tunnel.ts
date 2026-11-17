import { createHash } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function sshTunnelOrigin(text: string): string | null {
  for (const line of text.split('\n').reverse()) try {
    const event = JSON.parse(line);
    if (event.type === 'run.localhost.tunnel.registered' && typeof event.data?.address === 'string'
      && /^[a-z0-9-]+(?:\.app)?\.(?:lhr\.life|localhost\.run)$/.test(event.data.address)) return `https://${event.data.address}`;
  } catch { /* SSH banners are not JSON. */ }
  return null;
}

export async function sshTunnelArgs(port: number): Promise<string[]> {
  const directory = resolve('tools'); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, 'localhost-run-known-hosts');
  // Published by https://localhost.run/docs/security; no user keys or global SSH settings are used.
  const verified = (text: string) => text.split(/\r?\n/).some(line => {
    const key = line.match(/^localhost\.run ssh-ed25519 ([A-Za-z0-9+/=]+)$/)?.[1];
    return key && createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '') === 'pG6qrBxubYfWa1Zadu/V0NUgjEDiBds/7e2xzte/QNM';
  });
  if (!existsSync(path) || !verified(readFileSync(path, 'utf8'))) {
    const { stdout } = await promisify(execFile)('ssh-keyscan', ['-T', '10', '-t', 'ed25519', 'localhost.run'], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
    if (!verified(stdout)) throw Error('备用隧道主机指纹与官方公布值不符，已停止连接');
    writeFileSync(path, stdout);
  }
  return ['-F', process.platform === 'win32' ? 'NUL' : '/dev/null', '-o', `UserKnownHostsFile=${path}`, '-o', 'StrictHostKeyChecking=yes',
    '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=none', '-o', 'IdentityAgent=none',
    '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run', '--', '--output', 'json'];
}

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
  // Pinned official release: no anonymous GitHub API dependency or silent binary upgrades.
  // Checksums: https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0
  const hashes: Record<string, string> = {
    'cloudflared-windows-amd64.exe': 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a',
    'cloudflared-linux-amd64': '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd',
    'cloudflared-linux-arm64': 'abe54a006acf9faf2d19ee9d953cb0d0804e92f59c5382a162e57b84d086f56f',
  };
  const digestExpected = hashes[assetName];
  if (existsSync(path) && await fileDigest(path) === digestExpected) return path;
  console.log('首次公网开服：从 Cloudflare 官方 GitHub 下载便携 cloudflared，并核验 SHA-256（无需管理员权限）。');
  await downloadVerified(`https://github.com/cloudflare/cloudflared/releases/download/2026.11.0/${assetName}`, path, digestExpected);
  if (process.platform !== 'win32') chmodSync(path, 0o700);
  writeFileSync(digestPath, digestExpected + '\n');
  return path;
}

async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Stream to disk and resume partial downloads; never execute an unchecked file. */
export async function downloadVerified(url: string, path: string, expected: string) {
  const temporary = path + '.download';
  let offset = existsSync(temporary) ? statSync(temporary).size : 0;
  if (offset > 128 * 1024 * 1024) throw Error('临时下载文件超过大小限制');
  if (offset && await fileDigest(temporary) === expected) { renameSync(temporary, path); return; }
  const binary = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.timeout(30 * 60000) });
  if (!binary.ok || !binary.body) throw Error(`下载失败：HTTP ${binary.status}`);
  if (binary.status === 206) {
    if (!binary.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw Error('下载续传范围不一致');
  } else offset = 0;
  const reader = binary.body.getReader(), file = openSync(temporary, offset ? 'a' : 'w');
  let size = offset, reported = Math.floor(size / 4194304);
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > 128 * 1024 * 1024) throw Error('下载大小超过限制');
      writeFileSync(file, chunk);
      if (Math.floor(size / 4194304) > reported) { reported = Math.floor(size / 4194304); console.log(`已下载 cloudflared ${(size / 1048576).toFixed(1)} MiB，网络较慢时请保持窗口运行。`); }
    }
  } finally { closeSync(file); await reader.cancel(); }
  if (await fileDigest(temporary) !== expected) { unlinkSync(temporary); throw Error('cloudflared 校验失败，未执行下载文件。'); }
  renameSync(temporary, path);
}
