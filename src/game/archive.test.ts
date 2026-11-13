import { beforeAll, describe, expect, it } from 'vitest';
import { applyAction, createGame, getLegalActions } from './engine';
import type { SavedPoint } from './analysis-save';
import { chooseSimulationAction } from '../analysis/win-probability';
import { createMatch, serializeMatch, type MatchRecord } from './match';
import { archiveMatch, ARCHIVE_KEY, listArchivedMatches, MAX_ARCHIVE_BYTES, type ArchiveStorage } from './archive';

class MemoryStorage implements ArchiveStorage {
  data = new Map<string, string>();
  accessed: string[] = [];
  getItem(key: string) { this.accessed.push(key); return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.accessed.push(key); this.data.set(key, value); }
  removeItem(key: string) { this.accessed.push(key); this.data.delete(key); }
}

describe('completed-match archive', () => {
  let complete: MatchRecord;
  beforeAll(() => {
    let game = createGame('archive-completed'); complete = createMatch(game);
    for (let i = 0; game.winner === null && i < 600; i++) {
      const action = chooseSimulationAction(game, () => .5)!;
      const result = applyAction(game, action); if (!result.ok) throw Error(result.error);
      complete.actions.push(action); game = result.state;
    }
    if (game.winner === null) throw Error('Fixture did not finish');
  });

  it('archives completed records and updates their analysis without duplicating them', () => {
    const storage = new MemoryStorage();
    expect(archiveMatch(storage, complete, 100)).toBe(true);
    const id = listArchivedMatches(storage)[0].id;
    const updated = structuredClone(complete);
    updated.analysis = { version: 1, policies: { baseline: 'v1', search: 'v1' }, points: { baseline: [[0, '0123456789abcdef', 4, 4, 0, 24]], search: [] } };
    expect(archiveMatch(storage, updated, 200)).toBe(true);
    const records = listArchivedMatches(storage);
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ id, savedAt: 100, record: updated });
    expect(new Set(storage.accessed)).toEqual(new Set([ARCHIVE_KEY]));
  });

  it('merges compatible samples monotonically when an older view or cacheless snapshot saves later', () => {
    const storage = new MemoryStorage();
    const latest = structuredClone(complete);
    latest.analysis = { version: 1, policies: { baseline: 'v1', search: 'v1' }, points: {
      baseline: [[0, '0123456789abcdef', 40, 18, 2, 64], [1, '1111111111111111', 4, 4, 0, 24]],
      search: [[0, '0123456789abcdef', 3, 1, 0, 24]],
    } };
    expect(archiveMatch(storage, latest, 100)).toBe(true);
    const stale = structuredClone(complete);
    stale.analysis = { version: 1, policies: { baseline: 'v1', search: 'v1' }, points: {
      baseline: [[0, '0123456789abcdef', 3, 3, 0, 24]],
      search: [[0, '0123456789abcdef', 5, 3, 0, 64]],
    } };
    const original = structuredClone(stale);
    expect(archiveMatch(storage, stale, 200)).toBe(true);
    const merged = listArchivedMatches(storage)[0];
    expect(merged.savedAt).toBe(100);
    expect(merged.record.analysis?.points).toEqual({ baseline: latest.analysis.points.baseline, search: stale.analysis.points.search });
    expect(stale).toEqual(original);
    expect(archiveMatch(storage, complete, 300)).toBe(true);
    expect(listArchivedMatches(storage)[0]).toEqual(merged);
  });

  it('keeps a deeper target independently of counts and never merges across policies or position keys', () => {
    const storage = new MemoryStorage();
    const previous = structuredClone(complete);
    previous.analysis = { version: 1, policies: { baseline: 'v1', search: 'v1' }, points: {
      baseline: [[0, '0123456789abcdef', 4, 4, 0, 24], [1, '1111111111111111', 8, 8, 0, 64]],
      search: [[0, '0123456789abcdef', 40, 20, 0, 64]],
    } };
    expect(archiveMatch(storage, previous, 10)).toBe(true);
    const incoming = structuredClone(complete);
    incoming.analysis = { version: 1, policies: { baseline: 'v1', search: 'v2' }, points: {
      baseline: [[0, '0123456789abcdef', 1, 1, 0, 64], [1, '2222222222222222', 1, 0, 0, 24]],
      search: [[1, '1111111111111111', 1, 1, 0, 24]],
    } };
    expect(archiveMatch(storage, incoming, 20)).toBe(true);
    const archived = listArchivedMatches(storage)[0];
    expect(archived.savedAt).toBe(10);
    expect(archived.record.analysis).toEqual({ version: 1, policies: incoming.analysis.policies, points: {
      baseline: [[0, '0123456789abcdef', 4, 4, 0, 64], [1, '2222222222222222', 1, 0, 0, 24]],
      search: incoming.analysis.points.search,
    } });
  });

  it('retains the latest five distinct legal games and ignores property ordering in identity', () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < 7; i++) {
      const record = structuredClone(complete); record.initial.players[0].name = `Player ${i}`;
      expect(archiveMatch(storage, record, i)).toBe(true);
    }
    const recent = listArchivedMatches(storage);
    expect(recent.map(item => item.savedAt)).toEqual([6, 5, 4, 3, 2]);
    const reordered = { actions: recent[0].record.actions, initial: recent[0].record.initial, version: 1 as const };
    expect(archiveMatch(storage, reordered, 9)).toBe(true);
    expect(listArchivedMatches(storage).map(item => item.savedAt)).toEqual([6, 5, 4, 3, 2]);
    const oldest = recent.at(-1)!;
    expect(archiveMatch(storage, oldest.record, 1000)).toBe(true);
    expect(listArchivedMatches(storage).map(item => item.savedAt)).toEqual([6, 5, 4, 3, 2]);
  });

  it('does not archive unfinished games, invalid actions, or malformed timestamps', () => {
    const storage = new MemoryStorage();
    expect(archiveMatch(storage, createMatch(createGame('unfinished')), 1)).toBe(false);
    const broken = structuredClone(complete); broken.actions[0] = { type: 'chooseRoyal', cardId: 'r1' };
    expect(archiveMatch(storage, broken, 1)).toBe(false);
    expect(archiveMatch(storage, complete, NaN)).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it('ignores damaged/unsupported archive data and skips invalid entries beside valid ones', () => {
    const storage = new MemoryStorage();
    for (const text of ['invalid json', 'null', '{"version":2,"matches":[]}', ' '.repeat(MAX_ARCHIVE_BYTES + 1)]) {
      storage.data.set(ARCHIVE_KEY, text); expect(listArchivedMatches(storage)).toEqual([]);
    }
    storage.data.set(ARCHIVE_KEY, JSON.stringify({ version: 1, matches: [
      { savedAt: 1, save: 'bad save' }, { savedAt: 2, save: serializeMatch(complete) },
      { savedAt: 3, save: serializeMatch(createMatch(createGame('unfinished'))) },
    ] }));
    expect(listArchivedMatches(storage).map(item => item.savedAt)).toEqual([2]);
  });

  it('handles storage denial without throwing or deleting current records', () => {
    const storage = new MemoryStorage(); archiveMatch(storage, complete, 1);
    const previous = storage.data.get(ARCHIVE_KEY);
    storage.setItem = () => { throw Error('Quota exceeded'); };
    expect(archiveMatch(storage, complete, 2)).toBe(false);
    expect(storage.data.get(ARCHIVE_KEY)).toBe(previous);
    storage.getItem = () => { throw Error('Storage denied'); };
    expect(listArchivedMatches(storage)).toEqual([]); expect(archiveMatch(storage, complete, 2)).toBe(false);
  });

  it('rejects an oversized single archive item without replacing an existing archive', () => {
    const storage = new MemoryStorage(); archiveMatch(storage, complete, 1);
    const previous = storage.data.get(ARCHIVE_KEY);
    // An oversized invalid candidate must leave the valid archive intact.
    const huge = structuredClone(complete); huge.initial.seed = 'x'.repeat(MAX_ARCHIVE_BYTES);
    expect(archiveMatch(storage, huge, 2)).toBe(false);
    expect(storage.data.get(ARCHIVE_KEY)).toBe(previous);
    expect(new TextEncoder().encode(previous!).length).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
  });

  it('evicts older legal records when their combined encoded JSON exceeds the byte budget', () => {
    let game = createGame('archive-byte-budget');
    game.log = Array.from({ length: 120 }, () => '界'.repeat(500));
    const record = createMatch(game);
    for (let step = 0; step < 2100 && game.winner === null; step++) {
      const legal = getLegalActions(game);
      const action = step < 1500 ? legal.find(action => action.type === 'takeTokens') ?? legal.find(action => action.type === 'refill') ?? legal[0]
        : chooseSimulationAction(game, () => .5)!;
      const result = applyAction(game, action); if (!result.ok) throw Error(result.error);
      record.actions.push(action); game = result.state;
    }
    expect(game.winner).not.toBeNull();
    const points = Array.from({ length: record.actions.length + 1 }, (_, step): SavedPoint => [step, '0123456789abcdef', 8, 8, 8, 24]);
    record.analysis = { version: 1, policies: { baseline: 'v1', search: 'v1' }, points: { baseline: points, search: points } };
    const storage = new MemoryStorage();
    for (let i = 0; i < 5; i++) {
      record.initial.players[0].name = `Large ${i}`;
      expect(archiveMatch(storage, record, i)).toBe(true);
      expect(new TextEncoder().encode(storage.data.get(ARCHIVE_KEY)!).length).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    }
    const recent = listArchivedMatches(storage);
    expect(recent.length).toBeLessThan(5); expect(recent[0].savedAt).toBe(4);
  }, 30000);
});
