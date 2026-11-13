import { describe, expect, it } from 'vitest';
import { getJewel } from '../game/catalog';
import { applyAction, createGame, getDiscountedCost, getLegalActions, validateState } from '../game/engine';
import { COST_COLORS, LEVELS, type GameState, type GemColor } from '../game/types';
import { chooseSimulationAction, estimateWinProbability, positionSeed, randomizeFuture, runPlayout, summarizeEstimate } from './win-probability';

function detach(state: GameState, id: string) {
  for (const level of LEVELS) {
    state.decks[level] = state.decks[level].filter(card => card !== id);
    state.market[level] = state.market[level].map(card => card === id ? null : card);
  }
}

function winningPosition(owned: string[], target: string, claims = false) {
  const state = createGame('analysis-winning'); state.turn = 0;
  for (const id of owned) {
    detach(state, id); const card = getJewel(id);
    state.players[0].cards.push({ cardId: id, color: card.bonus?.color === 'choice' ? 'green' : card.bonus?.color ?? null });
  }
  if (claims) { state.players[0].royals = ['r1', 'r2']; state.players[0].royalClaims = [3, 6]; state.royals = ['r3', 'r4']; }
  const card = getJewel(target); detach(state, target);
  const previous = state.market[card.level][0]; if (previous) state.decks[card.level].push(previous);
  state.market[card.level][0] = target;
  const cost = getDiscountedCost(state, 0, target);
  for (const color of COST_COLORS) for (let i = 0; i < cost[color]; i++) {
    const index = state.board.indexOf(color); if (index < 0) throw new Error(`Insufficient real ${color} tokens in fixture`);
    state.board[index] = null; state.players[0].tokens[color]++;
  }
  expect(validateState(state)).toEqual([]);
  return state;
}

describe('Monte Carlo position evaluation', () => {
  it('randomizes future order independently of stored deck order, RNG and replay logs without changing the position', () => {
    const state = createGame('analysis-order');
    for (let index = 0; index < 5; index++) { state.bag.push(state.board[index]!); state.board[index] = null; }
    const original = structuredClone(state);
    const reordered = structuredClone(state);
    for (const level of LEVELS) reordered.decks[level].reverse();
    reordered.bag.reverse(); reordered.rng = 123; reordered.seed = 'future-seed'; reordered.log = ['future winner marker'];
    expect(positionSeed(state)).toBe(positionSeed(reordered));
    const first = randomizeFuture(state, 99); const second = randomizeFuture(reordered, 99);
    expect(first.decks).toEqual(second.decks); expect(first.bag).toEqual(second.bag); expect(first.rng).toBe(second.rng);
    expect(first.decks).not.toEqual(state.decks); expect(first.board).toEqual(state.board); expect(first.players).toEqual(state.players);
    expect(state).toEqual(original); expect(validateState(first)).toEqual([]);
  });

  it('reports only actual winners, exposes every truncated playout and gives terminal certainty', () => {
    const state = createGame('analysis-truncated');
    expect(estimateWinProbability(state, { samples: 4, maxActions: 1 })).toEqual({ probability: null, interval: [0, 1], wins: [0, 0], completed: 0, unfinished: 4, requested: 4, terminal: false });
    state.phase = 'gameOver'; state.winner = 1;
    expect(estimateWinProbability(state)).toEqual({ probability: 0, interval: [0, 0], wins: [0, 0], completed: 0, unfinished: 0, requested: 0, terminal: true });
    state.winner = 0; expect(estimateWinProbability(state).interval).toEqual([1, 1]);
  });

  it('keeps uncertainty at all-wins/all-losses and widens it for unfinished samples', () => {
    const state = createGame('analysis-interval');
    expect(summarizeEstimate(state, [24, 0], 0, 24).interval[0]).toBeLessThan(1);
    expect(summarizeEstimate(state, [0, 24], 0, 24).interval[1]).toBeGreaterThan(0);
    const complete = summarizeEstimate(state, [18, 6], 0, 24);
    const partial = summarizeEstimate(state, [18, 6], 8, 32);
    expect(partial.probability).toBe(.75);
    expect(partial.interval[0]).toBeLessThan(complete.interval[0]); expect(partial.interval[1]).toBeGreaterThan(complete.interval[1]);
  });

  it.each([
    ['prestige', ['j3-02', 'j3-04', 'j3-06', 'j3-08', 'j1-05'], 'j1-28', false],
    ['crowns', ['j3-12', 'j3-01', 'j3-03', 'j1-12'], 'j3-05', true],
    ['color', ['j3-02', 'j2-01', 'j1-05', 'j1-21', 'j1-16'], 'j3-01', false],
  ] as const)('takes a real immediate %s victory before resource gathering', (reason, owned, target, claims) => {
    let state = winningPosition([...owned], target, claims);
    const chosen = chooseSimulationAction(state, () => .5);
    expect(chosen?.type).toBe('buy');
    for (let i = 0; i < 8 && state.winner === null; i++) {
      const action = i === 0 ? chosen : chooseSimulationAction(state, () => .5);
      expect(action).not.toBeNull(); const result = applyAction(state, action!);
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error);
      state = result.state;
    }
    expect(state.winner).toBe(0); expect(state.victoryReasons).toContain(reason); expect(validateState(state)).toEqual([]);
  });

  it('uses owned same-color points for a copy card choice', () => {
    const state = createGame('analysis-copy');
    state.turn = 0;
    for (const [id, color] of [['j3-02', 'white'], ['j2-01', 'white'], ['j1-05', 'white'], ['j1-06', 'blue'], ['j3-11', null]] as const) {
      detach(state, id); state.players[0].cards.push({ cardId: id, color });
    }
    state.phase = 'effect'; state.effects = [{ kind: 'chooseColor', cardId: 'j3-11' }, { kind: 'replay', cardId: 'j3-11' }];
    state.pending = { kind: 'chooseColor', cardId: 'j3-11', colors: ['white', 'blue'] as GemColor[] };
    expect(chooseSimulationAction(state, () => .5)).toEqual({ type: 'chooseColor', color: 'white' });
  });

  it('keeps complete seeded policy games legal, including every pending choice and discard', () => {
    const pendingKinds = new Set<string>(); let actions = 0;
    for (let seed = 1; seed <= 4; seed++) {
      let state = randomizeFuture(createGame(`policy-${seed}`), seed); let rng = seed;
      const random = () => { rng = Math.imul(rng, 1664525) + 1013904223; return (rng >>> 0) / 4294967296; };
      for (let step = 0; step < 600 && state.winner === null; step++) {
        if (state.pending) pendingKinds.add(state.pending.kind);
        const action = chooseSimulationAction(state, random); expect(action).not.toBeNull();
        if (action!.type !== 'discard') expect(getLegalActions(state)).toContainEqual(action);
        const result = applyAction(state, action!); expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        state = result.state; actions++; expect(validateState(state)).toEqual([]);
      }
      expect(state.winner).not.toBeNull();
    }
    expect(actions).toBeGreaterThan(100); expect(pendingKinds.has('discard')).toBe(true);
  }, 30000);

  it('finishes 24 opening-position playouts and is reproducible for the same sample seed', () => {
    const state = createGame('analysis-benchmark'); const started = performance.now();
    const estimate = estimateWinProbability(state);
    const elapsed = performance.now() - started;
    console.info(`analysis benchmark: 24 samples, ${estimate.completed} finished, ${estimate.unfinished} truncated, ${Math.round(elapsed)} ms`);
    expect(estimate.completed + estimate.unfinished).toBe(24); expect(estimate.completed).toBe(24);
    expect(estimate.probability).not.toBeNull();
    expect(runPlayout(state, 1347)).toEqual(runPlayout(state, 1347));
  }, 30000);

});
