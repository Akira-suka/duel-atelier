import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { createOnlineServer } from '../server/app';
import type { ClientEvents, Reply, RoomSnapshot, ServerEvents } from '../src/online/protocol';

// Bounded smoke benchmark, including the server AND 24 clients in the same process.
const folder = mkdtempSync(join(tmpdir(), 'duel-online-bench-'));
const app = createOnlineServer({ database: join(folder, 'room.sqlite') });
const clients: Socket<ServerEvents, ClientEvents>[] = [];
const rooms: { code: string; sockets: Socket<ServerEvents, ClientEvents>[] }[] = [];
const read = (reply: Reply<RoomSnapshot>) => { if (!reply.ok) throw Error(reply.error); return reply.value; };
const initial = process.memoryUsage(); let peak = initial.rss;
const times: number[] = []; let largest = 0;
try {
  await new Promise<void>(resolve => app.http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.http.address() as AddressInfo).port}`;
  for (let i = 0; i < 12; i++) {
    const sockets: Socket<ServerEvents, ClientEvents>[] = [];
    let code: string | undefined;
    for (let seat = 0; seat < 2; seat++) {
      const socket: Socket<ServerEvents, ClientEvents> = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
      clients.push(socket); sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      const state = read(await socket.timeout(3000).emitWithAck('enter', { token: randomBytes(32).toString('base64url'), ...(code ? { code } : {}) }));
      code = state.code; largest = Math.max(largest, Buffer.byteLength(JSON.stringify(state)));
    }
    rooms.push({ code: code!, sockets });
  }
  for (let round = 0; round < 12; round++) {
    await Promise.all(rooms.map(async room => {
      const game = app.store.room(room.code).game;
      const socket = room.sockets[game.turn];
      const snapshot = read(await socket.timeout(3000).emitWithAck('sync'));
      const action = snapshot.legal.find(action => action.type === 'takeTokens') ?? snapshot.legal[0];
      const start = performance.now();
      const next = read(await socket.timeout(3000).emitWithAck('move', { id: randomUUID(), revision: game.revision, action }));
      times.push(performance.now() - start); largest = Math.max(largest, Buffer.byteLength(JSON.stringify(next)));
    }));
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  times.sort((a,b) => a-b);
  console.log(JSON.stringify({ rooms: rooms.length, sockets: clients.length, committedActions: times.length,
    p50AckMs: +times[Math.floor(times.length * .5)].toFixed(1), p95AckMs: +times[Math.floor(times.length * .95)].toFixed(1),
    peakCombinedRssMiB: +(peak / 1048576).toFixed(1), rssIncreaseMiB: +((peak - initial.rss) / 1048576).toFixed(1),
    maxSnapshotBytes: largest, sqliteFilesBytes: readdirSync(folder).reduce((sum, file) => sum + statSync(join(folder, file)).size, 0),
    note: 'Loopback smoke test; RSS includes both server and load clients. Not an internet capacity guarantee.' }, null, 2));
} finally {
  clients.forEach(client => client.disconnect()); await app.close();
  if (resolve(dirname(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('duel-online-bench-')) throw Error('Unsafe benchmark cleanup path');
  rmSync(folder, { recursive: true, force: true });
}
