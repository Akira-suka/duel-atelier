import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { getLegalActions, validateState } from '../src/game/engine';
import { parseMatch } from '../src/game/match';
import { chooseSimulationAction } from '../src/analysis/win-probability';
import { OnlineClient, type OnlineState } from '../src/online/client';
import type { ClientEvents, MoveCommand, Reply, RoomSnapshot, ServerEvents } from '../src/online/protocol';
import { createOnlineServer } from './app';

type Client = Socket<ServerEvents, ClientEvents>;
const token = () => randomBytes(32).toString('base64url');
function value<T = RoomSnapshot>(reply: Reply<T>): T { if (!reply.ok) throw Error(reply.error); return reply.value; }
const apps: ReturnType<typeof createOnlineServer>[] = [];
const clients: Client[] = [];
const owners: OnlineClient[] = [];
const folders: string[] = [];
async function start(database = ':memory:', options = {}) {
  const app = createOnlineServer({ database, ...options }); apps.push(app);
  await new Promise<void>(resolve => app.http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.http.address() as AddressInfo).port}`;
  return { app, url };
}
async function connect(url: string) {
  const client: Client = io(url, { transports: ['websocket'], reconnection: false, forceNew: true }); clients.push(client);
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  return client;
}
async function pair(url: string) {
  const a = await connect(url), b = await connect(url);
  const secret = token();
  const first = value(await a.timeout(2000).emitWithAck('enter', { token: secret }));
  const guestSecret = token();
  const second = value(await b.timeout(2000).emitWithAck('enter', { token: guestSecret, code: first.code }));
  return { a: first.view.turn === 0 ? a : b, b: first.view.turn === 0 ? b : a, secret: first.view.turn === 0 ? secret : guestSecret, first, second };
}
afterEach(async () => {
  owners.splice(0).forEach(owner => owner.close()); clients.splice(0).forEach(client => client.disconnect());
  for (const app of apps.splice(0)) await app.close();
  for (const folder of folders.splice(0)) {
    if (resolve(dirname(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('duel-online-')) throw Error('Unsafe test cleanup path');
    rmSync(folder, { recursive: true, force: true });
  }
});

describe('authoritative online transport', () => {
  it('enforces seat, turn, revision, schema and idempotency; spectators cannot read a game', async () => {
    const { app, url } = await start(); const { a, b, first, second } = await pair(url);
    expect(first.ready).toBe(false); expect(second.ready).toBe(true);
    const outsider = await connect(url);
    expect((await outsider.timeout(2000).emitWithAck('sync')).ok).toBe(false);
    expect((await outsider.timeout(2000).emitWithAck('enter', { token: token(), code: first.code })).ok).toBe(false);
    const current = value(await a.timeout(2000).emitWithAck('sync'));
    const command: MoveCommand = { id: randomUUID(), revision: 0, action: current.legal.find(action => action.type === 'takeTokens')! };
    expect((await b.timeout(2000).emitWithAck('move', command)).ok).toBe(false);
    expect((await a.timeout(2000).emitWithAck('move', { ...command, revision: 99 })).ok).toBe(false);
    expect((await a.timeout(2000).emitWithAck('move', { ...command, seat: 1 } as MoveCommand)).ok).toBe(false);
    expect((await a.timeout(2000).emitWithAck('move', { ...command, action: { type: 'takeTokens', indices: [99] } })).ok).toBe(false);
    expect(value(await a.timeout(2000).emitWithAck('move', command)).view.revision).toBe(1);
    expect(value(await a.timeout(2000).emitWithAck('move', command)).view.revision).toBe(1);
    expect((await a.timeout(2000).emitWithAck('move', { ...command, action: { type: 'refill' } })).ok).toBe(false);
    expect(app.store.room(first.code).game.revision).toBe(1);
    expect((await a.timeout(2000).emitWithAck('replay')).ok).toBe(false);
  });

  it('never sends hidden decks, RNG, opponent blind cards or opponent legal actions', async () => {
    const { app, url } = await start(); const { a, b, first } = await pair(url);
    const messages: string[] = []; b.on('state', state => messages.push(JSON.stringify(state)));
    const current = value(await a.timeout(2000).emitWithAck('sync'));
    const action = current.legal.find(action => action.type === 'reserve' && action.source.kind === 'deck')!;
    const own = value(await a.timeout(2000).emitWithAck('move', { id: randomUUID(), revision: 0, action }));
    const opponent = value(await b.timeout(2000).emitWithAck('sync'));
    const hidden = app.store.room(first.code).game.players[current.seat].reserved[0];
    expect(own.view.players[current.seat].reserved).toEqual([hidden]);
    expect(opponent.view.players[current.seat].reserved).toEqual([null]);
    expect(JSON.stringify(opponent)).not.toContain(hidden);
    for (const wire of messages) expect(wire).not.toContain(hidden);
    for (const key of ['rng', 'seed', 'decks', 'bag', 'effects']) expect(opponent.view).not.toHaveProperty(key);
    expect(own.legal).toEqual([]);
    expect(validateState(app.store.room(first.code).game)).toEqual([]);
  });

  it('recovers after server restart and a lost acknowledgement without repeating the move', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'duel-online-')); folders.push(folder);
    const database = join(folder, 'room.sqlite');
    const firstServer = await start(database); const { a, secret, first } = await pair(firstServer.url);
    const current = value(await a.timeout(2000).emitWithAck('sync'));
    const command = { id: randomUUID(), revision: 0, action: current.legal.find(action => action.type === 'reserve' && action.source.kind === 'deck')! };
    value(await a.timeout(2000).emitWithAck('move', command));
    const expected = firstServer.app.store.room(first.code).game;
    expect(firstServer.app.store.room(first.code).host).not.toBe(secret);
    await firstServer.app.close(); apps.splice(apps.indexOf(firstServer.app), 1);
    const nextServer = await start(database); const restored = await connect(nextServer.url);
    const view = value(await restored.timeout(2000).emitWithAck('enter', { token: secret, code: first.code }));
    expect(view.view.revision).toBe(1); expect(view.seat).toBe(current.seat);
    expect(value(await restored.timeout(2000).emitWithAck('move', command)).view.revision).toBe(1);
    expect(nextServer.app.store.room(first.code).game).toEqual(expected);
    const replacement = await connect(nextServer.url);
    const disconnected = new Promise<void>(resolve => restored.once('disconnect', () => resolve()));
    value(await replacement.timeout(2000).emitWithAck('enter', { token: secret, code: first.code }));
    await disconnected; expect(restored.connected).toBe(false);
  });

  it('persists a complete game and releases its reproducible replay only after the terminal action', async () => {
    const { app, url } = await start(); const { a, first } = await pair(url);
    const started = performance.now(); let count = 0;
    for (; count < 600; count++) {
      const game = app.store.room(first.code).game;
      if (game.winner !== null) break;
      const action = chooseSimulationAction(game, () => .5) ?? getLegalActions(game)[0];
      app.store.move({ code: first.code, seat: game.turn }, { id: randomUUID(), revision: game.revision, action });
    }
    const game = app.store.room(first.code).game;
    expect(game.winner).not.toBeNull(); expect(validateState(game)).toEqual([]);
    const replay = value<string>(await a.timeout(2000).emitWithAck('replay'));
    const parsed = parseMatch(replay);
    expect(parsed?.game).toEqual(game); expect(parsed?.record.actions).toHaveLength(count);
    console.info(`Online full-match persistence: ${count} actions, ${Math.round(performance.now() - started)} ms, ${Buffer.byteLength(replay)} replay bytes`);
  }, 20000);

  it('caps room creation and expires abandoned rooms without touching recent matches', async () => {
    const { app } = await start(':memory:', { maxRooms: 2 });
    const one = app.store.enter(token()), two = app.store.enter(token());
    expect(() => app.store.enter(token())).toThrow('已满');
    app.store.enter(token(), two.code);
    app.store.prune(Date.now() + 2 * 86400000);
    expect(() => app.store.room(one.code)).toThrow('不存在');
    expect(app.store.room(two.code).guest).toBeTruthy();
  });

  it('rejects foreign browser origins', async () => {
    const { url } = await start();
    const client = io(url, { transports: ['websocket'], extraHeaders: { Origin: 'https://untrusted.example' }, reconnection: false }); clients.push(client);
    await new Promise<void>(resolve => client.once('connect_error', () => resolve()));
    expect(client.connected).toBe(false);
  });
});

class MemoryStorage implements Storage {
  private data = new Map<string,string>();
  get length() { return this.data.size; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw Error('Timed out waiting for client state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
it('browser client reload resends its persisted pending command and preserves the local save', async () => {
  const { app, url } = await start(); const { a, first, secret } = await pair(url);
  const current = value(await a.timeout(2000).emitWithAck('sync'));
  const pending = { id: randomUUID(), revision: 0, action: current.legal.find(action => action.type === 'takeTokens')! };
  value(await a.timeout(2000).emitWithAck('move', pending)); a.disconnect();
  const storage = new MemoryStorage();
  storage.setItem('local-match', 'untouched');
  storage.setItem('duel-online-seat-v1', JSON.stringify({ token: secret, code: first.code, pending }));
  let state: OnlineState | undefined;
  const owner = new OnlineClient(next => { state = next; }, storage, url); owners.push(owner);
  await until(() => state?.connected === true && !state.busy);
  expect(state?.snapshot?.view.revision).toBe(1);
  expect(app.store.room(first.code).game.revision).toBe(1);
  expect(JSON.parse(storage.getItem('duel-online-seat-v1')!).pending).toBeUndefined();
  expect(storage.getItem('local-match')).toBe('untouched');
  const peer = [...app.io.of('/').sockets.values()].find(peer => peer.data.seat?.seat === current.seat)!;
  peer.conn.close(); // Unexpected transport loss: the real client reconnects itself.
  await until(() => state?.connected === false);
  await until(() => state?.connected === true && !state.busy);
  expect(state?.snapshot?.view.revision).toBe(1);
  expect(app.store.room(first.code).game.revision).toBe(1);
});
