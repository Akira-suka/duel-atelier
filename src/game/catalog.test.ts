import { describe, expect, it } from 'vitest';
import { getJewel, getRoyal, JEWEL_CARDS, ROYAL_CARDS } from './catalog';
import { COST_COLORS, GEM_COLORS, LEVELS } from './types';

describe('base-game card catalog', () => {
  it('contains all 67 jewels in the 30/24/13 tiers and four unique royals', () => {
    expect(LEVELS.map(level => JEWEL_CARDS.filter(card => card.level === level).length))
      .toEqual([30, 24, 13]);
    expect(ROYAL_CARDS).toHaveLength(4);
    expect(new Set([...JEWEL_CARDS, ...ROYAL_CARDS].map(card => card.id)).size).toBe(71);
  });

  it('contains complete nonnegative integer costs and only gem-color bonuses', () => {
    for (const card of JEWEL_CARDS) {
      expect(Object.keys(card.cost).sort()).toEqual([...COST_COLORS].sort());
      for (const amount of [...Object.values(card.cost), card.points, card.crowns]) {
        expect(Number.isInteger(amount) && amount >= 0).toBe(true);
      }
      expect(Object.values(card.cost).some(amount => amount > 0)).toBe(true);
      if (card.bonus) {
        expect([...GEM_COLORS, 'choice']).toContain(card.bonus.color);
        expect([1, 2]).toContain(card.bonus.amount);
      }
    }
  });

  it('keeps the three colorless prestige cards distinct from copy-color cards', () => {
    const colorless = JEWEL_CARDS.filter(card => card.bonus === null);
    expect(colorless.map(card => [card.id, card.points])).toEqual([
      ['j1-28', 3], ['j2-24', 5], ['j3-13', 6],
    ]);
    expect(colorless.every(card => card.crowns === 0 && card.effects.length === 0)).toBe(true);
    expect(JEWEL_CARDS.filter(card => card.bonus?.color === 'choice')).toHaveLength(9);
  });

  it('preserves the audited correction: tier-three four-point jewels have no crowns', () => {
    const cards = JEWEL_CARDS.filter(card => card.level === 3 && card.points === 4);
    expect(cards).toHaveLength(5);
    expect(cards.every(card => card.crowns === 0)).toBe(true);
  });

  it('preserves both abilities and the printed score of the eight-red copy card', () => {
    const card = getJewel('j3-11');
    expect(card.cost).toEqual({ white: 0, blue: 0, green: 0, red: 8, black: 0, pearl: 0 });
    expect(card.points).toBe(3);
    expect(card.crowns).toBe(0);
    expect(card.bonus).toEqual({ color: 'choice', amount: 1 });
    expect(card.effects).toEqual(['replay']);
  });

  it('contains one double-bonus jewel in each gem color, all in tier two', () => {
    const cards = JEWEL_CARDS.filter(card => card.bonus?.amount === 2);
    expect(cards.map(card => card.bonus!.color).sort()).toEqual([...GEM_COLORS].sort());
    expect(cards.every(card => card.level === 2)).toBe(true);
  });

  it('has three two-point ability royals and one three-point royal', () => {
    expect(ROYAL_CARDS.filter(card => card.points === 2).map(card => card.effect).sort())
      .toEqual(['privilege', 'replay', 'steal']);
    expect(getRoyal('r4')).toEqual({ id: 'r4', points: 3, effect: null });
  });

  it('rejects unknown IDs instead of silently substituting a card', () => {
    expect(() => getJewel('missing')).toThrow('未知宝石牌');
    expect(() => getRoyal('missing')).toThrow('未知王室牌');
  });
});
