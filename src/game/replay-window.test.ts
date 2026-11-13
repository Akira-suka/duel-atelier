import { describe, expect, it } from 'vitest';
import { chooseSimulationAction } from '../analysis/win-probability';
import { applyAction, createGame, getLegalActions } from './engine';
import { createMatch, MAX_MATCH_ACTIONS, replayMatch, type MatchRecord } from './match';
import { ReplayWindow } from './replay-window';
import type { Action, GameState } from './types';

function fixture(steps = 30) {
  let game = createGame('replay-window'); const record = createMatch(game); let seed = 17;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223; return (seed >>> 0) / 4294967296; };
  for (let step = 0; step < steps && game.winner === null; step++) {
    const action = chooseSimulationAction(game, random)!;
    const result = applyAction(game, action); if (!result.ok) throw new Error(result.error);
    record.actions.push(action); game = result.state;
  }
  return { record, game };
}
const withoutLog = (state: GameState) => ({ ...state, log: [] });

describe('bounded lazy replay', () => {
  it('matches full replay in forward and random order while keeping only four checkpoints', () => {
    const { record } = fixture(); const original = structuredClone(record);
    const expected = replayMatch(record); const window = new ReplayWindow(record);
    for (const step of [...expected.keys(), 2, 17, 0, 29, 8]) {
      const actual = window.get(step);
      expect(actual).toEqual(withoutLog(expected[step]));
      expect(window.cachedCount).toBeLessThanOrEqual(4);
      actual.players[0].name = 'changed by caller';
      expect(window.get(step)).toEqual(withoutLog(expected[step]));
    }
    expect(record).toEqual(original);
  });

  it('retains checkpoints on append, accepts a copied latest state, and resets on a new match', () => {
    const { record, game } = fixture();
    const partial = { ...record, actions: record.actions.slice(0, 10) };
    const window = new ReplayWindow(partial); window.get(5); window.get(10);
    expect(window.cachedCount).toBe(3);
    window.update(record, game); expect(window.cachedCount).toBe(4);
    game.players[0].name = 'changed after update';
    expect(window.get(record.actions.length)).toEqual(withoutLog(replayMatch(record).at(-1)!));
    const other = createMatch(createGame('other-match'));
    window.update(other); expect(window.cachedCount).toBe(1); expect(window.get(0)).toEqual(withoutLog(other.initial));
  });

  it('invalidates rewritten and truncated prefixes, including in-place action edits', () => {
    const initial = createMatch(createGame('rewritten')).initial;
    const choices = getLegalActions(initial).filter(action => action.type === 'takeTokens');
    const record: MatchRecord = { version: 1, initial, actions: [choices[0]] };
    const window = new ReplayWindow(record); const old = window.get(1);
    record.actions[0] = choices[1]; window.update(record);
    expect(window.cachedCount).toBe(1);
    expect(window.get(1)).toEqual(withoutLog(replayMatch(record)[1])); expect(window.get(1)).not.toEqual(old);
    record.actions.length = 0; window.update(record);
    expect(window.cachedCount).toBe(1); expect(() => window.get(1)).toThrow();
  });

  it('rejects bad indices, excessive records, invalid latest states and illegal actions atomically', () => {
    const { record, game } = fixture(2); const window = new ReplayWindow(record, 1);
    for (const index of [-1, 3, .5, NaN, Infinity]) expect(() => window.get(index)).toThrow();
    for (const capacity of [0, 5, NaN]) expect(() => new ReplayWindow(record, capacity)).toThrow();
    expect(() => window.update({ ...record, actions: Array(MAX_MATCH_ACTIONS + 1).fill({ type: 'refill' }) })).toThrow();
    expect(() => window.update(record, { ...game, revision: game.revision + 1 })).toThrow();
    expect(window.get(2)).toEqual(withoutLog(game)); expect(window.cachedCount).toBe(1);
    const bad = { ...record, actions: [{ type: 'takeTokens', indices: [-1] } as Action] };
    const original = structuredClone(bad); window.update(bad);
    expect(() => window.get(1)).toThrow('第 1 步无效'); expect(bad).toEqual(original);
  });
});
