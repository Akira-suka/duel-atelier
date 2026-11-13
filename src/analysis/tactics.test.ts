import { describe, expect, it } from 'vitest';
import { getJewel } from '../game/catalog';
import { applyAction, createGame, emptyWallet, getStats, validateState } from '../game/engine';
import { LEVELS, TOKEN_COLORS, type Action, type GameState, type GemColor, type PlayerId, type TokenColor, type Wallet } from '../game/types';
import { analyzeTactics, enumerateTacticalActions, findImmediateWin, tacticalActionKey } from './tactics';

function scene(): GameState {
  const state = createGame('tactical-independent-fixture');
  state.turn = 0; state.phase = 'main'; state.revision = 1;
  state.players[0].privileges = 0; state.players[1].privileges = 0; state.privilegeSupply = 3;
  for (const level of LEVELS) {
    for (const id of state.market[level]) if (id) state.decks[level].push(id);
    state.market[level].fill(null);
  }
  return state;
}
function detach(state: GameState, id: string) {
  for (const level of LEVELS) {
    state.decks[level] = state.decks[level].filter(value => value !== id);
    state.market[level] = state.market[level].map(value => value === id ? null : value);
  }
}
function own(state: GameState, ids: string[], player: PlayerId = 0, color: GemColor = 'white') {
  for (const id of ids) {
    detach(state, id); const card = getJewel(id);
    state.players[player].cards.push({ cardId: id, color: card.bonus?.color === 'choice' ? color : card.bonus?.color ?? null });
  }
}
function offer(state: GameState, id: string, index = 0) {
  detach(state, id); const card = getJewel(id);
  const old = state.market[card.level][index]; if (old) state.decks[card.level].push(old);
  state.market[card.level][index] = id;
}
function wallets(state: GameState, first: Partial<Wallet>, second: Partial<Wallet> = {}, bag: TokenColor[] = []) {
  const totals: Wallet = { white: 4, blue: 4, green: 4, red: 4, black: 4, pearl: 2, gold: 3 };
  state.players[0].tokens = { ...emptyWallet(), ...first };
  state.players[1].tokens = { ...emptyWallet(), ...second };
  state.bag = [...bag]; state.board.fill(null); let cell = 0;
  for (const color of TOKEN_COLORS) {
    const remaining = totals[color] - state.players[0].tokens[color] - state.players[1].tokens[color] - bag.filter(token => token === color).length;
    if (remaining < 0) throw new Error('Fixture manufactured tokens');
    for (let i = 0; i < remaining; i++) state.board[cell++] = color;
  }
}
function checked(state: GameState) { expect(validateState(state)).toEqual([]); return state; }
function playLine(state: GameState, line: Action[]) {
  for (const action of line) {
    const result = applyAction(state, action); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    state = result.state; checked(state);
  }
  return state;
}
function whiteNine(state: GameState, player: PlayerId = 0) {
  own(state, ['j3-02', 'j2-01', 'j2-03', 'j1-05'], player);
  expect(getStats(state, player).colorPoints.white).toBe(9);
}

describe('bounded tactical proofs', () => {
  it('proves a direct prestige victory without depending on market replacement or mutating input', () => {
    const state = scene(); own(state, ['j3-02', 'j3-04', 'j3-06', 'j3-08', 'j1-05']);
    offer(state, 'j1-28'); wallets(state, { red: 4, pearl: 1 }); checked(state);
    const original = structuredClone(state);
    const result = findImmediateWin(state, { maxNodes: 32 });
    expect(result.status).toBe('win'); expect(result.line).toHaveLength(1);
    expect(playLine(state, result.line).victoryReasons).toContain('prestige');
    expect(state).toEqual(original);
  });

  it('resolves a copy-color choice through the actual rule engine', () => {
    const state = scene(); whiteNine(state); offer(state, 'j1-26'); wallets(state, { black: 4, pearl: 1 }); checked(state);
    const result = findImmediateWin(state, { maxNodes: 40 });
    expect(result.status).toBe('win'); expect(result.line.at(-1)).toEqual({ type: 'chooseColor', color: 'white' });
    expect(playLine(state, result.line).victoryReasons).toContain('color');
  });

  it('chooses the winning royal after crossing the crown threshold', () => {
    const state = scene(); own(state, ['j3-02', 'j3-04', 'j3-06', 'j3-08', 'j1-05', 'j1-02', 'j1-07']);
    offer(state, 'j1-12'); wallets(state, { red: 3 }); checked(state);
    const result = findImmediateWin(state, { maxNodes: 32 });
    expect(result.status).toBe('win'); expect(result.line.at(-1)).toEqual({ type: 'chooseRoyal', cardId: 'r4' });
    expect(playLine(state, result.line).winner).toBe(0);
  });

  it('follows an extra turn into a known winning card instead of alternating perspective at each action', () => {
    const state = scene(); whiteNine(state); own(state, ['j1-21']);
    offer(state, 'j1-08'); offer(state, 'j2-02');
    wallets(state, { blue: 3, green: 2, red: 3, pearl: 1 }); checked(state);
    const result = findImmediateWin(state, { maxNodes: 80, maxDepth: 12 });
    expect(result.status).toBe('win'); expect(result.line.filter(action => action.type === 'buy')).toHaveLength(2);
    expect(playLine(state, result.line).winner).toBe(0);
  });

  it('never uses the real deck top to certify a winning extra-turn draw', () => {
    const state = scene(); whiteNine(state); offer(state, 'j1-08');
    wallets(state, { green: 2, red: 2, black: 4, pearl: 2 });
    detach(state, 'j1-26'); state.decks[1].push('j1-26'); checked(state);
    const first = findImmediateWin(state, { maxNodes: 128 });
    const reversed = structuredClone(state); reversed.decks[1].reverse(); reversed.rng = 817;
    const second = findImmediateWin(reversed, { maxNodes: 128 });
    expect(first.status).toBe('unknown'); expect(second).toEqual(first);
    const actual = applyAction(state, { type: 'buy', source: { kind: 'market', level: 1, index: 0 } });
    expect(actual.ok).toBe(true);
    if (!actual.ok) throw new Error(actual.error);
    expect(findImmediateWin(actual.state, { maxNodes: 32 }).status).toBe('win');
  });

  it('reports unknown at a binding node/depth budget rather than certifying no win', () => {
    const state = scene(); whiteNine(state); offer(state, 'j1-26'); wallets(state, { black: 4, pearl: 1 }); checked(state);
    const nodeLimited = findImmediateWin(state, { maxNodes: 1 });
    const depthLimited = findImmediateWin(state, { maxDepth: 1 });
    expect(nodeLimited.status).toBe('unknown'); expect(nodeLimited.nodes).toBeLessThanOrEqual(1);
    expect(depthLimited.status).toBe('unknown'); expect(depthLimited.complete).toBe(false);
  });

  it('proves no immediate win in a no-privilege opening despite harmless blind-reserve choices', () => {
    const state = scene(); wallets(state, {}); checked(state);
    expect(findImmediateWin(state, { maxNodes: 16 })).toMatchObject({ status: 'none', complete: true });
  });

  it('separates winning-threat theft from an irrelevant theft with a complete opponent turn', () => {
    const state = scene(); own(state, ['j2-02']); whiteNine(state, 1); own(state, ['j1-06'], 1);
    offer(state, 'j2-04'); wallets(state, {}, { blue: 4, green: 2, red: 1 });
    state.phase = 'effect'; state.effects = [{ kind: 'steal', cardId: 'j2-02' }];
    state.pending = { kind: 'stealToken', colors: ['blue', 'green', 'red'] }; checked(state);
    const result = analyzeTactics(state, { maxNodes: 160 });
    expect(result.losingActions).toContainEqual({ type: 'stealToken', color: 'red' });
    expect(result.safeActions).toContainEqual({ type: 'stealToken', color: 'blue' });
    expect(result.safeActions).toContainEqual({ type: 'stealToken', color: 'green' });
    expect(result.complete).toBe(true); expect(result.status).toBe('unknown');
  });

  it('certifies forced loss only when every root action loses within the tactical window', () => {
    const state = scene(); own(state, ['j2-02']);
    own(state, ['j3-02', 'j3-01', 'j2-01', 'j1-11', 'j1-12', 'j1-21', 'j1-22', 'j1-24'], 1);
    offer(state, 'j1-05'); wallets(state, {}, { black: 1 });
    state.phase = 'effect'; state.effects = [{ kind: 'steal', cardId: 'j2-02' }];
    state.pending = { kind: 'stealToken', colors: ['black'] }; checked(state);
    expect(analyzeTactics(state, { maxNodes: 64 })).toMatchObject({ status: 'forcedLoss', complete: true });
    expect(analyzeTactics(state, { maxNodes: 1 })).toMatchObject({ status: 'unknown', complete: false });
  });
});

describe('complete tactical action enumeration', () => {
  it('includes all five legal ways to preserve a colored token with one gold', () => {
    const state = scene(); offer(state, 'j1-01'); wallets(state, { blue: 1, green: 1, red: 1, black: 1, gold: 1 }); checked(state);
    const result = enumerateTacticalActions(state);
    const purchases = result.actions.filter(action => action.type === 'buy');
    expect(result.complete).toBe(true); expect(purchases).toHaveLength(5);
    expect(new Set(purchases.map(tacticalActionKey)).size).toBe(5);
    for (const action of purchases) expect(applyAction(state, action).ok).toBe(true);
    expect(purchases.some(action => action.payment?.gold === 1 && action.payment.blue === 0)).toBe(true);
  });

  it('enumerates whole discard combinations and explicitly marks a truncated action list', () => {
    const state = scene(); wallets(state, { white: 4, blue: 4, green: 3 });
    state.phase = 'discard'; state.pending = { kind: 'discard', count: 1 }; checked(state);
    const result = enumerateTacticalActions(state);
    expect(result.complete).toBe(true); expect(result.actions).toHaveLength(3);
    for (const action of result.actions) expect(applyAction(state, action).ok).toBe(true);
    expect(enumerateTacticalActions(state, { maxActions: 1 })).toMatchObject({ complete: false });
  });

  it('uses canonical payment and token indices in action identities', () => {
    const source = { kind: 'market', level: 1, index: 0 } as const;
    expect(tacticalActionKey({ type: 'buy', source, payment: { ...emptyWallet(), blue: 1, gold: 1 } }))
      .toBe(tacticalActionKey({ payment: { gold: 1, pearl: 0, black: 0, red: 0, green: 0, blue: 1, white: 0 }, source, type: 'buy' }));
    expect(tacticalActionKey({ type: 'takeTokens', indices: [3, 2, 1] })).toBe(tacticalActionKey({ type: 'takeTokens', indices: [1, 2, 3] }));
  });
});
