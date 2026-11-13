import { describe, expect, it } from 'vitest';
import { applyAction, createGame, emptyWallet } from '../game/engine';
import type { Action, GameState } from '../game/types';
import { planTableMotion } from './useTableMotion';

function transition(before: GameState, action: Action) {
  const result = applyAction(before, action);
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

describe('table motion boundaries', () => {
  it('sends taken pieces to the acting player even after the turn changes', () => {
    const before = createGame('motion-take');
    const index = before.board.findIndex(color => color !== 'gold');
    const action: Action = { type: 'takeTokens', indices: [index] };
    const after = transition(before, action);
    const original = JSON.stringify([before, after]);
    const plan = planTableMotion(before, after, action);
    expect(after.turn).not.toBe(before.turn);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].to[0]).toContain(`data-motion-tray="${before.turn}"`);
    expect(plan.moves[0].to[0]).toContain(`data-motion-token="${before.board[index]}"`);
    expect(JSON.stringify([before, after])).toBe(original);
  });

  it('blind reservations never inspect either deck or private hand identities', () => {
    const before = createGame('motion-blind');
    const action: Action = { type: 'reserve', goldIndex: before.board.indexOf('gold'), source: { kind: 'deck', level: 2 } };
    const after = transition(before, action);
    const hiddenId = after.players[before.turn].reserved[0];
    for (const state of [before, after]) {
      Object.defineProperty(state, 'decks', { get() { throw new Error('Private deck read'); } });
      for (const player of state.players) Object.defineProperty(player, 'reserved', { get() { throw new Error('Private hand read'); } });
    }
    const plan = planTableMotion(before, after, action);
    expect(plan.moves.at(-1)).toMatchObject({ back: 2, count: 1 });
    expect(plan.moves.at(-1)?.flip).toBeUndefined();
    expect(plan.arrivals).toHaveLength(0);
    expect(JSON.stringify(plan)).not.toContain(hiddenId);
  });

  it('covers a public reservation and reveals only its new public replacement', () => {
    const before = createGame('motion-public');
    const action: Action = { type: 'reserve', goldIndex: before.board.indexOf('gold'), source: { kind: 'market', level: 1, index: 0 } };
    const after = transition(before, action);
    const plan = planTableMotion(before, after, action);
    expect(plan.moves.at(-1)).toMatchObject({ back: 1, flip: true });
    expect(plan.arrivals).toEqual([{ from: ['[data-motion-deck="1"]'], to: `.market [data-card-id="${after.market[1][0]}"]`, level: 1 }]);
  });

  it('does not invent a replacement when the deck is exhausted', () => {
    const before = createGame('motion-empty');
    before.decks[1] = [];
    const action: Action = { type: 'reserve', goldIndex: before.board.indexOf('gold'), source: { kind: 'market', level: 1, index: 0 } };
    const plan = planTableMotion(before, transition(before, action), action);
    expect(plan.arrivals).toHaveLength(0);
  });

  it('animates actual payment deltas, including gold, rather than the raw card cost', () => {
    const before = createGame('motion-payment');
    before.players[before.turn].tokens = { ...emptyWallet(), white: 2, gold: 1, pearl: 1 };
    const after = structuredClone(before);
    after.players[before.turn].tokens.white = 1;
    after.players[before.turn].tokens.gold = 0;
    const plan = planTableMotion(before, after, { type: 'buy', source: { kind: 'market', level: 1, index: 0 } });
    const payments = plan.moves.filter(move => move.to.includes('[data-motion-bag]'));
    expect(payments).toHaveLength(2);
    expect(payments.map(move => move.count)).toEqual([1, 1]);
    expect(payments[0].from[0]).toContain('data-motion-token="white"');
    expect(payments[1].from[0]).toContain('data-motion-token="gold"');
  });

  it('drops new board pieces without moving the pieces already present', () => {
    const before = createGame('motion-refill');
    const take: Action = { type: 'takeTokens', indices: [before.board.findIndex(color => color !== 'gold')] };
    const depleted = transition(before, take);
    const emptyIndex = depleted.board.indexOf(null);
    const refill: Action = { type: 'refill' };
    // A real refill needs returned tokens in the bag; transfer one from the actor.
    const color = before.board[emptyIndex]!;
    depleted.players[before.turn].tokens[color]--;
    depleted.bag.push(color);
    const plan = planTableMotion(depleted, transition(depleted, refill), refill);
    expect(plan.moves).toHaveLength(0);
    expect(plan.arrivals).toEqual([{ from: ['[data-motion-bag]'], to: `[data-board-index="${emptyIndex}"] .token` }]);
  });

  it('uses only a level back when purchasing from a closed private hand', () => {
    const before = createGame('motion-private');
    const hiddenId = before.decks[3][0];
    before.players[before.turn].reserved = [hiddenId];
    const after = structuredClone(before);
    after.players[before.turn].reserved = [];
    const plan = planTableMotion(before, after, { type: 'buy', source: { kind: 'reserve', index: 0 } });
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({ back: 3, count: 1 });
    expect(JSON.stringify(plan)).not.toContain(hiddenId);
  });
});
