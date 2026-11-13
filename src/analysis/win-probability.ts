import { getJewel, getRoyal } from '../game/catalog';
import { applyAction, countTokens, emptyWallet, getLegalActions, getStats } from '../game/engine';
import { COST_COLORS, GEM_COLORS, LEVELS, TOKEN_COLORS, type Action, type CardSource, type GameState, type GemColor, type JewelCard, type PlayerId, type PlayerStats, type Wallet } from '../game/types';

export interface AnalysisOptions { samples?: number; maxActions?: number; seed?: number }
export interface WinEstimate {
  /** Player 0's observed win fraction among completed, policy-driven playouts. */
  probability: number | null;
  /** Wilson 95% sampling interval, widened for every unfinished playout. Not policy error. */
  interval: [number, number];
  wins: [number, number];
  completed: number;
  unfinished: number;
  requested: number;
  terminal: boolean;
}
export interface PlayoutResult { winner: PlayerId | null; actions: number }
export interface AnalysisRequest { type: 'analyze'; id: string; states: GameState[]; options?: AnalysisOptions }
export type AnalysisCommand = AnalysisRequest | { type: 'cancel'; id: string };
export type AnalysisResponse =
  | { type: 'point'; id: string; index: number; estimate: WinEstimate }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; message: string };

export function analysisSettings(options: AnalysisOptions = {}) {
  const limit = (value: number | undefined, fallback: number, maximum: number) => Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
  return { samples: limit(options.samples, 24, 128), maxActions: limit(options.maxActions, 600, 2000), seed: (options.seed ?? 0x5eeda11) >>> 0 };
}

function randomGenerator(seed: number): () => number {
  let value = seed || 1;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return ((value >>> 0) + .5) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

/** Use only this position, never its log, original RNG, future actions or final winner. */
export function positionSeed(state: GameState, base = 0x5eeda11): number {
  const text = JSON.stringify({
    turn: state.turn, phase: state.phase, board: state.board, market: state.market,
    players: state.players.map(({ name: _name, ...player }) => player),
    decks: LEVELS.map(level => [...state.decks[level]].sort()), bag: [...state.bag].sort(),
    royals: state.royals, pending: state.pending, effects: state.effects, extraTurns: state.extraTurns,
    privilegeSupply: state.privilegeSupply,
  });
  let hash = base >>> 0;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function sampleSeed(position: number, index: number): number {
  let seed = (position + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  seed = Math.imul(seed ^ (seed >>> 16), 0x85ebca6b);
  return (seed ^ (seed >>> 13)) >>> 0;
}

/** Canonicalize before shuffling, so even identical seed runs cannot exploit stored order. */
export function randomizeFuture(state: GameState, seed: number): GameState {
  const next = structuredClone(state);
  const random = randomGenerator(seed);
  for (const level of LEVELS) { next.decks[level].sort(); shuffle(next.decks[level], random); }
  next.bag.sort(); shuffle(next.bag, random);
  next.rng = Math.floor(random() * 0xffffffff) + 1;
  next.log = [];
  return next;
}

interface Target { card: JewelCard; source: CardSource; cost: Wallet; value: number }
interface PolicyContext { stats: PlayerStats; opponent: PlayerStats; targets: Target[]; wallet: Wallet; owned: number }

function effectiveColor(card: JewelCard, stats: PlayerStats): GemColor | null {
  if (!card.bonus) return null;
  if (card.bonus.color !== 'choice') return card.bonus.color;
  return GEM_COLORS.filter(color => stats.bonuses[color] > 0)
    .sort((a, b) => stats.colorPoints[b] - stats.colorPoints[a] || stats.bonuses[a] - stats.bonuses[b])[0] ?? null;
}

function cardValue(card: JewelCard, stats: PlayerStats, owned: number): number {
  const color = effectiveColor(card, stats);
  if (card.bonus?.color === 'choice' && color === null) return -20;
  if (stats.points + card.points >= 20 || stats.crowns + card.crowns >= 10 || (color && stats.colorPoints[color] + card.points >= 10)) return 1000;
  const crownReward = [3, 6].filter(threshold => stats.crowns < threshold && stats.crowns + card.crowns >= threshold).length * 3.5;
  const bonus = color ? (card.bonus?.amount ?? 0) * Math.max(.4, 2.7 - stats.bonuses[color] * .45) * Math.max(.55, 1 - owned / 32) : 0;
  const concentration = color ? card.points * stats.colorPoints[color] * .33 : 0;
  return card.points * 1.5 + card.crowns * (1.7 + stats.crowns * .2) + crownReward + bonus + concentration
    + card.effects.reduce((sum, effect) => sum + ({ replay: 2.8, steal: 1.4, privilege: 1.2, drawGem: 1.1 }[effect]), 0);
}

function context(state: GameState): PolicyContext {
  const player = state.players[state.turn];
  const stats = getStats(state, state.turn);
  const targets: Target[] = [];
  const add = (id: string, source: CardSource) => {
    const card = getJewel(id); const cost = emptyWallet();
    for (const color of COST_COLORS) cost[color] = Math.max(0, card.cost[color] - (color === 'pearl' ? 0 : stats.bonuses[color]));
    targets.push({ card, source, cost, value: cardValue(card, stats, player.cards.length) });
  };
  for (const level of LEVELS) state.market[level].forEach((id, index) => { if (id) add(id, { kind: 'market', level, index }); });
  player.reserved.forEach((id, index) => add(id, { kind: 'reserve', index }));
  return { stats, opponent: getStats(state, state.turn === 0 ? 1 : 0), targets, wallet: player.tokens, owned: player.cards.length };
}

function missing(target: Target, wallet: Wallet): number {
  return Math.max(0, COST_COLORS.reduce((sum, color) => sum + Math.max(0, target.cost[color] - wallet[color]), 0) - wallet.gold);
}

/** Value only attainable progress toward visible or currently reserved cards. */
function walletPotential(targets: Target[], wallet: Wallet): number {
  const values = targets.filter(target => target.value > 0).map(target => {
    const deficit = missing(target, wallet);
    return Math.min(18, target.value) / (1 + deficit * .9) + (target.value >= 1000 ? 20 / (1 + deficit * 2) : 0);
  }).sort((a, b) => b - a);
  return (values[0] ?? 0) + (values[1] ?? 0) * .25 + (values[2] ?? 0) * .1;
}

function gainedWallet(state: GameState, action: Action, wallet: Wallet): Wallet {
  const next = { ...wallet };
  if (action.type === 'takeTokens') action.indices.forEach(index => { next[state.board[index]!]++; });
  if (action.type === 'usePrivilege' || action.type === 'takeBonusToken') next[state.board[action.index]!]++;
  if (action.type === 'stealToken') next[action.color]++;
  if (action.type === 'reserve') next.gold++;
  return next;
}

function targetFor(targets: Target[], source: CardSource): Target | undefined {
  return targets.find(target => target.source.kind === source.kind && target.source.kind !== 'deck' && source.kind !== 'deck'
    && target.source.index === source.index && (source.kind !== 'market' || (target.source.kind === 'market' && target.source.level === source.level)));
}

function scoreAction(state: GameState, action: Action, ctx: PolicyContext, potential: number): number {
  const { stats, targets, wallet } = ctx;
  if (action.type === 'buy') {
    const target = targetFor(targets, action.source)!;
    return target.value >= 1000 ? 10000 : 7 + target.value - countTokens(action.payment ?? emptyWallet()) * .3;
  }
  if (action.type === 'chooseColor') {
    const points = state.pending?.kind === 'chooseColor' ? getJewel(state.pending.cardId).points : 0;
    return stats.colorPoints[action.color] + points >= 10 ? 10000 : stats.colorPoints[action.color] * 1.5 + 3 / (1 + stats.bonuses[action.color]);
  }
  if (action.type === 'chooseRoyal') {
    const card = getRoyal(action.cardId);
    return stats.points + card.points >= 20 ? 10000 : card.points * 1.5 + (card.effect ? { replay: 3.5, steal: 1.8, privilege: 1.4, drawGem: 1 }[card.effect] : 0);
  }
  if (action.type === 'refill') {
    const available = state.board.filter(color => color && color !== 'gold').length;
    return available < 3 ? 9 : -3 + (25 - available) * .22;
  }
  if (action.type === 'discard') return 0;
  const gained = gainedWallet(state, action, wallet);
  const improvement = walletPotential(targets, gained) - potential;
  const overflow = Math.max(0, countTokens(gained) - 10);
  if (action.type === 'usePrivilege') return (improvement > .15 && countTokens(wallet) < 10 ? 13 : -3) + improvement * 2 - overflow * 3;
  if (action.type === 'takeBonusToken') return improvement;
  if (action.type === 'stealToken') return improvement + (action.color === 'pearl' ? .6 : .1);
  if (action.type === 'takeTokens') {
    const colors = action.indices.map(index => state.board[index]);
    const penalty = (colors.length === 3 && colors.every(color => color === colors[0])) || colors.filter(color => color === 'pearl').length === 2;
    return 1 + improvement * 2.2 + action.indices.length * .7 - overflow * 1.8 - (penalty ? 1 : 0);
  }
  const target = targetFor(targets, action.source);
  const denial = target && cardValue(target.card, ctx.opponent, state.players[state.turn === 0 ? 1 : 0].cards.length) >= 1000 ? 12 : 0;
  return .3 + improvement * 1.3 + (target ? Math.min(15, target.value) / (4 + missing(target, gained)) : -.6)
    + denial - state.players[state.turn].reserved.length * 1.3 - overflow * 2;
}

/** Both players use the same stochastic, goal-directed policy; no search knows the deck top. */
export function chooseSimulationAction(state: GameState, random: () => number): Action | null {
  const actions = getLegalActions(state);
  if (!actions.length) return null;
  const ctx = context(state);
  if (state.pending?.kind === 'discard') {
    const remaining = { ...ctx.wallet }; const tokens = emptyWallet();
    for (let i = 0; i < state.pending.count; i++) {
      let best = TOKEN_COLORS.find(color => remaining[color] > 0)!; let bestValue = -Infinity;
      for (const color of TOKEN_COLORS) if (remaining[color] > 0) {
        remaining[color]--;
        const value = walletPotential(ctx.targets, remaining) + (color === 'gold' ? -1.8 : color === 'pearl' ? -.3 : 0) + random() * .03;
        remaining[color]++;
        if (value > bestValue) { bestValue = value; best = color; }
      }
      remaining[best]--; tokens[best]++;
    }
    return { type: 'discard', tokens };
  }
  const potential = walletPotential(ctx.targets, ctx.wallet);
  let chosen = actions[0]; let bestScore = -Infinity;
  for (const action of actions) {
    const noise = -Math.log(-Math.log(Math.max(1e-9, Math.min(1 - 1e-9, random())))) * .85;
    const score = scoreAction(state, action, ctx, potential) + noise;
    if (score > bestScore) { bestScore = score; chosen = action; }
  }
  return chosen;
}

export function runPlayout(position: GameState, seed: number, maxActions = 600): PlayoutResult {
  let state = randomizeFuture(position, seed);
  const random = randomGenerator(seed ^ 0xa5a5a5a5);
  let actions = 0;
  while (state.winner === null && actions < maxActions) {
    const action = chooseSimulationAction(state, random);
    if (!action) break;
    const result = applyAction(state, action);
    if (!result.ok) throw new Error(`模拟产生非法行动：${action.type}，${result.error}`);
    state = result.state; state.log = []; actions++;
  }
  return { winner: state.winner, actions };
}

export function summarizeEstimate(state: GameState, wins: [number, number], unfinished: number, requested: number): WinEstimate {
  if (state.phase === 'gameOver' && state.winner !== null) {
    const probability = state.winner === 0 ? 1 : 0;
    return { probability, interval: [probability, probability], wins: [0, 0], completed: 0, unfinished: 0, requested: 0, terminal: true };
  }
  const completed = wins[0] + wins[1]; const total = completed + unfinished;
  if (!completed) return { probability: null, interval: [0, 1], wins: [...wins], completed, unfinished, requested, terminal: false };
  const probability = wins[0] / completed;
  const z = 1.95996398454; const denominator = 1 + z * z / completed;
  const center = (probability + z * z / (2 * completed)) / denominator;
  const radius = z * Math.sqrt(probability * (1 - probability) / completed + z * z / (4 * completed * completed)) / denominator;
  return { probability, interval: [Math.max(0, (center - radius) * completed / total), Math.min(1, ((center + radius) * completed + unfinished) / total)], wins: [...wins], completed, unfinished, requested, terminal: false };
}

export function estimateWinProbability(state: GameState, options: AnalysisOptions = {}): WinEstimate {
  const settings = analysisSettings(options); const wins: [number, number] = [0, 0]; let unfinished = 0;
  if (state.phase === 'gameOver') return summarizeEstimate(state, wins, 0, 0);
  const seed = positionSeed(state, settings.seed);
  for (let i = 0; i < settings.samples; i++) {
    const result = runPlayout(state, sampleSeed(seed, i), settings.maxActions);
    if (result.winner === null) unfinished++; else wins[result.winner]++;
  }
  return summarizeEstimate(state, wins, unfinished, settings.samples);
}
