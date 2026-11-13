import { applyAction, parseSave } from './engine';
import { COST_COLORS, GEM_COLORS, TOKEN_COLORS, type Action, type GameState } from './types';

export const MATCH_FORMAT = 'splendor-duel-match';
export const MAX_MATCH_ACTIONS = 5000;
export const MAX_MATCH_BYTES = 2_000_000;

export interface MatchRecord {
  version: 1;
  initial: GameState;
  actions: Action[];
}

export interface LoadedMatch {
  record: MatchRecord;
  game: GameState;
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const keys = (value: ObjectValue, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const member = (value: unknown, values: readonly string[]) => typeof value === 'string' && values.includes(value);

function source(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === 'reserve') return keys(value, ['kind', 'index']) && integer(value.index, 2);
  if (!integer(value.level, 3) || value.level < 1) return false;
  if (value.kind === 'deck') return keys(value, ['kind', 'level']);
  return value.kind === 'market' && keys(value, ['kind', 'level', 'index']) && integer(value.index, 4);
}

function wallet(value: unknown): boolean {
  return object(value) && keys(value, [...TOKEN_COLORS]) && TOKEN_COLORS.every(color => integer(value[color], 25));
}

/** Check untrusted JSON before allowing it to reach the typed rules engine. */
function action(value: unknown): value is Action {
  if (!object(value)) return false;
  switch (value.type) {
    case 'refill': return keys(value, ['type']);
    case 'usePrivilege':
    case 'takeBonusToken': return keys(value, ['type', 'index']) && integer(value.index, 24);
    case 'takeTokens': return keys(value, ['type', 'indices']) && Array.isArray(value.indices)
      && value.indices.length >= 1 && value.indices.length <= 3
      && value.indices.every(index => integer(index, 24)) && new Set(value.indices).size === value.indices.length;
    case 'reserve': return keys(value, ['type', 'goldIndex', 'source']) && integer(value.goldIndex, 24) && source(value.source);
    case 'buy': return keys(value, ['type', 'source'], ['payment']) && source(value.source)
      && (!Object.hasOwn(value, 'payment') || wallet(value.payment));
    case 'chooseColor': return keys(value, ['type', 'color']) && member(value.color, GEM_COLORS);
    case 'stealToken': return keys(value, ['type', 'color']) && member(value.color, COST_COLORS);
    case 'chooseRoyal': return keys(value, ['type', 'cardId']) && typeof value.cardId === 'string' && /^r[1-4]$/.test(value.cardId);
    case 'discard': return keys(value, ['type', 'tokens']) && wallet(value.tokens);
    default: return false;
  }
}

function initialState(value: unknown): GameState {
  const initial = parseSave(JSON.stringify(value));
  if (!initial) throw new Error('对局记录的初始局面无效。');
  // Every saved record must leave room for its maximum permitted continuation.
  const counterLimit = Number.MAX_SAFE_INTEGER - MAX_MATCH_ACTIONS;
  if (initial.revision > counterLimit || initial.turnNumber > counterLimit) {
    throw new Error('对局记录的步骤或回合计数没有足够的安全余量。');
  }
  return initial;
}

function recordShape(value: unknown): asserts value is MatchRecord {
  if (!object(value) || !keys(value, ['version', 'initial', 'actions']) || value.version !== 1
    || !Array.isArray(value.actions) || value.actions.length > MAX_MATCH_ACTIONS || !value.actions.every(action)) {
    throw new Error('对局记录格式无效或动作数量超过上限。');
  }
}

/** A legacy mid-game save starts here; earlier actions are never invented. */
export function createMatch(initial: GameState): MatchRecord {
  return { version: 1, initial: initialState(initial), actions: [] };
}

function reconstruct(record: MatchRecord, snapshots?: GameState[]): GameState {
  recordShape(record);
  let game = initialState(record.initial);
  snapshots?.push(game);
  for (const [index, command] of record.actions.entries()) {
    const result = applyAction(game, command);
    if (!result.ok) throw new Error(`对局记录第 ${index + 1} 步无效：${result.error}`);
    game = result.state;
    if (!Number.isSafeInteger(game.revision) || !Number.isSafeInteger(game.turnNumber)) {
      throw new Error('对局记录的步骤或回合计数溢出。');
    }
    snapshots?.push(game);
  }
  return game;
}

/** Includes the initial snapshot at index 0; throws for an invalid sequence. */
export function replayMatch(record: MatchRecord): GameState[] {
  const snapshots: GameState[] = [];
  reconstruct(record, snapshots);
  return snapshots;
}

/** The caller records only successful applyAction transitions; saving does not replay. */
export function serializeMatch(record: MatchRecord): string {
  recordShape(record);
  const text = JSON.stringify({ format: MATCH_FORMAT, ...record, actionCount: record.actions.length });
  if (text.length > MAX_MATCH_BYTES || new TextEncoder().encode(text).length > MAX_MATCH_BYTES) {
    throw new Error('对局记录超过存档大小上限。');
  }
  return text;
}

export function parseMatch(text: string): LoadedMatch | null {
  if (typeof text !== 'string' || text.length > MAX_MATCH_BYTES || new TextEncoder().encode(text).length > MAX_MATCH_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value)) return null;
    if (!Object.hasOwn(value, 'format')) {
      const game = parseSave(text);
      return game ? { record: createMatch(game), game } : null;
    }
    if (value.format !== MATCH_FORMAT || !keys(value, ['format', 'version', 'initial', 'actions', 'actionCount'])
      || !integer(value.actionCount, MAX_MATCH_ACTIONS) || !Array.isArray(value.actions)
      || value.actionCount !== value.actions.length) return null;
    const record = { version: value.version, initial: value.initial, actions: value.actions };
    recordShape(record);
    const game = reconstruct(record);
    return { record, game };
  } catch { return null; }
}
