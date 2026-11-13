import { describe, expect, it } from 'vitest';
import { getJewel } from '../game/catalog';
import { applyAction, createGame, getDiscountedCost, getLegalActions, getStats, validateState } from '../game/engine';
import { COST_COLORS, LEVELS, type Action, type GameState, type PlayerId } from '../game/types';
import { chooseSimulationAction } from './win-probability';
import { searchActionKey, searchMcts, searchPositionKey, type SearchHooks } from './search';

function detach(state: GameState, id: string) {
  for (const level of LEVELS) {
    state.decks[level] = state.decks[level].filter(card => card !== id);
    state.market[level] = state.market[level].map(card => card === id ? null : card);
  }
}

function winningReserve(player: PlayerId, withReplay = false): GameState {
  const state = createGame('mcts-tactics'); state.turn = player;
  for (const id of ['j3-02', 'j3-04', 'j3-06', 'j3-08', 'j1-05']) {
    detach(state, id); const card = getJewel(id);
    state.players[player].cards.push({ cardId: id, color: card.bonus!.color as 'white' | 'blue' | 'green' | 'black' });
  }
  for (const id of withReplay ? ['j1-28', 'j1-03'] : ['j1-28']) {
    detach(state, id); state.players[player].reserved.push(id);
    const cost = getDiscountedCost(state, player, id);
    for (const color of COST_COLORS) for (let i = 0; i < cost[color]; i++) {
      const index = state.board.indexOf(color);
      if (index < 0) throw new Error(`Fixture lacks ${color}`);
      state.board[index] = null; state.players[player].tokens[color]++;
    }
  }
  expect(validateState(state)).toEqual([]);
  return state;
}

const neutral: SearchHooks = { policy: () => null, cutoffValue: () => .5 };

describe('bounded stochastic MCTS', () => {
  it('is reproducible, leaves input untouched and never conditions decisions on stored future order', () => {
    const state = createGame('mcts-future');
    for (let i = 0; i < 4; i++) { state.bag.push(state.board[i]!); state.board[i] = null; }
    const original = structuredClone(state);
    const reordered = structuredClone(state);
    for (const level of LEVELS) reordered.decks[level].reverse();
    reordered.bag.reverse(); reordered.rng = 998877; reordered.seed = 'different-future';
    reordered.log = ['future winner']; reordered.revision += 20;
    expect(searchPositionKey(state)).toBe(searchPositionKey(reordered));
    const hooks = { policy: chooseSimulationAction };
    const options = { iterations: 16, treeDepth: 4, rolloutDepth: 5, seed: 7 };
    expect(searchMcts(state, options, hooks)).toEqual(searchMcts(reordered, options, hooks));
    expect(state).toEqual(original);
  });

  it('branches by revealed chance outcomes rather than selecting a favorable deck top', () => {
    const state = createGame('mcts-chance');
    const action: Action = { type: 'reserve', source: { kind: 'deck', level: 1 }, goldIndex: state.board.indexOf('gold') };
    const result = searchMcts(state, { iterations: 48, treeDepth: 2, rolloutDepth: 0, seed: 11 }, {
      ...neutral, actions: current => current.revision === state.revision ? [action] : getLegalActions(current),
    });
    expect(result.action).toEqual(action);
    expect(result.actions[0].outcomes).toBeGreaterThan(8);
    expect(result.nodes).toBeLessThanOrEqual(49);
    expect(result.terminalWins).toEqual([0, 0]);
    expect(result.cutoffs).toBe(48);
    expect(validateState(state)).toEqual([]);
  });

  it.each([0, 1] as const)('maximizes the actual player %s value and detects a terminal-winning purchase through search', player => {
    const state = winningReserve(player);
    const buy = getLegalActions(state).find(action => action.type === 'buy' && action.source.kind === 'reserve')!;
    const take = getLegalActions(state).find(action => action.type === 'takeTokens')!;
    const result = searchMcts(state, { iterations: 48, treeDepth: 1, rolloutDepth: 0, seed: 21 }, { ...neutral, actions: () => [buy, take] });
    expect(result.action).toEqual(buy);
    expect(result.terminalWins[player]).toBeGreaterThan(35);
    expect(result.terminalWins[1 - player]).toBe(0);
    expect(result.actions.find(candidate => candidate.action.type === 'buy')?.value).toBe(1);
    expect(result.provenWinner).toBeNull(); // Many wins are not a proof of the root position.
  });

  it('keeps the same objective through an extra turn instead of alternating value at every depth', () => {
    const state = winningReserve(1, true);
    const replay: Action = { type: 'buy', source: { kind: 'reserve', index: 1 } };
    const first = applyAction(state, replay);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(first.state.turn).toBe(1);
    expect(first.state.phase).toBe('start');
    expect(validateState(first.state)).toEqual([]);
    const result = searchMcts(state, { iterations: 128, treeDepth: 2, rolloutDepth: 0, seed: 5 }, {
      ...neutral,
      actions: current => {
        if (current.revision === state.revision) return [replay];
        const legal = getLegalActions(current);
        return [legal.find(action => action.type === 'buy' && action.source.kind === 'reserve')!, legal.find(action => action.type === 'takeTokens')!];
      },
    });
    expect(result.action).toEqual(replay);
    expect(result.terminalWins[1]).toBeGreaterThan(110);
    expect(result.terminalWins[0]).toBe(0);
  });

  it('keeps heuristic leaves separate from actual wins and exposes values rather than visit shares', () => {
    const state = createGame('mcts-cutoff');
    state.turn = 0;
    const result = searchMcts(state, { iterations: 12, treeDepth: 1, rolloutDepth: 0 }, { policy: () => null, cutoffValue: () => .73 });
    expect(result.iterations).toBe(12);
    expect(result.terminalWins).toEqual([0, 0]);
    expect(result.cutoffs).toBe(12);
    expect(result.actions.reduce((sum, action) => sum + action.visits, 0)).toBe(12);
    for (const action of result.actions.filter(candidate => candidate.visits)) {
      expect(action.value).toBeCloseTo(.73);
      expect(action.terminalWins).toEqual([0, 0]);
      expect(action.cutoffs).toBe(action.visits);
    }
  });

  it('only prunes proved losing actions, retains unknown moves and distinguishes proof from sampling', () => {
    const state = winningReserve(0);
    const legal = getLegalActions(state);
    const buy = legal.find(action => action.type === 'buy' && action.source.kind === 'reserve')!;
    const take = legal.find(action => action.type === 'takeTokens')!;
    const filtered = searchMcts(state, { iterations: 0 }, { ...neutral, actions: () => [take, buy], tactics: () => ({ losing: [take] }) });
    expect(filtered.action).toEqual(buy);
    expect(filtered.actions).toHaveLength(1);
    expect(filtered.provenWinner).toBeNull();
    const proved = searchMcts(state, {}, { ...neutral, tactics: () => ({ winning: buy }) });
    expect(proved.provenWinner).toBe(0);
    expect(proved.iterations).toBe(0);
    expect(proved.terminalWins).toEqual([0, 0]);
    const allUnknown = searchMcts(state, { iterations: 0 }, { ...neutral, actions: () => [take], tactics: () => ({ losing: [take] }) });
    expect(allUnknown.action).toEqual(take);
    expect(allUnknown.provenWinner).toBeNull();
  });

  it('preserves payment alternatives as separate actions and applies a bounded zero-time budget', () => {
    const state = winningReserve(0);
    const buy = getLegalActions(state).find(action => action.type === 'buy' && action.source.kind === 'reserve')!;
    if (buy.type !== 'buy' || !buy.payment) throw new Error('Expected explicit payment');
    const alternate: Action = { ...buy, payment: { ...buy.payment, red: buy.payment.red - 1, gold: 1 } };
    const gold = state.board.indexOf('gold'); state.board[gold] = null; state.players[0].tokens.gold++;
    expect(validateState(state)).toEqual([]);
    expect(applyAction(state, alternate).ok).toBe(true);
    expect(searchActionKey(buy)).not.toBe(searchActionKey(alternate));
    const result = searchMcts(state, { iterations: 96, maxMilliseconds: 0 }, { ...neutral, actions: () => [buy, alternate], prior: () => [0, 1] });
    expect(result.iterations).toBe(0);
    expect(result.action).toEqual(alternate);
    expect(result.actions).toHaveLength(2);
  });

  it('returns true terminal results without searching and keeps budgeted policy rollouts legal', () => {
    const state = winningReserve(1);
    const buy = getLegalActions(state).find(action => action.type === 'buy' && action.source.kind === 'reserve')!;
    const end = applyAction(state, buy);
    if (!end.ok) throw new Error(end.error);
    expect(getStats(end.state, 1).points).toBeGreaterThanOrEqual(20);
    expect(searchMcts(end.state, {}, neutral)).toMatchObject({ action: null, iterations: 0, provenWinner: 1 });
    const opening = createGame('mcts-budget');
    const result = searchMcts(opening, { iterations: 48, treeDepth: 6, rolloutDepth: 10, seed: 37 }, { policy: chooseSimulationAction });
    expect(result.iterations).toBe(48);
    expect(result.cutoffs + result.terminalWins[0] + result.terminalWins[1]).toBe(48);
    expect(applyAction(opening, result.action!).ok).toBe(true);
    expect(result.nodes).toBeLessThanOrEqual(49);
  }, 15000);
});
