export const GEM_COLORS = ['white', 'blue', 'green', 'red', 'black'] as const;
export const COST_COLORS = [...GEM_COLORS, 'pearl'] as const;
export const TOKEN_COLORS = [...COST_COLORS, 'gold'] as const;
export const LEVELS = [1, 2, 3] as const;

export type GemColor = typeof GEM_COLORS[number];
export type CostColor = typeof COST_COLORS[number];
export type TokenColor = typeof TOKEN_COLORS[number];
export type Level = typeof LEVELS[number];
export type PlayerId = 0 | 1;
export type Cost = Record<CostColor, number>;
export type Wallet = Record<TokenColor, number>;
export type Effect = 'replay' | 'drawGem' | 'privilege' | 'steal';

export interface JewelCard {
  id: string;
  level: Level;
  cost: Cost;
  points: number;
  crowns: number;
  bonus: { color: GemColor | 'choice'; amount: number } | null;
  effects: Effect[];
}

export interface RoyalCard {
  id: string;
  points: number;
  effect: Effect | null;
}

export interface OwnedCard {
  cardId: string;
  color: GemColor | null;
}

export interface PlayerState {
  name: string;
  tokens: Wallet;
  cards: OwnedCard[];
  reserved: string[];
  royals: string[];
  privileges: number;
  royalClaims: (3 | 6)[];
}

export type CardSource =
  | { kind: 'market'; level: Level; index: number }
  | { kind: 'reserve'; index: number }
  | { kind: 'deck'; level: Level };

export type PendingChoice =
  | { kind: 'chooseColor'; cardId: string; colors: GemColor[] }
  | { kind: 'takeBonusToken'; cardId: string; color: GemColor; indices: number[] }
  | { kind: 'stealToken'; colors: CostColor[] }
  | { kind: 'chooseRoyal'; threshold: 3 | 6; cardIds: string[] }
  | { kind: 'discard'; count: number };

export interface EffectTask {
  kind: Effect | 'chooseColor' | 'royal';
  cardId?: string;
  threshold?: 3 | 6;
}

export interface GameState {
  version: 1;
  seed: string;
  rng: number;
  revision: number;
  turn: PlayerId;
  turnNumber: number;
  phase: 'start' | 'main' | 'effect' | 'discard' | 'gameOver';
  players: [PlayerState, PlayerState];
  board: (TokenColor | null)[];
  bag: TokenColor[];
  decks: Record<Level, string[]>;
  market: Record<Level, (string | null)[]>;
  royals: string[];
  privilegeSupply: number;
  extraTurns: number;
  effects: EffectTask[];
  pending: PendingChoice | null;
  winner: PlayerId | null;
  victoryReasons: ('prestige' | 'crowns' | 'color')[];
  log: string[];
}

export type Action =
  | { type: 'usePrivilege'; index: number }
  | { type: 'refill' }
  | { type: 'takeTokens'; indices: number[] }
  | { type: 'reserve'; goldIndex: number; source: CardSource }
  | { type: 'buy'; source: CardSource; payment?: Wallet }
  | { type: 'chooseColor'; color: GemColor }
  | { type: 'takeBonusToken'; index: number }
  | { type: 'stealToken'; color: CostColor }
  | { type: 'chooseRoyal'; cardId: string }
  | { type: 'discard'; tokens: Wallet };

export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string };

export interface PlayerStats {
  points: number;
  crowns: number;
  bonuses: Record<GemColor, number>;
  colorPoints: Record<GemColor, number>;
  tokenCount: number;
}

export const COLOR_NAMES: Record<TokenColor, string> = {
  white: '钻石', blue: '蓝宝石', green: '祖母绿', red: '红宝石',
  black: '缟玛瑙', pearl: '珍珠', gold: '黄金',
};
