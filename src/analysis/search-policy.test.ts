import { describe, expect, it, vi } from 'vitest';
import { getJewel } from '../game/catalog';
import { applyAction, createGame, getDiscountedCost, getLegalActions, validateState } from '../game/engine';
import { COST_COLORS, LEVELS, type GameState } from '../game/types';
import * as search from './search';
import { analysisRandom, chooseSearchAction, estimateSearchWinProbability, runSearchPlayout, searchLeafValue } from './search-policy';

function immediateWin(): GameState {
  const state = createGame('search-policy-terminal'); state.turn = 0;
  const detach = (id: string) => {
    for (const level of LEVELS) {
      state.decks[level] = state.decks[level].filter(card => card !== id);
      state.market[level] = state.market[level].map(card => card === id ? null : card);
    }
  };
  for (const id of ['j3-02', 'j3-04', 'j3-06', 'j3-08', 'j1-05']) {
    detach(id); const card = getJewel(id);
    state.players[0].cards.push({ cardId: id, color: card.bonus!.color as 'white' | 'blue' | 'green' | 'black' });
  }
  detach('j1-28'); state.players[0].reserved.push('j1-28');
  const cost = getDiscountedCost(state, 0, 'j1-28');
  for (const color of COST_COLORS) for (let i = 0; i < cost[color]; i++) {
    const index = state.board.indexOf(color);
    if (index < 0) throw new Error('Invalid token fixture');
    state.board[index] = null; state.players[0].tokens[color]++;
  }
  expect(validateState(state)).toEqual([]);
  return state;
}

describe('search policy integration and budgets', () => {
  it('produces deterministic legal choices and reproducible estimates without modifying input', () => {
    const state = createGame('search-policy-repro');
    const original = structuredClone(state);
    const first = chooseSearchAction(state, analysisRandom(19), { iterations: 4, seed: 13 });
    expect(first).toEqual(chooseSearchAction(state, analysisRandom(19), { iterations: 4, seed: 13 }));
    expect(applyAction(state, first!).ok).toBe(true);
    const options = { samples: 2, maxActions: 2, searchIterations: 2, seed: 23 };
    expect(estimateSearchWinProbability(state, options)).toEqual(estimateSearchWinProbability(state, options));
    expect(state).toEqual(original);
  });

  it('counts real completed wins and never converts a heuristic cutoff into a winner', () => {
    const winning = immediateWin();
    const playout = runSearchPlayout(winning, 37, 2, 1);
    expect(playout).toEqual({ winner: 0, actions: 1 });
    expect(estimateSearchWinProbability(winning, { samples: 3, maxActions: 2, searchIterations: 1 })).toMatchObject({
      probability: 1, wins: [3, 0], completed: 3, unfinished: 0, requested: 3, terminal: false,
    });
    const opening = createGame('search-policy-truncated');
    expect(estimateSearchWinProbability(opening, { samples: 2, maxActions: 1, searchIterations: 1 })).toMatchObject({
      probability: null, wins: [0, 0], completed: 0, unfinished: 2, requested: 2, interval: [0, 1],
    });
    const action = getLegalActions(winning).find(candidate => candidate.type === 'buy' && candidate.source.kind === 'reserve')!;
    const result = applyAction(winning, action);
    if (!result.ok) throw new Error(result.error);
    expect(estimateSearchWinProbability(result.state)).toMatchObject({ probability: 1, terminal: true, completed: 0, requested: 0 });
    expect(chooseSearchAction(result.state, analysisRandom(2))).toBeNull();
    expect(searchLeafValue(result.state)).toBe(1);
  });

  it.each([NaN, Infinity, -Infinity])('normalizes non-finite sample and continuation budgets (%s)', invalid => {
    const state = immediateWin();
    const original = structuredClone(state);
    expect(estimateSearchWinProbability(state, { samples: invalid, maxActions: invalid, searchIterations: invalid, seed: invalid })).toMatchObject({
      probability: 1, wins: [24, 0], requested: 24, completed: 24, unfinished: 0,
    });
    expect(runSearchPlayout(state, invalid, invalid, invalid)).toEqual({ winner: 0, actions: 1 });
    expect(state).toEqual(original);
  });

  it('clamps negative/fractional budgets and passes finite bounded search iterations to MCTS', () => {
    const opening = createGame('search-policy-options');
    expect(estimateSearchWinProbability(opening, { samples: -5, maxActions: -8, searchIterations: -2 })).toMatchObject({ requested: 1, completed: 0, unfinished: 1 });
    expect(estimateSearchWinProbability(opening, { samples: 2.9, maxActions: 1.9, searchIterations: 1.9 })).toMatchObject({ requested: 2, completed: 0, unfinished: 2 });
    const spy = vi.spyOn(search, 'searchMcts');
    try {
      for (const [value, expected] of [[NaN, 24], [Infinity, 24], [-Infinity, 24], [-5, 1], [2.9, 2], [10000, 256]]) {
        const action = chooseSearchAction(opening, analysisRandom(9), { iterations: value, seed: Infinity });
        expect(applyAction(opening, action!).ok).toBe(true);
        expect(spy.mock.calls.at(-1)?.[1].iterations).toBe(expected);
        expect(Number.isFinite(spy.mock.calls.at(-1)?.[1].seed)).toBe(true);
      }
    } finally { spy.mockRestore(); }
  });

  it('replaces non-finite random seeds reproducibly instead of entering the all-zero generator state', () => {
    for (const seed of [NaN, Infinity, -Infinity]) {
      const random = analysisRandom(seed), reference = analysisRandom(0x5eeda11);
      const values = Array.from({ length: 8 }, () => random());
      expect(values).toEqual(Array.from({ length: 8 }, () => reference()));
      expect(new Set(values).size).toBe(8);
      expect(values.every(value => value > 0 && value < 1)).toBe(true);
    }
  });
});
