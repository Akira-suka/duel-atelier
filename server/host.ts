import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createOnlineServer } from './app';
import { quickTunnelOrigin, tunnelBinary } from './tunnel';

const publicMode = process.argv.includes('--public');
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT 必须是 1–65535 的整数');
if (!existsSync('dist/index.html')) throw Error('请先运行 npm run build，或双击 host-friends.cmd。');
const binary = publicMode ? await tunnelBinary() : null;
const database = resolve(process.env.DUEL_DATABASE ?? 'data/duel.sqlite');
mkdirSync(dirname(database), { recursive: true });
const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
const app = createOnlineServer({ database, staticRoot: resolve('dist'), origins: publicMode ? origins : undefined, maxRooms: 20, maxConnections: 16 });
let tunnel: ChildProcess | undefined, stopping = false;
const stop = async () => { if (stopping) return; stopping = true; tunnel?.kill(); await app.close(); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop(); });
process.on('exit', () => tunnel?.kill());
try {
  await new Promise<void>((resolveListen, reject) => { app.http.once('error', reject); app.http.listen(port, publicMode ? '127.0.0.1' : '0.0.0.0', resolveListen); });
  console.log(`房主打开：http://127.0.0.1:${port}/#online\n在网页创建房间，再把邀请码发给朋友。保持此窗口和电脑运行，Ctrl+C 停止。`);
  if (!publicMode) {
    for (const list of Object.values(networkInterfaces())) for (const address of list ?? []) if (address.family === 'IPv4' && !address.internal) console.log(`同一局域网的朋友打开：http://${address.address}:${port}/#online`);
    console.log('不同网络请改用「公网邀请」，无需购买域名。');
  } else {
    tunnel = spawn(binary!, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', published = false;
    const output = (chunk: Buffer) => {
      const line = chunk.toString(); process.stdout.write(line);
      tail = (tail + line).slice(-8192);
      const origin = quickTunnelOrigin(tail);
      if (origin && !published) {
        origins.push(origin); published = true;
        console.log(`\n朋友打开：${origin}/#online\n再输入你的房间邀请码。停止开服后临时网址失效；续玩前请双方保存网页中的「重连凭证」。\n`);
      }
    };
    tunnel.stdout!.on('data', output); tunnel.stderr!.on('data', output);
    tunnel.on('error', error => { console.error(`隧道启动失败：${error.message}`); process.exitCode = 1; void stop(); });
    tunnel.on('exit', code => { if (!stopping) { console.error(`公网连接已停止（${code ?? 'signal'}）。请重新开服获取新网址。`); process.exitCode = 1; void stop(); } });
  }
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; await stop(); }
