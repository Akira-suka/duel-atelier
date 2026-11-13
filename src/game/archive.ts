import { parseMatch, serializeMatch, type MatchRecord } from './match';
import type { SavedAnalysis, SavedPoint } from './analysis-save';
import type { GameState } from './types';

export const ARCHIVE_KEY = 'duel-atelier.completed.v1';
export const MAX_ARCHIVED_MATCHES = 5;
export const MAX_ARCHIVE_BYTES = 1_500_000;
export interface ArchiveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface ArchivedMatch { id: string; savedAt: number; record: MatchRecord; game: GameState }
interface StoredMatch { savedAt: number; save: string }
const bytes = (text: string) => new TextEncoder().encode(text).length;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const identity = (record: MatchRecord) => canonical({ initial: record.initial, actions: record.actions });
function idFor(key: string) {
  let first = 2166136261, second = 0x9e3779b9;
  for (const character of key) {
    first = Math.imul(first ^ character.charCodeAt(0), 16777619);
    second = Math.imul(second ^ character.charCodeAt(0), 0x85ebca6b);
  }
  return [first, second].map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

function read(storage: ArchiveStorage): ArchivedMatch[] {
  const text = storage.getItem(ARCHIVE_KEY);
  if (!text || text.length > MAX_ARCHIVE_BYTES || bytes(text) > MAX_ARCHIVE_BYTES) return [];
  let value: unknown;
  try { value = JSON.parse(text); } catch { return []; }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.matches) || value.matches.length > MAX_ARCHIVED_MATCHES) return [];
  const matches: ArchivedMatch[] = [];
  const seen = new Set<string>();
  for (const item of [...value.matches].sort((a, b) => (object(b) && timestamp(b.savedAt) ? b.savedAt : -1) - (object(a) && timestamp(a.savedAt) ? a.savedAt : -1))) {
    if (!object(item) || !timestamp(item.savedAt) || typeof item.save !== 'string') continue;
    const restored = parseMatch(item.save);
    if (!restored || restored.game.winner === null || restored.game.phase !== 'gameOver') continue;
    const key = identity(restored.record);
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ id: idFor(key), savedAt: item.savedAt, ...restored });
  }
  return matches;
}

/** Reads this application's one archive key only. Storage failure never blocks play. */
export function listArchivedMatches(storage: ArchiveStorage): ArchivedMatch[] {
  try { return read(storage); } catch { return []; }
}

/** A stale UI snapshot must not overwrite samples already saved by another view. */
function mergeAnalysis(incoming: SavedAnalysis | undefined, previous: SavedAnalysis | undefined): SavedAnalysis | undefined {
  if (!incoming) return previous;
  if (!previous) return incoming;
  const merged: SavedAnalysis = { version: 1, policies: { ...incoming.policies }, points: { baseline: [], search: [] } };
  const total = (point: SavedPoint) => point[2] + point[3] + point[4];
  for (const method of ['baseline', 'search'] as const) {
    if (incoming.policies[method] !== previous.policies[method]) {
      merged.points[method] = incoming.points[method].map((point): SavedPoint => [...point]);
      continue;
    }
    const points = new Map(previous.points[method].map(point => [point[0], [...point] as SavedPoint]));
    for (const point of incoming.points[method]) {
      const old = points.get(point[0]);
      if (old && old[1] === point[1]) {
        const selected: SavedPoint = [...(total(old) > total(point) ? old : point)];
        selected[5] = Math.max(old[5], point[5]) as 24 | 64;
        points.set(point[0], selected);
      } else points.set(point[0], [...point]);
    }
    merged.points[method] = [...points.values()].sort((a, b) => a[0] - b[0]);
  }
  return merged;
}

/** Atomically replaces the archive only after validating and fitting the new completed game. */
export function archiveMatch(storage: ArchiveStorage, record: MatchRecord, now = Date.now()): boolean {
  try {
    if (!timestamp(now)) return false;
    const save = serializeMatch(record);
    const restored = parseMatch(save);
    if (!restored || restored.game.winner === null || restored.game.phase !== 'gameOver') return false;
    const key = identity(restored.record);
    const encode = (matches: StoredMatch[]) => JSON.stringify({ version: 1, matches });
    const existing = read(storage);
    const same = existing.find(item => identity(item.record) === key);
    const analysis = mergeAnalysis(restored.record.analysis, same?.record.analysis);
    const current = { savedAt: same?.savedAt ?? now, save: serializeMatch({ ...restored.record, ...(analysis ? { analysis } : {}) }) };
    if (bytes(encode([current])) > MAX_ARCHIVE_BYTES) return false;
    // Equality uses complete canonical game content, never just the short display ID.
    const previous = existing.filter(item => identity(item.record) !== key)
      .map(item => ({ savedAt: item.savedAt, save: serializeMatch(item.record) }));
    const matches = [current, ...previous].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_ARCHIVED_MATCHES);
    while (matches.length > 1 && bytes(encode(matches)) > MAX_ARCHIVE_BYTES) matches.pop();
    if (!matches.includes(current)) return false;
    storage.setItem(ARCHIVE_KEY, encode(matches));
    return true;
  } catch { return false; }
}
