/** Compact persisted counts. Probability and intervals are always recomputed on load. */
export type SavedPoint = [step: number, positionKey: string, wins0: number, wins1: number, unfinished: number, target: 24 | 64];
export interface SavedAnalysis {
  version: 1;
  policies: { baseline: string; search: string };
  points: { baseline: SavedPoint[]; search: SavedPoint[] };
}

const METHODS = ['baseline', 'search'] as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= max;

/** Bad or future-version cache is expendable; it must never invalidate a legal match. */
export function parseSavedAnalysis(value: unknown, maxStep: number): SavedAnalysis | undefined {
  if (!integer(maxStep, 5000) || !object(value) || !exact(value, ['version', 'policies', 'points']) || value.version !== 1
    || !object(value.policies) || !exact(value.policies, METHODS) || !object(value.points) || !exact(value.points, METHODS)) return undefined;
  const policies = {} as SavedAnalysis['policies'];
  const points = {} as SavedAnalysis['points'];
  for (const method of METHODS) {
    const policy = value.policies[method]; const rows = value.points[method];
    // Unknown policy identifiers are retained for the owning estimator to compare.
    if (typeof policy !== 'string' || policy.length < 1 || policy.length > 256 || !Array.isArray(rows) || rows.length > maxStep + 1) return undefined;
    policies[method] = policy;
    points[method] = [];
    const seen = new Set<number>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 6 || !integer(row[0], maxStep) || seen.has(row[0])
        || typeof row[1] !== 'string' || !/^[0-9a-f]{16}$/.test(row[1])
        || !integer(row[2], 64) || !integer(row[3], 64) || !integer(row[4], 64)
        || (row[5] !== 24 && row[5] !== 64) || row[2] + row[3] + row[4] > row[5]) return undefined;
      seen.add(row[0]); points[method].push([...row] as SavedPoint);
    }
  }
  return { version: 1, policies, points };
}
