import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { downloadVerified, quickTunnelOrigin, sshTunnelOrigin } from './tunnel';

describe('temporary public origin', () => {
  it('accepts only registered SSH relay hostnames', () => {
    const event = (address: string) => JSON.stringify({ type: 'run.localhost.tunnel.registered', data: { address } });
    expect(sshTunnelOrigin('SSH banner\n' + event('abc123.app.lhr.life'))).toBe('https://abc123.app.lhr.life');
    expect(sshTunnelOrigin(event('abc.localhost.run'))).toBe('https://abc.localhost.run');
    expect(sshTunnelOrigin(event('old.app.lhr.life') + '\n' + event('new.app.lhr.life'))).toBe('https://new.app.lhr.life');
    expect(sshTunnelOrigin(event('abc.app.lhr.life.evil.example'))).toBeNull();
    expect(sshTunnelOrigin(event('abc.app.lhr.life/path'))).toBeNull();
    expect(sshTunnelOrigin('{"type":"other","data":{"address":"abc.app.lhr.life"}}')).toBeNull();
    expect(sshTunnelOrigin('{"type":')).toBeNull();
  });
  it('extracts the exact HTTPS hostname, not other URLs or spoofed suffixes', () => {
    expect(quickTunnelOrigin('| https://a-b-c.trycloudflare.com |')).toBe('https://a-b-c.trycloudflare.com');
    expect(quickTunnelOrigin('https://a.trycloudflare.com.evil.example')).toBeNull();
    expect(quickTunnelOrigin('http://a.trycloudflare.com')).toBeNull();
    expect(quickTunnelOrigin('https://evil.example')).toBeNull();
  });
});

it('resumes a partial tool download and never promotes a checksum mismatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'duel-tunnel-test-'));
  const bytes = Buffer.from('official-test-binary'.repeat(200));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const ranges: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    ranges.push(request.headers.range);
    const offset = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    if (offset) response.writeHead(206, { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` });
    response.end(bytes.subarray(offset));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const file = join(directory, 'helper');
    writeFileSync(file + '.download', bytes.subarray(0, 100));
    await downloadVerified(url, file, digest);
    expect(ranges).toEqual(['bytes=100-']);
    expect(readFileSync(file)).toEqual(bytes);
    const invalid = join(directory, 'invalid');
    await expect(downloadVerified(url, invalid, '0'.repeat(64))).rejects.toThrow('校验失败');
    expect(existsSync(invalid)).toBe(false);
    expect(existsSync(invalid + '.download')).toBe(false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (resolve(dirname(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('duel-tunnel-test-')) throw Error('Unsafe cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
});
