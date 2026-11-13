import type { Effect, GemColor, JewelCard, Level, RoyalCard } from './types';

// Costs are ordered white, blue, green, red, black, pearl.
// IDs preserve the level and card index from the audited source table.
// Data provenance, image checks and the upstream MIT license are in THIRD_PARTY_NOTICES.md.
type CostRow = [number, number, number, number, number, number];

function jewel(
  id: string,
  level: Level,
  color: GemColor | 'choice' | null,
  amount: number,
  points: number,
  crowns: number,
  [white, blue, green, red, black, pearl]: CostRow,
  effects: Effect[] = [],
): JewelCard {
  return {
    id, level, points, crowns,
    cost: { white, blue, green, red, black, pearl },
    bonus: color === null ? null : { color, amount },
    effects,
  };
}

export const JEWEL_CARDS: JewelCard[] = [
  jewel('j1-01', 1, 'white', 1, 0, 0, [0, 1, 1, 1, 1, 0]),
  jewel('j1-02', 1, 'white', 1, 0, 1, [0, 3, 0, 0, 0, 0]),
  jewel('j1-03', 1, 'white', 1, 0, 0, [0, 2, 2, 0, 0, 1], ['replay']),
  jewel('j1-04', 1, 'white', 1, 0, 0, [0, 0, 0, 2, 2, 0], ['drawGem']),
  jewel('j1-05', 1, 'white', 1, 1, 0, [0, 0, 2, 3, 0, 0]),
  jewel('j1-06', 1, 'blue', 1, 0, 0, [1, 0, 1, 1, 1, 0]),
  jewel('j1-07', 1, 'blue', 1, 0, 1, [0, 0, 3, 0, 0, 0]),
  jewel('j1-08', 1, 'blue', 1, 0, 0, [0, 0, 2, 2, 0, 1], ['replay']),
  jewel('j1-09', 1, 'blue', 1, 0, 0, [2, 0, 0, 0, 2, 0], ['drawGem']),
  jewel('j1-10', 1, 'blue', 1, 1, 0, [0, 0, 0, 2, 3, 0]),
  jewel('j1-11', 1, 'green', 1, 0, 0, [1, 1, 0, 1, 1, 0]),
  jewel('j1-12', 1, 'green', 1, 0, 1, [0, 0, 0, 3, 0, 0]),
  jewel('j1-13', 1, 'green', 1, 0, 0, [0, 0, 0, 2, 2, 1], ['replay']),
  jewel('j1-14', 1, 'green', 1, 0, 0, [2, 2, 0, 0, 0, 0], ['drawGem']),
  jewel('j1-15', 1, 'green', 1, 1, 0, [3, 0, 0, 0, 2, 0]),
  jewel('j1-16', 1, 'black', 1, 0, 0, [1, 1, 1, 1, 0, 0]),
  jewel('j1-17', 1, 'black', 1, 0, 1, [3, 0, 0, 0, 0, 0]),
  jewel('j1-18', 1, 'black', 1, 0, 0, [2, 2, 0, 0, 0, 1], ['replay']),
  jewel('j1-19', 1, 'black', 1, 0, 0, [0, 0, 2, 2, 0, 0], ['drawGem']),
  jewel('j1-20', 1, 'black', 1, 1, 0, [0, 2, 3, 0, 0, 0]),
  jewel('j1-21', 1, 'red', 1, 0, 0, [1, 1, 1, 0, 1, 0]),
  jewel('j1-22', 1, 'red', 1, 0, 1, [0, 0, 0, 0, 3, 0]),
  jewel('j1-23', 1, 'red', 1, 0, 0, [2, 0, 0, 0, 2, 1], ['replay']),
  jewel('j1-24', 1, 'red', 1, 0, 0, [0, 2, 2, 0, 0, 0], ['drawGem']),
  jewel('j1-25', 1, 'red', 1, 1, 0, [2, 3, 0, 0, 0, 0]),
  jewel('j1-26', 1, 'choice', 1, 1, 0, [0, 0, 0, 0, 4, 1]),
  jewel('j1-27', 1, 'choice', 1, 0, 1, [4, 0, 0, 0, 0, 1]),
  jewel('j1-28', 1, null, 0, 3, 0, [0, 0, 0, 4, 0, 1]),
  jewel('j1-29', 1, 'choice', 1, 1, 0, [0, 2, 0, 2, 1, 1]),
  jewel('j1-30', 1, 'choice', 1, 1, 0, [2, 0, 2, 0, 1, 1]),

  jewel('j2-01', 2, 'white', 1, 2, 1, [0, 0, 2, 2, 2, 1]),
  jewel('j2-02', 2, 'white', 1, 1, 0, [0, 4, 0, 3, 0, 0], ['steal']),
  jewel('j2-03', 2, 'white', 1, 2, 0, [4, 0, 0, 0, 2, 1], ['privilege']),
  jewel('j2-04', 2, 'white', 2, 1, 0, [0, 5, 2, 0, 0, 0]),
  jewel('j2-05', 2, 'blue', 1, 2, 1, [2, 0, 0, 2, 2, 1]),
  jewel('j2-06', 2, 'blue', 1, 1, 0, [0, 0, 4, 0, 3, 0], ['steal']),
  jewel('j2-07', 2, 'blue', 1, 2, 0, [2, 4, 0, 0, 0, 1], ['privilege']),
  jewel('j2-08', 2, 'blue', 2, 1, 0, [0, 0, 5, 2, 0, 0]),
  jewel('j2-09', 2, 'green', 1, 2, 1, [2, 2, 0, 0, 2, 1]),
  jewel('j2-10', 2, 'green', 1, 1, 0, [3, 0, 0, 4, 0, 0], ['steal']),
  jewel('j2-11', 2, 'green', 1, 2, 0, [0, 2, 4, 0, 0, 1], ['privilege']),
  jewel('j2-12', 2, 'green', 2, 1, 0, [0, 0, 0, 5, 2, 0]),
  jewel('j2-13', 2, 'black', 1, 2, 1, [0, 2, 2, 2, 0, 1]),
  jewel('j2-14', 2, 'black', 1, 1, 0, [4, 0, 3, 0, 0, 0], ['steal']),
  jewel('j2-15', 2, 'black', 1, 2, 0, [0, 0, 0, 2, 4, 1], ['privilege']),
  jewel('j2-16', 2, 'black', 2, 1, 0, [5, 2, 0, 0, 0, 0]),
  jewel('j2-17', 2, 'red', 1, 2, 1, [2, 2, 2, 0, 0, 1]),
  jewel('j2-18', 2, 'red', 1, 1, 0, [0, 3, 0, 0, 4, 0], ['steal']),
  jewel('j2-19', 2, 'red', 1, 2, 0, [0, 0, 2, 4, 0, 1], ['privilege']),
  jewel('j2-20', 2, 'red', 2, 1, 0, [2, 0, 0, 0, 5, 0]),
  jewel('j2-21', 2, 'choice', 1, 2, 0, [0, 0, 6, 0, 0, 1]),
  jewel('j2-22', 2, 'choice', 1, 0, 2, [0, 0, 6, 0, 0, 1]),
  jewel('j2-23', 2, 'choice', 1, 0, 2, [0, 6, 0, 0, 0, 1]),
  jewel('j2-24', 2, null, 0, 5, 0, [0, 6, 0, 0, 0, 1]),

  jewel('j3-01', 3, 'white', 1, 3, 2, [0, 3, 0, 5, 3, 1]),
  jewel('j3-02', 3, 'white', 1, 4, 0, [6, 2, 0, 0, 2, 0]),
  jewel('j3-03', 3, 'blue', 1, 3, 2, [3, 0, 3, 0, 5, 1]),
  jewel('j3-04', 3, 'blue', 1, 4, 0, [2, 6, 2, 0, 0, 0]),
  jewel('j3-05', 3, 'green', 1, 3, 2, [5, 3, 0, 3, 0, 1]),
  jewel('j3-06', 3, 'green', 1, 4, 0, [0, 2, 6, 2, 0, 0]),
  jewel('j3-07', 3, 'black', 1, 3, 2, [3, 0, 5, 3, 0, 1]),
  jewel('j3-08', 3, 'black', 1, 4, 0, [2, 0, 0, 2, 6, 0]),
  jewel('j3-09', 3, 'red', 1, 3, 2, [0, 5, 3, 0, 3, 1]),
  jewel('j3-10', 3, 'red', 1, 4, 0, [0, 0, 2, 6, 2, 0]),
  jewel('j3-11', 3, 'choice', 1, 3, 0, [0, 0, 0, 8, 0, 0], ['replay']),
  jewel('j3-12', 3, 'choice', 1, 0, 3, [0, 0, 0, 0, 8, 0]),
  jewel('j3-13', 3, null, 0, 6, 0, [8, 0, 0, 0, 0, 0]),
];

export const ROYAL_CARDS: RoyalCard[] = [
  { id: 'r1', points: 2, effect: 'steal' },
  { id: 'r2', points: 2, effect: 'replay' },
  { id: 'r3', points: 2, effect: 'privilege' },
  { id: 'r4', points: 3, effect: null },
];

const jewelById = new Map(JEWEL_CARDS.map(card => [card.id, card]));
const royalById = new Map(ROYAL_CARDS.map(card => [card.id, card]));

export function getJewel(id: string): JewelCard {
  const card = jewelById.get(id);
  if (!card) throw new Error(`未知宝石牌：${id}`);
  return card;
}

export function getRoyal(id: string): RoyalCard {
  const card = royalById.get(id);
  if (!card) throw new Error(`未知王室牌：${id}`);
  return card;
}
