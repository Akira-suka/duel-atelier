import { describe, expect, it } from 'vitest';
import { JEWEL_CARDS, ROYAL_CARDS, getJewel } from './catalog';
import {
  applyAction, canBuy, countTokens, createGame, emptyWallet, getDiscountedCost,
  getLegalActions, getPayment, getPlayerView, getStats, parseSave, serializeGame, validateState,
} from './engine';
import {
  COST_COLORS, GEM_COLORS, LEVELS, TOKEN_COLORS,
  type Action, type GameState, type GemColor, type JewelCard, type PlayerId,
  type TokenColor, type Wallet,
} from './types';

// Fixtures relocate real cards/tokens; they never manufacture extra components.
function scene(): GameState {
  const state = createGame('rules-fixture', ['甲', '乙']);
  state.turn = 0;
  state.players[0].privileges = 0;
  state.players[1].privileges = 1;
  state.privilegeSupply = 2;
  return state;
}

function wallet(values: Partial<Wallet> = {}): Wallet {
  return { ...emptyWallet(), ...values };
}

function detach(state: GameState, id: string) {
  for (const level of LEVELS) {
    state.decks[level] = state.decks[level].filter((value) => value !== id);
    state.market[level] = state.market[level].map((value) => value === id ? null : value);
  }
  for (const player of state.players) {
    player.cards = player.cards.filter((card) => card.cardId !== id);
    player.reserved = player.reserved.filter((value) => value !== id);
  }
}

function offer(state: GameState, card: JewelCard, index = 0) {
  detach(state, card.id);
  const previous = state.market[card.level][index];
  if (previous) state.decks[card.level].push(previous);
  state.market[card.level][index] = card.id;
}

function own(state: GameState, card: JewelCard, player: PlayerId = 0, color?: GemColor) {
  detach(state, card.id);
  state.players[player].cards.push({
    cardId: card.id,
    color: card.bonus?.color === 'choice' ? color ?? 'white' : card.bonus?.color ?? null,
  });
}

function reserve(state: GameState, card: JewelCard) {
  detach(state, card.id);
  state.players[0].reserved.push(card.id);
}

function distribute(
  state: GameState,
  first: Wallet = wallet(),
  second: Wallet = wallet(),
  board: Record<number, TokenColor> = {},
) {
  const remaining = wallet({ white: 4, blue: 4, green: 4, red: 4, black: 4, pearl: 2, gold: 3 });
  state.players[0].tokens = { ...first };
  state.players[1].tokens = { ...second };
  state.board = Array.from({ length: 25 }, () => null);
  for (const color of TOKEN_COLORS) remaining[color] -= first[color] + second[color];
  for (const [index, color] of Object.entries(board)) {
    state.board[Number(index)] = color;
    remaining[color]--;
  }
  state.bag = [];
  for (const color of TOKEN_COLORS) {
    if (remaining[color] < 0) throw new Error(`Invalid fixture token count: ${color}`);
    state.bag.push(...Array.from({ length: remaining[color] }, () => color));
  }
}

function cardWhere(predicate: (card: JewelCard) => boolean): JewelCard {
  const card = JEWEL_CARDS.find(predicate);
  if (!card) throw new Error('The real card catalog has no card matching this fixture.');
  return card;
}

function act(state: GameState, action: Action): GameState {
  const result = applyAction(state, action);
  if (!result.ok) throw new Error(`${JSON.stringify(action)}: ${result.error}`);
  return result.state;
}

function reject(state: GameState, action: Action) {
  const before = structuredClone(state);
  expect(applyAction(state, action).ok).toBe(false);
  expect(state).toEqual(before);
}

function fundedPurchase(card: JewelCard) {
  const state = scene();
  offer(state, card);
  const payment = wallet(card.cost);
  // Costs above the physical supply are covered by real existing discounts.
  for (const color of GEM_COLORS) {
    while (payment[color] > 4) {
      const discount = cardWhere((candidate) => candidate.id !== card.id
        && candidate.bonus?.color === color
        && !state.players[0].cards.some((owned) => owned.cardId === candidate.id));
      own(state, discount);
      payment[color] = Math.max(0, payment[color] - discount.bonus!.amount);
    }
  }
  distribute(state, payment, wallet(), { 0: 'gold' });
  return state;
}

function buy(state: GameState, card: JewelCard) {
  return act(state, { type: 'buy', source: { kind: 'market', level: card.level, index: 0 } });
}

function finishChoices(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 16 && next.pending; guard++) {
    const action = getLegalActions(next)[0];
    if (!action) throw new Error(`Unresolvable choice: ${JSON.stringify(next.pending)}`);
    next = act(next, action);
  }
  expect(next.pending).toBeNull();
  return next;
}

describe('setup and immutable command handling', () => {
  it('creates a reproducible complete setup with the second player receiving one privilege', () => {
    const state = createGame('seed-1001', ['甲', '乙']);
    expect(state).toEqual(createGame('seed-1001', ['甲', '乙']));
    expect(state.board).not.toEqual(createGame('seed-1002', ['甲', '乙']).board);
    expect(state.market[1]).toHaveLength(5);
    expect(state.market[2]).toHaveLength(4);
    expect(state.market[3]).toHaveLength(3);
    expect(state.decks[1]).toHaveLength(25);
    expect(state.decks[2]).toHaveLength(20);
    expect(state.decks[3]).toHaveLength(10);
    expect(state.players[state.turn].privileges).toBe(0);
    expect(state.players[1 - state.turn].privileges).toBe(1);
    expect(state.bag).toHaveLength(0);
    expect(validateState(state)).toEqual([]);
  });

  it('does not mutate its input, and increments the revision exactly once', () => {
    const state = createGame('immutable');
    const before = structuredClone(state);
    const next = act(state, getLegalActions(state).find((action) => action.type === 'takeTokens')!);
    expect(state).toEqual(before);
    expect(next.revision).toBe(state.revision + 1);
    expect(validateState(next)).toEqual([]);
  });

  it('rejects commands after the game is over', () => {
    const state = scene();
    state.phase = 'gameOver';
    state.winner = 0;
    reject(state, { type: 'refill' });
    expect(getLegalActions(state)).toEqual([]);
  });
});

describe('taking tokens, privileges and replenishment', () => {
  it.each([[0], [0, 1], [0, 1, 2], [0, 6, 12], [4, 8, 12]])(
    'accepts uninterrupted straight selections %j', (...indices) => {
      const state = scene();
      distribute(state, wallet(), wallet(), { 0: 'white', 1: 'blue', 2: 'green', 4: 'white', 6: 'blue', 8: 'green', 12: 'red' });
      const next = act(state, { type: 'takeTokens', indices });
      expect(countTokens(next.players[0].tokens)).toBe(indices.length);
      for (const index of indices) expect(next.board[index]).toBeNull();
      expect(next.turn).toBe(1);
      expect(validateState(next)).toEqual([]);
    },
  );

  it.each([[], [0, 0], [0, 2], [0, 1, 6], [0, 1, 2, 3], [-1], [25], [0.5]])(
    'rejects invalid geometry or indices %j', (...indices) => {
      const state = scene();
      distribute(state, wallet(), wallet(), { 0: 'white', 1: 'blue', 2: 'green', 3: 'red', 6: 'black' });
      reject(state, { type: 'takeTokens', indices });
    },
  );

  it('cannot jump over empty spaces or include gold', () => {
    const state = scene();
    distribute(state, wallet(), wallet(), { 0: 'white', 2: 'blue', 6: 'gold' });
    reject(state, { type: 'takeTokens', indices: [0, 1, 2] });
    reject(state, { type: 'takeTokens', indices: [6] });
  });

  it.each([
    { 0: 'red', 1: 'red', 2: 'red' },
    { 0: 'pearl', 1: 'blue', 2: 'pearl' },
  ] satisfies Record<number, TokenColor>[])('awards exactly one privilege for the special draft', (board) => {
    const state = scene();
    distribute(state, wallet(), wallet(), board);
    const next = act(state, { type: 'takeTokens', indices: [0, 1, 2] });
    expect(next.players[1].privileges).toBe(2);
    expect(next.privilegeSupply).toBe(1);
  });

  it('takes a privilege from the other player if the supply is empty', () => {
    const state = scene();
    distribute(state, wallet(), wallet(), { 0: 'red', 1: 'red', 2: 'red' });
    state.privilegeSupply = 0;
    state.players[0].privileges = 2;
    state.players[1].privileges = 1;
    const next = act(state, { type: 'takeTokens', indices: [0, 1, 2] });
    expect(next.players.map((player) => player.privileges)).toEqual([1, 2]);
  });

  it('does nothing if the privilege recipient already owns all three', () => {
    const state = scene();
    distribute(state, wallet(), wallet(), { 0: 'red', 1: 'red', 2: 'red' });
    state.privilegeSupply = 0;
    state.players[1].privileges = 3;
    const next = act(state, { type: 'takeTokens', indices: [0, 1, 2] });
    expect(next.players[1].privileges).toBe(3);
    expect(next.privilegeSupply).toBe(0);
  });

  it('allows several privileges before the main action without the two-pearl draft penalty', () => {
    const state = scene();
    distribute(state, wallet(), wallet(), { 0: 'pearl', 24: 'pearl', 12: 'gold' });
    state.players[0].privileges = 2;
    state.privilegeSupply = 0;
    const first = act(state, { type: 'usePrivilege', index: 0 });
    const second = act(first, { type: 'usePrivilege', index: 24 });
    expect(second.turn).toBe(0);
    expect(second.phase).toBe('start');
    expect(second.players[0].tokens.pearl).toBe(2);
    expect(second.players[1].privileges).toBe(1);
    expect(second.privilegeSupply).toBe(2);
    reject(first, { type: 'usePrivilege', index: 12 });
  });

  it('replenishes only vacant spaces and permanently closes the privilege step for this turn', () => {
    const state = scene();
    distribute(state, wallet(), wallet(), { 12: 'red', 17: 'blue' });
    state.players[0].privileges = 1;
    state.privilegeSupply = 1;
    const next = act(state, { type: 'refill' });
    expect(next.board[12]).toBe('red');
    expect(next.board[17]).toBe('blue');
    expect(next.board.every(Boolean)).toBe(true);
    expect(next.bag).toEqual([]);
    expect(next.phase).toBe('main');
    expect(next.players[1].privileges).toBe(2);
    reject(next, { type: 'usePrivilege', index: 12 });
    reject(next, { type: 'refill' });
    expect(validateState(next)).toEqual([]);
  });

  it('forbids replenishment when the bag is empty and offers it when the board is empty', () => {
    reject(createGame('full-board'), { type: 'refill' });
    const state = scene();
    distribute(state);
    expect(getLegalActions(state)).toEqual([{ type: 'refill' }]);
    expect(act(state, { type: 'refill' }).board.every(Boolean)).toBe(true);
  });
});

describe('reserving and purchasing', () => {
  it('takes the selected gold and replaces a publicly reserved card', () => {
    const state = scene();
    distribute(state, wallet(), wallet(), { 0: 'gold', 24: 'gold' });
    const selected = state.market[1][0];
    const next = act(state, { type: 'reserve', goldIndex: 24, source: { kind: 'market', level: 1, index: 0 } });
    expect(next.players[0].reserved).toEqual([selected]);
    expect(next.players[0].tokens.gold).toBe(1);
    expect(next.board[0]).toBe('gold');
    expect(next.board[24]).toBeNull();
    expect(next.market[1][0]).not.toBe(selected);
    expect(next.decks[1]).toHaveLength(state.decks[1].length - 1);
    expect(validateState(next)).toEqual([]);
  });

  it('supports blind reservation without changing the public market', () => {
    const state = scene();
    distribute(state, wallet(), wallet(), { 0: 'gold' });
    const next = act(state, { type: 'reserve', goldIndex: 0, source: { kind: 'deck', level: 3 } });
    expect(next.market).toEqual(state.market);
    expect(state.decks[3]).toContain(next.players[0].reserved[0]);
    expect(next.decks[3]).toHaveLength(state.decks[3].length - 1);
    expect(validateState(next)).toEqual([]);
  });

  it('rejects reservation without gold, a fourth reserve, and reserve-to-reserve moves', () => {
    const state = scene();
    distribute(state, wallet(), wallet(), { 0: 'blue' });
    reject(state, { type: 'reserve', goldIndex: 0, source: { kind: 'deck', level: 1 } });
    distribute(state, wallet(), wallet(), { 0: 'gold' });
    for (const card of JEWEL_CARDS.slice(0, 3)) reserve(state, card);
    reject(state, { type: 'reserve', goldIndex: 0, source: { kind: 'deck', level: 1 } });
    reject(state, { type: 'reserve', goldIndex: 0, source: { kind: 'reserve', index: 0 } });
  });

  it('pays for and owns a card, returns payment to the bag and refills the market', () => {
    const card = cardWhere((candidate) => candidate.level === 1 && candidate.effects.length === 0 && candidate.bonus?.color !== 'choice');
    const state = fundedPurchase(card);
    const before = structuredClone(state);
    const next = buy(state, card);
    expect(state).toEqual(before);
    expect(next.players[0].cards.map((owned) => owned.cardId)).toContain(card.id);
    expect(countTokens(next.players[0].tokens)).toBe(0);
    expect(next.bag.length).toBe(state.bag.length + countTokens(wallet(card.cost)));
    expect(next.market[card.level][0]).not.toBe(card.id);
    expect(validateState(next)).toEqual([]);
  });

  it('can buy a reserved card without replacing a market slot', () => {
    const card = cardWhere((candidate) => candidate.level === 1 && candidate.effects.length === 0 && candidate.bonus?.color !== 'choice');
    const state = fundedPurchase(card);
    reserve(state, card);
    const next = act(state, { type: 'buy', source: { kind: 'reserve', index: 0 } });
    expect(next.players[0].reserved).toEqual([]);
    expect(next.market).toEqual(state.market);
    expect(next.players[0].cards.map((owned) => owned.cardId)).toContain(card.id);
  });

  it('allows gold to replace a held gem instead of forcing the default payment', () => {
    const card = cardWhere((candidate) => candidate.level === 1 && candidate.effects.length === 0 && COST_COLORS.some((color) => candidate.cost[color] > 0));
    const color = COST_COLORS.find((value) => card.cost[value] > 0)!;
    const state = fundedPurchase(card);
    const funds = { ...state.players[0].tokens, gold: 1 };
    distribute(state, funds);
    const payment = { ...getPayment(state, 0, card.id)! };
    payment[color]--;
    payment.gold++;
    const next = act(state, { type: 'buy', source: { kind: 'market', level: card.level, index: 0 }, payment });
    expect(next.players[0].tokens[color]).toBe(1);
    expect(next.players[0].tokens.gold).toBe(0);
    expect(validateState(next)).toEqual([]);
  });

  it('rejects overpayment, underpayment, negative and fractional payment', () => {
    const card = cardWhere((candidate) => candidate.level === 1 && candidate.effects.length === 0);
    const state = fundedPurchase(card);
    const payment = getPayment(state, 0, card.id)!;
    const color = COST_COLORS.find((value) => payment[value] > 0)!;
    for (const changed of [-1, 0.5, payment[color] + 1, payment[color] - 1]) {
      reject(state, { type: 'buy', source: { kind: 'market', level: card.level, index: 0 }, payment: { ...payment, [color]: changed } });
    }
    reject(state, { type: 'buy', source: { kind: 'deck', level: 1 } });
  });

  it('subtracts every permanent bonus, never discounts pearls, and never creates a negative cost', () => {
    const target = cardWhere((candidate) => candidate.cost.pearl > 0 && candidate.bonus?.color !== 'choice');
    const state = scene();
    offer(state, target);
    for (const color of GEM_COLORS) {
      for (const card of JEWEL_CARDS.filter((candidate) => candidate.id !== target.id && candidate.bonus?.color === color).slice(0, 3)) own(state, card);
    }
    const stats = getStats(state, 0);
    const cost = getDiscountedCost(state, 0, target.id);
    for (const color of GEM_COLORS) expect(cost[color]).toBe(Math.max(0, target.cost[color] - stats.bonuses[color]));
    expect(cost.pearl).toBe(target.cost.pearl);
    expect(Object.values(cost).every((value) => value >= 0)).toBe(true);
  });

  it('requires an existing bonus before buying a copy-color card and locks its chosen color', () => {
    const copy = cardWhere((card) => card.bonus?.color === 'choice');
    const state = fundedPurchase(copy);
    // Return any fixture discounts to their decks before checking the prerequisite.
    for (const owned of [...state.players[0].cards]) {
      const card = getJewel(owned.cardId);
      detach(state, card.id);
      state.decks[card.level].push(card.id);
    }
    expect(canBuy(state, 0, copy.id)).toBe(false);
    const double = cardWhere((card) => card.bonus?.amount === 2 && card.bonus.color !== 'choice');
    own(state, double);
    const cost = getDiscountedCost(state, 0, copy.id);
    const funds = wallet(cost);
    for (const color of GEM_COLORS) {
      if (funds[color] > 4) { funds.gold += funds[color] - 4; funds[color] = 4; }
    }
    distribute(state, funds);
    let next = buy(state, copy);
    expect(next.pending?.kind).toBe('chooseColor');
    const color = double.bonus!.color as GemColor;
    const wrong = GEM_COLORS.find((value) => value !== color)!;
    reject(next, { type: 'chooseColor', color: wrong });
    next = act(next, { type: 'chooseColor', color });
    expect(next.players[0].cards.find((card) => card.cardId === copy.id)?.color).toBe(color);
    expect(getStats(next, 0).bonuses[color]).toBe(2 + copy.bonus!.amount);
  });
});

describe('card effects, royal rewards and turn completion', () => {
  it('takes a selected matching board token and skips the effect when none exists', () => {
    const card = cardWhere((candidate) => candidate.effects.includes('drawGem') && candidate.bonus?.color !== 'choice');
    const state = fundedPurchase(card);
    const color = card.bonus!.color as GemColor;
    distribute(state, state.players[0].tokens, wallet(), { 0: color, 24: color, 12: 'gold' });
    const next = buy(state, card);
    expect(next.pending?.kind).toBe('takeBonusToken');
    reject(next, { type: 'takeBonusToken', index: 12 });
    const resolved = act(next, { type: 'takeBonusToken', index: 24 });
    expect(resolved.board[0]).toBe(color);
    expect(resolved.board[24]).toBeNull();
    expect(resolved.players[0].tokens[color]).toBe(1);
    const absent = fundedPurchase(card);
    expect(buy(absent, card).pending?.kind).not.toBe('takeBonusToken');
  });

  it('can steal a pearl, cannot steal gold, and skips when the opponent only has gold', () => {
    const card = cardWhere((candidate) => candidate.effects.includes('steal') && candidate.bonus?.color !== 'choice');
    const state = fundedPurchase(card);
    distribute(state, state.players[0].tokens, wallet({ pearl: 1, gold: 1 }));
    const next = buy(state, card);
    expect(next.pending?.kind).toBe('stealToken');
    reject(next, { type: 'stealToken', color: 'gold' } as unknown as Action);
    const resolved = act(next, { type: 'stealToken', color: 'pearl' });
    expect(resolved.players[0].tokens.pearl).toBe(1);
    expect(resolved.players[1].tokens.pearl).toBe(0);
    const absent = fundedPurchase(card);
    distribute(absent, absent.players[0].tokens, wallet({ gold: 1 }));
    expect(buy(absent, card).pending?.kind).not.toBe('stealToken');
  });

  it('grants the third-crown reward even when the purchase moves from two to four crowns', () => {
    const before = cardWhere((card) => card.crowns === 2 && card.bonus?.color !== 'choice');
    const purchased = cardWhere((card) => card.crowns === 2 && card.id !== before.id && card.bonus?.color !== 'choice' && card.effects.length === 0);
    const state = fundedPurchase(purchased);
    own(state, before);
    const next = buy(state, purchased);
    expect(getStats(next, 0).crowns).toBeGreaterThanOrEqual(4);
    expect(next.pending).toMatchObject({ kind: 'chooseRoyal', threshold: 3 });
    const royal = ROYAL_CARDS.find((card) => card.effect === null)!;
    const resolved = act(next, { type: 'chooseRoyal', cardId: royal.id });
    expect(resolved.players[0].royalClaims).toContain(3);
    expect(resolved.players[0].royals).toContain(royal.id);
    expect(resolved.royals).not.toContain(royal.id);
    expect(validateState(resolved)).toEqual([]);
  });

  it('resolves the sixth-crown reward independently of an already claimed third-crown reward', () => {
    const purchased = cardWhere((card) => card.crowns === 2 && card.bonus?.color !== 'choice' && card.effects.length === 0);
    const state = fundedPurchase(purchased);
    let crowns = getStats(state, 0).crowns;
    for (const card of JEWEL_CARDS.filter((value) => value.id !== purchased.id && value.crowns > 0 && value.bonus?.color !== 'choice')) {
      if (crowns >= 4) break;
      if (state.players[0].cards.some((owned) => owned.cardId === card.id)) continue;
      own(state, card);
      crowns += card.crowns;
    }
    const claimed = ROYAL_CARDS.find((card) => card.effect === null)!;
    state.royals = state.royals.filter((id) => id !== claimed.id);
    state.players[0].royals = [claimed.id];
    state.players[0].royalClaims = [3];
    const next = buy(state, purchased);
    expect(next.pending).toMatchObject({ kind: 'chooseRoyal', threshold: 6 });
  });

  it('can earn another extra turn while already playing an extra turn', () => {
    const replays = JEWEL_CARDS.filter((card) => card.level === 1 && card.effects.includes('replay'));
    const first = replays[0];
    const second = replays[1];
    const state = scene();
    offer(state, first, 0);
    offer(state, second, 1);
    const funds = wallet();
    for (const color of COST_COLORS) funds[color] = first.cost[color] + second.cost[color];
    distribute(state, funds, wallet(), { 0: 'black' });
    let next = buy(state, first);
    expect(next.turn).toBe(0);
    expect(next.turnNumber).toBe(state.turnNumber + 1);
    next = act(next, { type: 'buy', source: { kind: 'market', level: 1, index: 1 } });
    expect(next.turn).toBe(0);
    expect(next.turnNumber).toBe(state.turnNumber + 2);
    expect(next.players[0].cards.map((card) => card.cardId)).toEqual([first.id, second.id]);
    next = act(next, { type: 'takeTokens', indices: [0] });
    expect(next.turn).toBe(1);
    expect(validateState(next)).toEqual([]);
  });

  it.each(ROYAL_CARDS)('resolves royal reward $id and its effect before the turn ends', (royal) => {
    const previous = cardWhere((card) => card.crowns === 2 && card.bonus?.color !== 'choice');
    const purchased = cardWhere((card) => card.level === 1 && card.crowns === 1);
    const state = fundedPurchase(purchased);
    own(state, previous);
    distribute(state, state.players[0].tokens, wallet({ pearl: 1, gold: 1 }));
    const acquired = buy(state, purchased);
    let next = act(acquired, { type: 'chooseRoyal', cardId: royal.id });
    if (royal.effect === 'steal') {
      expect(next.pending?.kind).toBe('stealToken');
      expect(next.turn).toBe(0);
      next = act(next, { type: 'stealToken', color: 'pearl' });
      expect(next.players[0].tokens.pearl).toBe(1);
    }
    if (royal.effect === 'privilege') expect(next.players[0].privileges).toBe(1);
    expect(getStats(next, 0).points).toBe(previous.points + purchased.points + royal.points);
    expect(next.turn).toBe(royal.effect === 'replay' ? 0 : 1);
    expect(validateState(next)).toEqual([]);
  });

  it('grants a privilege card effect immediately and keeps the main action consumed', () => {
    const card = cardWhere((candidate) => candidate.effects.includes('privilege'));
    const state = fundedPurchase(card);
    const next = buy(state, card);
    expect(next.players[0].privileges).toBe(1);
    expect(next.privilegeSupply).toBe(state.privilegeSupply - 1);
    expect(next.turn).toBe(1);
    expect(validateState(next)).toEqual([]);
  });

  it('requires the exact discard count and includes gold in the ten-token limit', () => {
    const state = scene();
    distribute(state, wallet({ white: 3, blue: 3, green: 2, gold: 2 }), wallet(), { 0: 'red', 1: 'black', 2: 'pearl' });
    const next = act(state, { type: 'takeTokens', indices: [0, 1, 2] });
    expect(next.phase).toBe('discard');
    expect(next.pending).toEqual({ kind: 'discard', count: 3 });
    expect(next.turn).toBe(0);
    reject(next, { type: 'discard', tokens: wallet({ gold: 2 }) });
    reject(next, { type: 'discard', tokens: wallet({ red: 2, gold: 1 }) });
    const resolved = act(next, { type: 'discard', tokens: wallet({ gold: 2, pearl: 1 }) });
    expect(countTokens(resolved.players[0].tokens)).toBe(10);
    expect(resolved.turn).toBe(1);
    expect(resolved.bag.length).toBe(next.bag.length + 3);
    expect(validateState(resolved)).toEqual([]);
  });

  it.each(['prestige', 'crowns', 'color'] as const)('recognizes the %s victory at turn end', (reason) => {
    const state = scene();
    let candidates = [...JEWEL_CARDS];
    if (reason === 'color') candidates = candidates.filter((card) => card.bonus?.color === 'red');
    candidates.sort((a, b) => reason === 'crowns' ? b.crowns - a.crowns : b.points - a.points);
    for (const card of candidates) {
      const stats = getStats(state, 0);
      if (reason === 'prestige' && stats.points >= 20) break;
      if (reason === 'crowns' && stats.crowns >= 10) break;
      if (reason === 'color' && stats.colorPoints.red >= 10) break;
      own(state, card);
    }
    distribute(state, wallet(), wallet(), { 0: 'blue' });
    const next = act(state, { type: 'takeTokens', indices: [0] });
    expect(next.winner).toBe(0);
    expect(next.phase).toBe('gameOver');
    expect(next.victoryReasons).toContain(reason);
    expect(next.turn).toBe(0);
  });

  it('does not declare victory until the mandatory discard has resolved', () => {
    const state = scene();
    for (const card of [...JEWEL_CARDS].sort((a, b) => b.points - a.points)) {
      if (getStats(state, 0).points >= 20) break;
      own(state, card);
    }
    distribute(state, wallet({ white: 4, blue: 4, green: 2 }), wallet(), { 0: 'red' });
    const next = act(state, { type: 'takeTokens', indices: [0] });
    expect(next.winner).toBeNull();
    expect(next.phase).toBe('discard');
    const resolved = act(next, { type: 'discard', tokens: wallet({ red: 1 }) });
    expect(resolved.winner).toBe(0);
  });

  it('counts colorless jewels and royals only toward total prestige', () => {
    const state = scene();
    const colorless = cardWhere((card) => card.bonus === null && card.points > 0);
    own(state, colorless);
    const royal = ROYAL_CARDS[0];
    state.royals = state.royals.filter((id) => id !== royal.id);
    state.players[0].royals.push(royal.id);
    const stats = getStats(state, 0);
    expect(stats.points).toBe(colorless.points + royal.points);
    expect(Object.values(stats.colorPoints).every((points) => points === 0)).toBe(true);
  });
});

describe('optional-action deadlock guard', () => {
  function crowdedScene() {
    const state = scene();
    for (const level of LEVELS) {
      const candidates = JEWEL_CARDS.filter((card) => card.level === level && card.cost.white + card.cost.blue > 0);
      for (let index = 0; index < state.market[level].length; index++) offer(state, candidates[index], index);
    }
    for (const card of JEWEL_CARDS.filter((card) => card.level === 3 && card.cost.white + card.cost.blue > 0).slice(-3)) reserve(state, card);
    distribute(state, wallet({ green: 4, red: 4, black: 2 }), wallet({ white: 4, blue: 4, black: 2 }), { 0: 'pearl', 1: 'pearl', 2: 'gold', 3: 'gold', 4: 'gold' });
    state.players[0].privileges = 3;
    state.players[1].privileges = 0;
    state.privilegeSupply = 0;
    return state;
  }

  it('rejects only the optional removal that would leave no main action and no refill', () => {
    const state = crowdedScene();
    expect(validateState(state)).toEqual([]);
    const first = act(state, { type: 'usePrivilege', index: 0 });
    expect(first.players[0].tokens.pearl).toBe(1);
    reject(first, { type: 'usePrivilege', index: 1 });
    expect(getLegalActions(first)).not.toContainEqual({ type: 'usePrivilege', index: 1 });
    const next = act(first, { type: 'takeTokens', indices: [1] });
    expect(next.phase).toBe('discard');
    expect(finishChoices(next).turn).toBe(1);
  });

  it('allows taking the last non-gold token when gold reservation remains possible', () => {
    const state = crowdedScene();
    const id = state.players[0].reserved.pop()!;
    state.decks[getJewel(id).level].push(id);
    const next = act(act(state, { type: 'usePrivilege', index: 0 }), { type: 'usePrivilege', index: 1 });
    expect(next.players[0].tokens.pearl).toBe(2);
    expect(getLegalActions(next).some((action) => action.type === 'reserve')).toBe(true);
  });
});

describe('save validation and reproducible game traces', () => {
  it('redacts blind reservations, deck order and random state from the opponent view', () => {
    const state = scene();
    state.seed = 'private-seed-marker';
    distribute(state, wallet(), wallet(), { 0: 'gold' });
    const next = act(state, { type: 'reserve', goldIndex: 0, source: { kind: 'deck', level: 3 } });
    const hiddenId = next.players[0].reserved[0];
    const ownView = getPlayerView(next, 0);
    const opponentView = getPlayerView(next, 1);
    expect(ownView.players[0].reserved).toEqual([hiddenId]);
    expect(opponentView.players[0].reserved).toEqual([null]);
    expect(JSON.stringify(opponentView)).not.toContain(hiddenId);
    for (const key of ['seed', 'rng', 'decks', 'bag', 'effects']) expect(opponentView).not.toHaveProperty(key);
    expect(opponentView.deckCounts[3]).toBe(next.decks[3].length);
    expect(opponentView.bagCount).toBe(next.bag.length);
    expect(next.log.join('\n')).not.toContain(hiddenId);
    ownView.players[0].tokens.gold = 99;
    expect(next.players[0].tokens.gold).toBe(1);
  });

  it('only exposes a pending selection to the player making it', () => {
    const card = cardWhere((candidate) => candidate.effects.includes('steal'));
    const state = fundedPurchase(card);
    distribute(state, state.players[0].tokens, wallet({ pearl: 1 }));
    const next = buy(state, card);
    expect(getPlayerView(next, 0).pending).toEqual(next.pending);
    expect(getPlayerView(next, 1).pending).toBeNull();
  });

  it('round-trips both a normal state and a pending choice', () => {
    const state = scene();
    distribute(state, wallet({ white: 4, blue: 4, green: 2 }), wallet(), { 0: 'red' });
    const pending = act(state, { type: 'takeTokens', indices: [0] });
    expect(parseSave(serializeGame(pending))).toEqual(pending);
    expect(parseSave(serializeGame(createGame('save')))).toEqual(createGame('save'));
  });

  it('rejects malformed, unsupported and nonconserving saved games', () => {
    expect(parseSave('{broken')).toBeNull();
    expect(parseSave('null')).toBeNull();
    expect(parseSave('{}')).toBeNull();
    const state = createGame('bad-save');
    expect(parseSave(JSON.stringify({ ...state, version: 2 }))).toBeNull();
    const extraToken = structuredClone(state);
    extraToken.players[0].tokens.gold++;
    expect(parseSave(JSON.stringify(extraToken))).toBeNull();
    const duplicateCard = structuredClone(state);
    duplicateCard.decks[1].push(duplicateCard.decks[1][0]);
    expect(parseSave(JSON.stringify(duplicateCard))).toBeNull();
    const negative = structuredClone(state);
    negative.players[0].tokens.white = -1;
    expect(parseSave(JSON.stringify(negative))).toBeNull();
  });

  it('rejects null bag tokens and array-shaped fields replaced with strings', () => {
    const state = createGame('invalid-bag');
    expect(parseSave(JSON.stringify({ ...state, bag: [null] }))).toBeNull();
    expect(parseSave(JSON.stringify({ ...state, bag: '' }))).toBeNull();
    const nullDeckCard = structuredClone(state);
    nullDeckCard.decks[1].push(null as unknown as string);
    expect(parseSave(JSON.stringify(nullDeckCard))).toBeNull();
  });

  it('rejects a forged copy-color choice for a card that is still in the deck or market', () => {
    const state = scene();
    const white = cardWhere((card) => card.bonus?.color === 'white');
    const copy = cardWhere((card) => card.bonus?.color === 'choice');
    own(state, white);
    expect(validateState(state)).toEqual([]);
    state.phase = 'effect';
    state.effects = [{ kind: 'chooseColor', cardId: copy.id }];
    state.pending = { kind: 'chooseColor', cardId: copy.id, colors: ['white'] };
    expect(parseSave(serializeGame(state))).toBeNull();
  });

  it('rejects forged royal tasks with an invalid or already claimed threshold', () => {
    const previous = cardWhere((card) => card.crowns === 2 && card.bonus?.color !== 'choice');
    const purchased = cardWhere((card) => card.level === 1 && card.crowns === 1);
    const state = fundedPurchase(purchased);
    own(state, previous);
    const valid = buy(state, purchased);
    expect(parseSave(serializeGame(valid))).toEqual(valid);
    const invalidThreshold = structuredClone(valid);
    invalidThreshold.effects[0] = { kind: 'royal', threshold: 9 as 3 };
    invalidThreshold.pending = { kind: 'chooseRoyal', threshold: 9 as 3, cardIds: [...valid.royals] };
    expect(parseSave(serializeGame(invalidThreshold))).toBeNull();
    const alreadyClaimed = structuredClone(valid);
    const royal = alreadyClaimed.royals.pop()!;
    alreadyClaimed.players[0].royals = [royal];
    alreadyClaimed.players[0].royalClaims = [3];
    alreadyClaimed.pending = { kind: 'chooseRoyal', threshold: 3, cardIds: [...alreadyClaimed.royals] };
    expect(parseSave(serializeGame(alreadyClaimed))).toBeNull();
  });

  it('preserves components and legal progress through 64 seeded complete games', () => {
    let decisions = 0;
    const pendingKinds = new Set<string>();
    for (let seed = 1; seed <= 64; seed++) {
      let state = createGame(`simulation-${seed}`);
      let random = seed;
      function roll() {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        return (random >>> 0) / 0x100000000;
      }
      for (let step = 0; step < 1200 && state.winner === null; step++) {
        expect(validateState(state), `seed=${seed}, step=${step}`).toEqual([]);
        const actions = getLegalActions(state);
        expect(actions.length, `no action: seed=${seed}, step=${step}, phase=${state.phase}`).toBeGreaterThan(0);
        const buys = actions.filter((action) => action.type === 'buy');
        const pool = buys.length > 0 && roll() < 0.9 ? buys : actions;
        const action = pool[Math.floor(roll() * pool.length)];
        state = act(state, action);
        decisions++;
        if (state.pending) pendingKinds.add(state.pending.kind);
        if (step % 37 === 0 || state.pending) expect(parseSave(serializeGame(state))).toEqual(state);
      }
      expect(state.winner, `simulation-${seed} failed to terminate`).not.toBeNull();
      expect(validateState(state)).toEqual([]);
    }
    expect(decisions).toBeGreaterThan(1000);
    expect([...pendingKinds].sort()).toEqual(['chooseColor', 'chooseRoyal', 'discard', 'stealToken', 'takeBonusToken']);
  }, 30000);
});
