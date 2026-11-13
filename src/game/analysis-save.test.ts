import { describe, expect, it } from 'vitest';
import { createGame, serializeGame } from './engine';
import { parseSavedAnalysis, type SavedAnalysis } from './analysis-save';
import { createMatch, MAX_MATCH_BYTES, parseMatch, serializeMatch } from './match';

function cache(): SavedAnalysis {
  return { version: 1, policies: { baseline: 'baseline-v1', search: 'search-v1' }, points: {
    baseline: [[0, '0123456789abcdef', 8, 3, 1, 24]],
    search: [[0, '0123456789abcdef', 24, 12, 4, 64]],
  } };
}
function envelope(analysis: unknown) {
  return JSON.stringify({ ...JSON.parse(serializeMatch(createMatch(createGame('save-analysis')))), analysis });
}

describe('persisted analysis counts', () => {
  it('round-trips caches without changing v1 matches and preserves legacy state imports', () => {
    const state = createGame('save-analysis'); const plain = createMatch(state);
    expect(parseMatch(serializeMatch(plain))?.record).toEqual(plain);
    expect(parseMatch(serializeGame(state))?.record.analysis).toBeUndefined();
    const record = { ...plain, analysis: cache() };
    const encoded = serializeMatch(record);
    expect(parseMatch(encoded)).toEqual({ record, game: state });
    expect(encoded).not.toContain('probability'); expect(encoded).not.toContain('interval');
  });

  it('copies cache data, retains unknown policy IDs for estimator checks, and accepts zero/64 count boundaries', () => {
    const value = cache(); value.policies.search = 'future-search-v9';
    value.points.baseline[0] = [0, '0123456789abcdef', 0, 0, 0, 24];
    value.points.search[0] = [0, '0123456789abcdef', 63, 1, 0, 64];
    const result = parseSavedAnalysis(value, 0)!;
    expect(result).toEqual(value); result.points.search[0][2] = 0;
    expect(value.points.search[0][2]).toBe(63);
  });

  it.each([
    null, {}, { ...cache(), version: 2 }, { ...cache(), extra: true },
    { ...cache(), policies: { baseline: 'ok', search: '' } },
    { ...cache(), policies: { baseline: 'ok', search: 'x'.repeat(257) } },
    { ...cache(), points: { baseline: [], search: 'not-an-array' } },
    { ...cache(), points: { baseline: [cache().points.baseline[0], cache().points.baseline[0]], search: [] } },
    { ...cache(), points: { baseline: Array(5002).fill(cache().points.baseline[0]), search: [] } },
  ])('discards malformed metadata but still loads the legal match: %#', invalid => {
    const restored = parseMatch(envelope(invalid));
    expect(restored).not.toBeNull(); expect(restored!.record.analysis).toBeUndefined();
    expect(restored!.game.seed).toBe('save-analysis');
  });

  it.each([
    [1, '0123456789abcdef', 1, 0, 0, 24], [-1, '0123456789abcdef', 1, 0, 0, 24],
    [0, 'bad-key', 1, 0, 0, 24], [0, '0123456789abcdef', -1, 0, 0, 24],
    [0, '0123456789abcdef', 1.5, 0, 0, 24], [0, '0123456789abcdef', 1, 0, 0, 32],
    [0, '0123456789abcdef', 65, 0, 0, 64], [0, '0123456789abcdef', 12, 12, 1, 24],
    [0, '0123456789abcdef', 1, 0, 0, 24, 1],
  ].map(point => ({ point })))('drops invalid cached point without losing the match: %j', ({ point }) => {
    const invalid = { ...cache(), points: { baseline: [point], search: [] } };
    expect(parseSavedAnalysis(invalid, 0)).toBeUndefined();
    expect(parseMatch(envelope(invalid))?.record.analysis).toBeUndefined();
    expect(parseMatch(envelope(invalid))?.game.seed).toBe('save-analysis');
  });

  it('does not trust added probability fields and sanitizes invalid in-memory caches on export', () => {
    const invalid = { ...cache(), probability: 1, interval: [1, 1] };
    const record = { ...createMatch(createGame('sanitize-cache')), analysis: invalid };
    expect(parseMatch(serializeMatch(record))?.record.analysis).toBeUndefined();
    expect(parseSavedAnalysis(cache(), -1)).toBeUndefined();
    expect(parseSavedAnalysis(cache(), 5001)).toBeUndefined();
  });

  it('keeps the existing overall encoded-byte limit', () => {
    expect(parseMatch(' '.repeat(MAX_MATCH_BYTES + 1))).toBeNull();
    const record = { ...createMatch(createGame('analysis-size')), analysis: cache() };
    record.initial.seed = '你'.repeat(Math.floor(MAX_MATCH_BYTES / 3));
    expect(() => serializeMatch(record)).toThrow(/大小上限/);
  });
});
