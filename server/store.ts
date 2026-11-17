import { createHash, randomBytes, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyAction, createGame } from '../src/game/engine';
import { MAX_MATCH_ACTIONS, serializeMatch } from '../src/game/match';
import type { GameState, PlayerId } from '../src/game/types';
import type { MoveCommand } from '../src/online/protocol';

export type Seat = { code: string; seat: PlayerId };
type RoomRow = { code: string; initial: string; state: string; host: string; guest: string | null; updated: number };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Single-process SQLite transactions: persist before acknowledging, no full games retained in RAM. */
export class RoomStore {
  readonly db: DatabaseSync;
  constructor(path: string, private readonly maxRooms = 200) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      PRAGMA cache_size=-4096; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY, initial TEXT NOT NULL, state TEXT NOT NULL,
        host TEXT UNIQUE NOT NULL, guest TEXT UNIQUE, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (
        code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        seat INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        revision INTEGER NOT NULL, action TEXT NOT NULL, PRIMARY KEY(code,seat,id));
      CREATE INDEX IF NOT EXISTS commands_order ON commands(code,revision);`);
  }
  close() { this.db.close(); }
  room(code: string) {
    const row = this.db.prepare('SELECT * FROM rooms WHERE code=?').get(code) as RoomRow | undefined;
    if (!row) throw Error('房间不存在或已过期');
    return { ...row, game: JSON.parse(row.state) as GameState };
  }
  enter(token: string, code?: string): Seat {
    const digest = hash(token);
    const existing = this.db.prepare('SELECT code,host FROM rooms WHERE host=? OR guest=?').get(digest, digest) as { code: string; host: string } | undefined;
    if (existing) {
      if (code && existing.code !== code) throw Error('重连凭证与房间不匹配');
      return { code: existing.code, seat: existing.host === digest ? 0 : 1 };
    }
    if (code) {
      const room = this.room(code);
      if (room.guest) throw Error('房间已满，请使用原有重连凭证');
      this.db.prepare('UPDATE rooms SET guest=?,updated=? WHERE code=?').run(digest, Date.now(), code);
      return { code, seat: 1 };
    }
    const count = this.db.prepare('SELECT count(*) AS n FROM rooms').get() as { n: number };
    if (count.n >= this.maxRooms) throw Error('服务器房间已满，请稍后再试');
    let invite: string;
    do { invite = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
    while (this.db.prepare('SELECT 1 FROM rooms WHERE code=?').get(invite));
    const game = createGame(randomBytes(32).toString('hex'), ['Asuka', 'Sinji']);
    // Online hidden decks must not be recoverable from the engine's 32-bit setup RNG.
    // Store the shuffled initial snapshot so deterministic replay remains unchanged.
    for (const deck of Object.values(game.decks)) for (let i = deck.length - 1; i > 0; i--) {
      const j = randomInt(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    game.rng = randomInt(1, 0x100000000);
    const state = JSON.stringify(game);
    this.db.prepare('INSERT INTO rooms VALUES(?,?,?,?,?,?)').run(invite, state, state, digest, null, Date.now());
    return { code: invite, seat: 0 };
  }
  move(seat: Seat, command: MoveCommand) {
    const payload = JSON.stringify(command);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT payload FROM commands WHERE code=? AND seat=? AND id=?').get(seat.code, seat.seat, command.id) as { payload: string } | undefined;
      if (previous) {
        if (previous.payload !== payload) throw Error('重复请求的内容不一致');
        this.db.exec('COMMIT'); return;
      }
      const room = this.room(seat.code);
      if (!room.guest) throw Error('等待另一位玩家加入');
      if (room.game.turn !== seat.seat) throw Error('还没轮到你行动');
      if (room.game.revision !== command.revision) throw Error('局面已更新，请同步后重试');
      if (room.game.revision >= MAX_MATCH_ACTIONS) throw Error('本局达到行动数量上限');
      const next = applyAction(room.game, command.action);
      if (!next.ok) throw Error(next.error);
      this.db.prepare('UPDATE rooms SET state=?,updated=? WHERE code=?').run(JSON.stringify(next.state), Date.now(), seat.code);
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?,?)').run(seat.code, seat.seat, command.id, payload, next.state.revision, JSON.stringify(command.action));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  replay(seat: Seat) {
    const room = this.room(seat.code);
    if (room.game.winner === null) throw Error('对局结束后才能获取完整回放');
    const rows = this.db.prepare('SELECT action FROM commands WHERE code=? ORDER BY revision').all(seat.code) as { action: string }[];
    return serializeMatch({ version: 1, initial: JSON.parse(room.initial), actions: rows.map(row => JSON.parse(row.action)) });
  }
  prune(now = Date.now()) {
    // Waiting rooms: one day. Joined games: thirty days since the last committed action.
    this.db.prepare('DELETE FROM rooms WHERE updated < ? OR (guest IS NULL AND updated < ?)').run(now - 30 * 86400000, now - 86400000);
  }
}
