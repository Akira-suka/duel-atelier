import { beforeAll, describe, expect, it } from 'vitest';
import { applyAction, createGame, getLegalActions, serializeGame } from './engine';
import {
  createMatch, MATCH_FORMAT, MAX_MATCH_ACTIONS, MAX_MATCH_BYTES,
  parseMatch, replayMatch, serializeMatch, type MatchRecord,
} from './match';
import type { Action, GameState } from './types';

function commit(game: GameState, action: Action): GameState {
  const result = applyAction(game, action);
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

function opening() {
  const game = createGame('match-opening', ['Asuka', 'Sinji']);
  const action = getLegalActions(game).find(action => action.type === 'takeTokens')!;
  return { game, action, record: { ...createMatch(game), actions: [action] } };
}

describe('match records', () => {
  let complete: MatchRecord;
  let snapshots: GameState[];

  beforeAll(() => {
    let game = createGame('simulation-1');
    complete = createMatch(game);
    snapshots = [game];
    let random = 1;
    const roll = () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return (random >>> 0) / 0x100000000;
    };
    for (let step = 0; step < 1200 && game.winner === null; step++) {
      const actions = getLegalActions(game);
      const buys = actions.filter(action => action.type === 'buy');
      const pool = buys.length > 0 && roll() < 0.9 ? buys : actions;
      const action = pool[Math.floor(roll() * pool.length)];
      if (!action) throw new Error('Simulation has no legal action.');
      complete.actions.push(action);
      game = commit(game, action);
      snapshots.push(game);
    }
    if (game.winner === null) throw new Error('Simulation failed to finish.');
  });

  it('owns its initial snapshot and rejects invalid initial states', () => {
    const game = createGame('initial-copy');
    const record = createMatch(game);
    game.players[0].name = 'Changed';
    expect(record.initial.players[0].name).toBe('玩家一');
    expect(record.actions).toEqual([]);
    expect(() => createMatch({ ...game, board: [] })).toThrow();
  });

  it('round-trips the exact live state and can append a subsequent action', () => {
    const { game, action, record } = opening();
    const loaded = parseMatch(serializeMatch(record));
    expect(loaded?.record).toEqual(record);
    expect(loaded?.game).toEqual(commit(game, action));
    const nextAction = getLegalActions(loaded!.game)[0];
    const continued = { ...loaded!.record, actions: [...loaded!.record.actions, nextAction] };
    expect(parseMatch(serializeMatch(continued))?.game).toEqual(commit(loaded!.game, nextAction));
  });

  it('replays every recorded transition through a real completed game', () => {
    const before = structuredClone(complete);
    const replay = replayMatch(complete);
    expect(replay).toEqual(snapshots);
    expect(replay.length).toBe(complete.actions.length + 1);
    expect(replay.at(-1)?.phase).toBe('gameOver');
    expect(replay.at(-1)?.winner).not.toBeNull();
    expect(parseMatch(serializeMatch(complete))?.game).toEqual(snapshots.at(-1));
    expect(complete).toEqual(before);
    replay[0].players[0].name = 'Only this replay snapshot';
    expect(replay[1].players[0].name).not.toBe('Only this replay snapshot');
    expect(complete).toEqual(before);
  });

  it('preserves intermediate effect snapshots when saving and resuming', () => {
    const kinds = new Set<string>();
    for (const [index, game] of snapshots.entries()) {
      if (!game.pending || kinds.has(game.pending.kind)) continue;
      kinds.add(game.pending.kind);
      const prefix = { ...complete, actions: complete.actions.slice(0, index) };
      const loaded = parseMatch(serializeMatch(prefix));
      expect(loaded?.game).toEqual(game);
      const next = complete.actions[index];
      expect(next).toBeDefined();
      expect(commit(loaded!.game, next)).toEqual(snapshots[index + 1]);
    }
    expect([...kinds].some(kind => kind !== 'discard')).toBe(true);
  });

  it('records mandatory discards as their own resumable transition', () => {
    let game = createGame('match-discard');
    const record = createMatch(game);
    for (let step = 0; step < 40 && game.pending?.kind !== 'discard'; step++) {
      const legal = getLegalActions(game);
      const takes = legal.filter(action => action.type === 'takeTokens').sort((a, b) => b.indices.length - a.indices.length);
      const action = takes[0] ?? legal.find(action => action.type === 'refill') ?? legal[0];
      record.actions.push(action);
      game = commit(game, action);
    }
    expect(game.pending?.kind).toBe('discard');
    const loaded = parseMatch(serializeMatch(record));
    expect(loaded?.game).toEqual(game);
    const discard = getLegalActions(game)[0];
    expect(discard.type).toBe('discard');
    const next = commit(game, discard);
    record.actions.push(discard);
    expect(parseMatch(serializeMatch(record))?.game).toEqual(next);
    expect(replayMatch(record).at(-2)).toEqual(game);
    expect(replayMatch(record).at(-1)).toEqual(next);
  });

  it('imports legacy state as an honest partial record starting at that revision', () => {
    const index = Math.floor(snapshots.length / 2);
    const game = snapshots[index];
    const loaded = parseMatch(serializeGame(game));
    expect(loaded).toEqual({ record: { version: 1, initial: game, actions: [] }, game });
    expect(loaded!.record.initial.revision).toBeGreaterThan(0);
    expect(replayMatch(loaded!.record)).toEqual([game]);
    const next = complete.actions[index];
    const continued = { ...loaded!.record, actions: [next] };
    expect(parseMatch(serializeMatch(continued))?.game).toEqual(snapshots[index + 1]);
  });

  it('rejects illegal, repeated or post-victory actions without changing inputs', () => {
    const { record, action } = opening();
    const repeated = { ...record, actions: [action, action] };
    const before = structuredClone(repeated);
    expect(parseMatch(serializeMatch(repeated))).toBeNull();
    expect(() => replayMatch(repeated)).toThrow(/第 2 步/);
    expect(repeated).toEqual(before);
    const afterVictory: MatchRecord = { ...complete, actions: [...complete.actions, { type: 'refill' }] };
    expect(parseMatch(serializeMatch(afterVictory))).toBeNull();
  });

  it('rejects truncated JSON and intact JSON whose action sequence was shortened', () => {
    const text = serializeMatch(opening().record);
    expect(parseMatch(text.slice(0, -1))).toBeNull();
    const envelope = JSON.parse(text);
    envelope.actions.pop();
    expect(parseMatch(JSON.stringify(envelope))).toBeNull();
    delete envelope.actionCount;
    expect(parseMatch(JSON.stringify(envelope))).toBeNull();
  });

  it.each([
    null,
    { type: 'unknown' },
    { type: 'refill', hidden: true },
    { type: 'takeTokens', indices: [] },
    { type: 'takeTokens', indices: [0, 0] },
    { type: 'takeTokens', indices: [0, 1, 2, 3] },
    { type: 'takeTokens', indices: ['0'] },
    { type: 'usePrivilege', index: 1.5 },
    { type: 'takeBonusToken', index: 25 },
    { type: 'reserve', goldIndex: 0, source: { kind: 'deck', level: 4 } },
    { type: 'buy', source: { kind: 'reserve', index: 3 } },
    { type: 'buy', source: { kind: 'market', index: 0, level: 1 }, payment: {} },
    { type: 'chooseColor', color: 'gold' },
    { type: 'stealToken', color: 'gold' },
    { type: 'chooseRoyal', cardId: 'r5' },
    { type: 'discard', tokens: { white: -1 } },
  ])('rejects malformed action JSON: %j', invalid => {
    const envelope = JSON.parse(serializeMatch(createMatch(createGame('invalid-shape'))));
    envelope.actions = [invalid];
    envelope.actionCount = 1;
    expect(parseMatch(JSON.stringify(envelope))).toBeNull();
  });

  it('rejects unsupported formats, versions and damaged initial states', () => {
    const envelope = JSON.parse(serializeMatch(opening().record));
    expect(envelope.format).toBe(MATCH_FORMAT);
    expect(parseMatch(JSON.stringify({ ...envelope, format: 'another-game' }))).toBeNull();
    expect(parseMatch(JSON.stringify({ ...envelope, version: 2 }))).toBeNull();
    expect(parseMatch(JSON.stringify({ ...envelope, initial: {} }))).toBeNull();
    expect(parseMatch(JSON.stringify({ ...envelope, actions: {} }))).toBeNull();
    expect(parseMatch(JSON.stringify({ ...envelope, actionCount: -1 }))).toBeNull();
    expect(parseMatch('null')).toBeNull();
    expect(parseMatch('[]')).toBeNull();
  });

  it('enforces the action count and encoded byte limits before replay', () => {
    const record = createMatch(createGame('limits'));
    record.actions = Array.from({ length: MAX_MATCH_ACTIONS }, () => ({ type: 'refill' }));
    expect(() => serializeMatch(record)).not.toThrow();
    record.actions.push({ type: 'refill' });
    expect(() => serializeMatch(record)).toThrow(/上限/);
    expect(() => replayMatch(record)).toThrow(/上限/);
    expect(parseMatch(JSON.stringify({ format: MATCH_FORMAT, ...record, actionCount: record.actions.length }))).toBeNull();
    expect(parseMatch(' '.repeat(MAX_MATCH_BYTES + 1))).toBeNull();
    const unicode = createMatch(createGame('unicode-bytes'));
    unicode.initial.seed = '你'.repeat(Math.floor(MAX_MATCH_BYTES / 3));
    expect(() => serializeMatch(unicode)).toThrow(/大小上限/);
  });

  it.each(['revision', 'turnNumber'] as const)('reserves safe continuation space for %s in legacy and recorded saves', counter => {
    const game = createGame(`counter-${counter}`);
    const limit = Number.MAX_SAFE_INTEGER - MAX_MATCH_ACTIONS;
    game[counter] = limit;
    const record = createMatch(game);
    const action = getLegalActions(game).find(action => action.type === 'takeTokens')!;
    record.actions.push(action);
    const loaded = parseMatch(serializeMatch(record));
    expect(loaded?.game).toEqual(commit(game, action));
    expect(Number.isSafeInteger(loaded!.game.revision)).toBe(true);
    expect(Number.isSafeInteger(loaded!.game.turnNumber)).toBe(true);
    expect(parseMatch(serializeGame(game))?.record.initial[counter]).toBe(limit);

    for (const unsafeInitial of [limit + 1, Number.MAX_SAFE_INTEGER]) {
      const invalid = structuredClone(game);
      invalid[counter] = unsafeInitial;
      expect(() => createMatch(invalid)).toThrow(/安全余量/);
      expect(parseMatch(serializeGame(invalid))).toBeNull();
      const sequence = { ...record, initial: invalid };
      expect(parseMatch(serializeMatch(sequence))).toBeNull();
      expect(() => replayMatch(sequence)).toThrow(/安全余量/);
    }
  });
});
