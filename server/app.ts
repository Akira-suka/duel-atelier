import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Server, type Socket } from 'socket.io';
import { getLegalActions, getPlayerView } from '../src/game/engine';
import { isAction } from '../src/game/match';
import type { Ack, ClientEvents, MoveCommand, RoomSnapshot, ServerEvents } from '../src/online/protocol';
import { RoomStore, type Seat } from './store';

type Peer = Socket<ClientEvents, ServerEvents, Record<string, never>, { seat?: Seat }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const codePattern = /^[A-HJ-NP-Z2-9]{8}$/;
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

export function createOnlineServer(options: { database: string; staticRoot?: string; origins?: string[]; maxRooms?: number; maxConnections?: number }) {
  const store = new RoomStore(options.database, options.maxRooms);
  store.prune();
  const http = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.url === '/health') { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'); return; }
    if (!options.staticRoot || !['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(404).end(); return; }
    try {
      const root = await realpath(options.staticRoot);
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const path = await realpath(resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)));
      const rel = relative(root, path);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !(await stat(path)).isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': rel.startsWith('assets' + sep) ? 'public,max-age=31536000,immutable' : 'no-cache' });
      if (request.method === 'HEAD') response.end();
      else createReadStream(path).on('error', () => response.destroy()).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  const io = new Server<ClientEvents, ServerEvents, Record<string, never>, { seat?: Seat }>(http, {
    transports: ['websocket'], maxHttpBufferSize: 8192, perMessageDeflate: false, serveClient: false,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      const allowed = !origin || (options.origins?.length ? options.origins.includes(origin) : origin === `http://${request.headers.host}`);
      callback(null, allowed && io.engine.clientsCount < (options.maxConnections ?? 128));
    },
  });
  // Bounded IP admission buckets; no game snapshots or recovery packet history in memory.
  const rates = new Map<string, { time: number; count: number }>();
  const take = (key: string, limit: number, period: number) => {
    const now = Date.now();
    let bucket = rates.get(key);
    if (!bucket || now - bucket.time > period) {
      if (rates.size >= 2048) rates.delete(rates.keys().next().value!);
      bucket = { time: now, count: 0 }; rates.set(key, bucket);
    }
    return ++bucket.count <= limit;
  };
  io.use((socket, next) => next(io.of('/').sockets.size < (options.maxConnections ?? 128)
    && take(`connect:${socket.handshake.address}`, 60, 60000) ? undefined : Error('连接已满或过于频繁，请稍后重试')));
  const peers = (code: string) => [...io.of('/').sockets.values()].filter(peer => peer.data.seat?.code === code);
  const queued = new WeakMap<Peer, number>();
  const snapshot = (seat: Seat): RoomSnapshot => {
    const room = store.room(seat.code);
    const connected: [boolean, boolean] = [false, false];
    for (const peer of peers(seat.code)) connected[peer.data.seat!.seat] = true;
    return { code: seat.code, seat: seat.seat, ready: !!room.guest, connected, view: getPlayerView(room.game, seat.seat),
      legal: room.guest && room.game.turn === seat.seat ? getLegalActions(room.game) : [] };
  };
  const broadcast = (code: string) => {
    for (const peer of peers(code)) {
      if ((queued.get(peer) ?? 0) > 32) { peer.conn.close(); continue; }
      try { peer.emit('state', snapshot(peer.data.seat!)); } catch { peer.disconnect(true); }
    }
  };
  io.on('connection', (peer: Peer) => {
    peer.conn.on('packetCreate', () => queued.set(peer, (queued.get(peer) ?? 0) + 1));
    peer.conn.on('drain', () => queued.set(peer, 0));
    let count = 0; let windowStart = Date.now();
    const call = <T>(ack: Ack<T>, work: () => T) => {
      if (typeof ack !== 'function') return;
      if ((queued.get(peer) ?? 0) > 32) { peer.conn.close(); return; }
      if (Date.now() - windowStart > 10000) { count = 0; windowStart = Date.now(); }
      if (++count > 40) { ack({ ok: false, error: '操作过于频繁，请稍后重试' }); return; }
      try { ack({ ok: true, value: work() }); }
      catch (error) { ack({ ok: false, error: error instanceof Error ? error.message : '服务器暂时无法处理请求' }); }
    };
    const seat = () => { if (!peer.data.seat) throw Error('请先加入房间'); return peer.data.seat; };
    peer.on('enter', (request, ack) => call(ack, () => {
      if (!object(request) || typeof request.token !== 'string' || !tokenPattern.test(request.token) || Object.keys(request).some(key => !['token', 'code'].includes(key))
        || (request.code !== undefined && (typeof request.code !== 'string' || !codePattern.test(request.code)))) throw Error('房间凭证格式无效');
      if (peer.data.seat) throw Error('此连接已加入房间');
      if (!take(`enter:${peer.handshake.address}`, 30, 60000)) throw Error('加入房间过于频繁，请稍后重试');
      const joined = store.enter(request.token as string, request.code as string | undefined);
      for (const previous of peers(joined.code)) if (previous.data.seat!.seat === joined.seat) {
        previous.emit('replaced'); previous.disconnect(true);
      }
      peer.data.seat = joined;
      broadcast(joined.code);
      return snapshot(joined);
    }));
    peer.on('sync', ack => call(ack, () => snapshot(seat())));
    peer.on('move', (command, ack) => {
      call(ack, () => {
        if (!object(command) || Object.keys(command).some(key => !['id', 'revision', 'action'].includes(key))
          || typeof command.id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(command.id)
          || !Number.isSafeInteger(command.revision) || (command.revision as number) < 0 || !isAction(command.action)) throw Error('行动格式无效');
        const owner = seat(); store.move(owner, command as unknown as MoveCommand);
        broadcast(owner.code); return snapshot(owner);
      });
    });
    peer.on('replay', ack => call(ack, () => store.replay(seat())));
    peer.on('disconnect', () => { if (peer.data.seat) broadcast(peer.data.seat.code); });
  });
  const cleanup = setInterval(() => { store.prune(); for (const [key, bucket] of rates) if (Date.now() - bucket.time > 60000) rates.delete(key); }, 3600000);
  cleanup.unref();
  return { http, io, store, close: () => new Promise<void>(resolveClose => { clearInterval(cleanup); io.close(() => { store.close(); resolveClose(); }); }) };
}
