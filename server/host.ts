import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createOnlineServer } from './app';
import { parseArgs } from 'node:util';
import { quickTunnelOrigin, sshTunnelArgs, sshTunnelOrigin, tunnelBinary } from './tunnel';

const { values } = parseArgs({ options: { public: { type: 'boolean' }, ssh: { type: 'boolean' }, port: { type: 'string' }, database: { type: 'string' } } });
const sshMode = !!values.ssh, publicMode = !!values.public || sshMode;
const port = Number(values.port ?? process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT 必须是 1–65535 的整数');
if (!existsSync('dist/index.html')) throw Error('请先运行 npm run build，或双击 host-friends.cmd。');
let binary: string | null = null;
let sshArgs: string[] = [];
try { if (sshMode) { binary = 'ssh'; sshArgs = await sshTunnelArgs(port); } else binary = publicMode ? await tunnelBinary() : null; }
catch (error) {
  console.error(`隧道工具准备失败：${error instanceof Error ? error.message : error}\n${sshMode ? '请确认已安装 OpenSSH 客户端，且网络允许连接 localhost.run:22。' : '可重试开服，或从 Cloudflare 官方下载 cloudflared 后设置 CLOUDFLARED。'}同网游玩可选择局域网模式。`);
  process.exit(1);
}
const database = resolve(values.database ?? process.env.DUEL_DATABASE ?? 'data/duel.sqlite');
mkdirSync(dirname(database), { recursive: true });
const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
const app = createOnlineServer({ database, staticRoot: resolve('dist'), origins: publicMode ? origins : undefined, maxRooms: 20, maxConnections: 16 });
let tunnel: ChildProcess | undefined, stopping = false;
let startupTimer: ReturnType<typeof setTimeout> | undefined;
const stop = async () => { if (stopping) return; stopping = true; clearTimeout(startupTimer); tunnel?.kill(); await app.close(); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop(); });
process.on('exit', () => tunnel?.kill());
try {
  await new Promise<void>((resolveListen, reject) => { app.http.once('error', reject); app.http.listen(port, publicMode ? '127.0.0.1' : '0.0.0.0', resolveListen); });
  console.log(`房主打开：http://127.0.0.1:${port}/#online\n在网页创建房间，再把邀请码发给朋友。保持此窗口和电脑运行，Ctrl+C 停止。`);
  if (!publicMode) {
    for (const list of Object.values(networkInterfaces())) for (const address of list ?? []) if (address.family === 'IPv4' && !address.internal) console.log(`同一局域网的朋友打开：http://${address.address}:${port}/#online`);
    console.log('不同网络请改用「公网邀请」，无需购买域名。');
  } else {
    const protocol = process.env.TUNNEL_PROTOCOL ?? 'http2';
    if (!['http2', 'quic', 'auto'].includes(protocol)) throw Error('TUNNEL_PROTOCOL 必须是 http2、quic 或 auto');
    tunnel = spawn(binary!, sshMode ? sshArgs : ['tunnel', '--no-autoupdate', '--protocol', protocol, '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', published = false, publicOrigin: string | null = null;
    startupTimer = setTimeout(() => { console.error(`公网连接在 90 秒内未就绪。请检查网络是否允许 TCP ${sshMode ? '22' : '7844'} 出站，或换用另一种公网方式；仅获得临时网址不代表隧道已连通。`); process.exitCode = 1; void stop(); }, 90000);
    const output = (chunk: Buffer) => {
      const line = chunk.toString(); if (!sshMode) process.stdout.write(line);
      tail = (tail + line).slice(-65536);
      const origin = sshMode ? sshTunnelOrigin(tail) : quickTunnelOrigin(tail);
      if (origin && origin !== publicOrigin) {
        if (publicOrigin) origins.splice(origins.indexOf(publicOrigin), 1);
        publicOrigin = origin; origins.push(origin); published = false;
        console.log('已获得临时网址，等待公网连接就绪…');
      }
      if (publicOrigin && !published && (sshMode || tail.includes('Registered tunnel connection'))) {
        published = true; clearTimeout(startupTimer);
        console.log(`\n公网连接已就绪。朋友打开：${publicOrigin}/#online\n再输入你的房间邀请码。停止开服后临时网址失效；续玩前请双方保存网页中的「重连凭证」。\n`);
      }
    };
    tunnel.stdout!.on('data', output); tunnel.stderr!.on('data', output);
    tunnel.on('error', error => { console.error(`隧道启动失败：${error.message}`); process.exitCode = 1; void stop(); });
    tunnel.on('exit', code => { if (!stopping) { console.error(`公网连接已停止（${code ?? 'signal'}）。请重新开服获取新网址。`); process.exitCode = 1; void stop(); } });
  }
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; await stop(); }
