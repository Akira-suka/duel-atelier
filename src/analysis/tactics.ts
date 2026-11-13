import { getJewel, getRoyal } from '../game/catalog';
import { applyAction, emptyWallet, getDiscountedCost, getLegalActions, getStats } from '../game/engine';
import { COST_COLORS, GEM_COLORS, TOKEN_COLORS, type Action, type CardSource, type GameState, type PlayerId, type Wallet } from '../game/types';

export interface TacticalOptions { maxNodes?: number; maxDepth?: number; maxActions?: number }
export interface TacticalActions { actions: Action[]; complete: boolean }
export interface ImmediateWinResult {
  /** none excludes a win only before the current player next hands control over. */
  status: 'win' | 'none' | 'unknown';
  action?: Action;
  line: Action[];
  nodes: number;
  complete: boolean;
}
export interface TacticalResult {
  /** forcedLoss concerns this tactical window, never an unsearched whole game. */
  status: 'win' | 'forcedLoss' | 'unknown';
  winningAction?: Action;
  winningLine: Action[];
  losingActions: Action[];
  /** Has a continuation avoiding an opponent win before control returns. */
  safeActions: Action[];
  unknownActions: Action[];
  nodes: number;
  complete: boolean;
}

const bound = (value: number | undefined, fallback: number, maximum: number) =>
  Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
const settings = (options: TacticalOptions) => ({
  maxNodes: bound(options.maxNodes, 320, 20000),
  maxDepth: bound(options.maxDepth, 12, 48),
  maxActions: bound(options.maxActions, 1024, 4096),
});
const walletKey = (wallet: Wallet | undefined) => wallet ? TOKEN_COLORS.map(color => wallet[color]) : null;
const sourceKey = (source: CardSource) => [source.kind, 'level' in source ? source.level : null, 'index' in source ? source.index : null];

/** Stable across object property order, including non-default payments. */
export function tacticalActionKey(action: Action): string {
  switch (action.type) {
    case 'buy': return JSON.stringify([action.type, sourceKey(action.source), walletKey(action.payment)]);
    case 'reserve': return JSON.stringify([action.type, sourceKey(action.source), action.goldIndex]);
    case 'takeTokens': return JSON.stringify([action.type, [...action.indices].sort((a, b) => a - b)]);
    case 'discard': return JSON.stringify([action.type, walletKey(action.tokens)]);
    case 'chooseColor': case 'stealToken': return JSON.stringify([action.type, action.color]);
    case 'chooseRoyal': return JSON.stringify([action.type, action.cardId]);
    case 'usePrivilege': case 'takeBonusToken': return JSON.stringify([action.type, action.index]);
    case 'refill': return action.type;
  }
}

function cardAt(state: GameState, source: CardSource): string | undefined {
  if (source.kind === 'market') return state.market[source.level][source.index] ?? undefined;
  if (source.kind === 'reserve') return state.players[state.turn].reserved[source.index];
  return undefined; // The hidden deck top is deliberately never read.
}

function alreadyAtThreshold(state: GameState): boolean {
  const stats = getStats(state, state.turn);
  return stats.points >= 20 || stats.crowns >= 10 || GEM_COLORS.some(color => stats.colorPoints[color] >= 10);
}

function priority(state: GameState, action: Action): number {
  if (action.type === 'buy') {
    const card = getJewel(cardAt(state, action.source)!);
    const stats = getStats(state, state.turn);
    const colors = card.bonus?.color === 'choice' ? GEM_COLORS.filter(color => stats.bonuses[color] > 0) : card.bonus ? [card.bonus.color] : [];
    const winning = stats.points + card.points >= 20 || stats.crowns + card.crowns >= 10
      || colors.some(color => stats.colorPoints[color] + card.points >= 10);
    return (winning ? 1000 : 30) + card.points * 3 + card.crowns * 2 + (card.effects.includes('replay') ? 12 : 0);
  }
  if (action.type === 'chooseRoyal') return 50 + getRoyal(action.cardId).points;
  if (action.type === 'chooseColor') return 50 + getStats(state, state.turn).colorPoints[action.color];
  if (action.type === 'usePrivilege') return 20;
  if (action.type === 'refill') return -10;
  if (action.type === 'reserve') return -5;
  return 0;
}

/** Full legal payment/discard choices, with an explicit completeness flag on truncation. */
export function enumerateTacticalActions(state: GameState, options: Pick<TacticalOptions, 'maxActions'> = {}): TacticalActions {
  const limit = bound(options.maxActions, 1024, 4096);
  const base = getLegalActions(state);
  const scores = new Map(base.map(action => [action, priority(state, action)]));
  base.sort((a, b) => scores.get(b)! - scores.get(a)!);
  const actions: Action[] = [];
  const seen = new Set<string>();
  let complete = true;
  const add = (action: Action) => {
    const key = tacticalActionKey(action);
    if (seen.has(key)) return;
    if (actions.length >= limit) { complete = false; return; }
    seen.add(key); actions.push(action);
  };
  for (const action of base) add(action);
  if (!complete) return { actions, complete };
  const wallet = state.players[state.turn].tokens;
  if (state.pending?.kind === 'discard') {
    const tokens = emptyWallet();
    const enumerate = (index: number, remaining: number) => {
      if (!complete) return;
      if (index === TOKEN_COLORS.length) {
        if (!remaining) add({ type: 'discard', tokens: { ...tokens } });
        return;
      }
      const color = TOKEN_COLORS[index];
      for (let count = 0; count <= Math.min(wallet[color], remaining) && complete; count++) {
        tokens[color] = count; enumerate(index + 1, remaining - count);
      }
      tokens[color] = 0;
    };
    enumerate(0, state.pending.count);
  } else {
    for (const action of base) if (action.type === 'buy' && complete && wallet.gold > 0) {
      const cost = getDiscountedCost(state, state.turn, cardAt(state, action.source)!);
      const payment = emptyWallet();
      const enumerate = (index: number, gold: number) => {
        if (!complete || gold > wallet.gold) return;
        if (index === COST_COLORS.length) {
          payment.gold = gold; add({ type: 'buy', source: action.source, payment: { ...payment } }); return;
        }
        const color = COST_COLORS[index];
        const minimum = Math.max(0, cost[color] - (wallet.gold - gold));
        for (let count = Math.min(cost[color], wallet[color]); count >= minimum && complete; count--) {
          payment[color] = count; enumerate(index + 1, gold + cost[color] - count);
        }
        payment[color] = 0;
      };
      enumerate(0, 0);
    }
  }
  return { actions, complete };
}

interface Position { state: GameState; hiddenMarket: boolean }
interface Budget { nodes: number; exhausted: boolean; maxNodes: number; maxDepth: number; maxActions: number }
interface Proof { status: 'win' | 'none' | 'unknown'; line: Action[] }

/**
 * Suppress a market replacement instead of examining the stored deck top. The
 * unrevealed card stays in its hidden pool and its public slot is left empty.
 * This is a conservative proof position, never a playable/persisted game state.
 * A known winning continuation is valid for every replacement; failure to find
 * one after a replacement cannot exclude wins through the unknown new card.
 */
function deterministicStep(position: Position, action: Action): Position | null {
  if (action.type === 'refill' || (action.type === 'reserve' && action.source.kind === 'deck')) return null;
  const state = position.state;
  const source = action.type === 'buy' || action.type === 'reserve' ? action.source : null;
  const replaces = source?.kind === 'market' && state.decks[source.level].length > 0;
  let input = state;
  if (replaces && source?.kind === 'market') {
    input = { ...state, decks: { ...state.decks, [source.level]: [] } };
  }
  const applied = applyAction(input, action);
  if (!applied.ok) throw new Error(`Invalid tactical action: ${applied.error}`);
  if (replaces && source?.kind === 'market') applied.state.decks[source.level] = [...state.decks[source.level]];
  applied.state.log = [];
  return { state: applied.state, hiddenMarket: position.hiddenMarket || replaces };
}

function enter(budget: Budget, depth: number): boolean {
  if (budget.nodes >= budget.maxNodes || depth >= budget.maxDepth) { budget.exhausted = true; return false; }
  budget.nodes++; return true;
}

function cannotWinBeforeHandoff(state: GameState, action: Action, hasBuy: boolean): boolean {
  if (state.extraTurns > 0 || alreadyAtThreshold(state)) return false;
  // These actions add no points/crowns/cards or extra turn. Forced discard also
  // cannot change a win threshold, so it need not expand every return choice.
  if (action.type === 'takeTokens' || action.type === 'reserve') return true;
  // Refill grants no resource to the actor and ends their privilege phase.
  return action.type === 'refill' && !hasBuy;
}

function immediate(position: Position, actor: PlayerId, budget: Budget, depth: number): Proof {
  const state = position.state;
  if (state.winner !== null) return { status: state.winner === actor ? 'win' : 'none', line: [] };
  if (state.turn !== actor) return { status: 'none', line: [] };
  if (!enter(budget, depth)) return { status: 'unknown', line: [] };
  const generated = enumerateTacticalActions(state, budget);
  const hasBuy = generated.actions.some(action => action.type === 'buy');
  let unknown = !generated.complete || (position.hiddenMarket && !state.pending);
  for (const action of generated.actions) {
    if (cannotWinBeforeHandoff(state, action, hasBuy)) continue;
    if (budget.nodes >= budget.maxNodes) { budget.exhausted = true; unknown = true; break; }
    const next = deterministicStep(position, action);
    if (!next) { unknown = true; continue; }
    const result = immediate(next, actor, budget, depth + 1);
    if (result.status === 'win') return { status: 'win', line: [action, ...result.line] };
    if (result.status === 'unknown') unknown = true;
  }
  return { status: unknown ? 'unknown' : 'none', line: [] };
}

/** Low-budget entry for rollouts; a win is certified even if other branches were not searched. */
export function findImmediateWin(state: GameState, options: TacticalOptions = {}): ImmediateWinResult {
  const budget: Budget = { ...settings(options), nodes: 0, exhausted: false };
  const result = immediate({ state, hiddenMarket: false }, state.turn, budget, 0);
  return { ...result, action: result.line[0], nodes: budget.nodes, complete: result.status !== 'unknown' };
}

type Defense = 'win' | 'safe' | 'loss' | 'unknown';
interface DefenseProof { status: Defense; line: Action[] }

function defense(position: Position, actor: PlayerId, opponentMoved: boolean, budget: Budget, depth: number): DefenseProof {
  const state = position.state;
  if (state.winner !== null) return { status: state.winner === actor ? 'win' : 'loss', line: [] };
  if (state.turn === actor && opponentMoved) return { status: 'safe', line: [] };
  if (!enter(budget, depth)) return { status: 'unknown', line: [] };
  const opponent = state.turn !== actor;
  const generated = enumerateTacticalActions(state, budget);
  const hasBuy = generated.actions.some(action => action.type === 'buy');
  let unknown = !generated.complete || (position.hiddenMarket && !state.pending);
  let safeLine: Action[] | null = null;
  for (const action of generated.actions) {
    if (budget.nodes >= budget.maxNodes) { budget.exhausted = true; unknown = true; break; }
    let result: DefenseProof;
    if (opponent && cannotWinBeforeHandoff(state, action, hasBuy)) result = { status: 'safe', line: [] };
    else {
      const next = deterministicStep(position, action);
      result = next ? defense(next, actor, opponentMoved || opponent, budget, depth + 1) : { status: 'unknown', line: [] };
    }
    if (!opponent && result.status === 'win') return { status: 'win', line: [action, ...result.line] };
    if (opponent && result.status === 'loss') return { status: 'loss', line: [action, ...result.line] };
    if (result.status === 'unknown') unknown = true;
    if (result.status === 'safe' || result.status === 'win') safeLine = [action, ...result.line];
    // The actor can choose a proven defensive continuation; no other choice is forced.
    if (!opponent && safeLine) return { status: 'safe', line: safeLine };
  }
  if (unknown || !generated.actions.length) return { status: 'unknown', line: [] };
  return { status: opponent ? 'safe' : 'loss', line: safeLine ?? [] };
}

/**
 * Classifies root actions through the actor's remaining choices and the opponent's
 * complete next continuous turn (including effects and extra turns). Unknown
 * chance branches or budgets are never promoted to safety or forced loss.
 */
export function analyzeTactics(state: GameState, options: TacticalOptions = {}): TacticalResult {
  const limits = settings(options);
  const budget: Budget = { ...limits, nodes: 0, exhausted: false };
  const generated = enumerateTacticalActions(state, limits);
  const result: TacticalResult = { status: 'unknown', winningLine: [], losingActions: [], safeActions: [], unknownActions: [], nodes: 0, complete: false };
  // Reserve most of the shared budget for checking the opponent's replies.
  const winBudget = { ...budget, maxNodes: Math.max(1, Math.floor(limits.maxNodes / 3)) };
  const win = immediate({ state, hiddenMarket: false }, state.turn, winBudget, 0);
  budget.nodes = winBudget.nodes;
  if (win.status === 'win') {
    return { ...result, status: 'win', winningAction: win.line[0], winningLine: win.line, nodes: budget.nodes, complete: true };
  }
  for (const [index, action] of generated.actions.entries()) {
    if (budget.nodes >= budget.maxNodes) { budget.exhausted = true; result.unknownActions.push(action); continue; }
    const next = deterministicStep({ state, hiddenMarket: false }, action);
    const allowance = Math.max(4, Math.floor((limits.maxNodes - budget.nodes) / (generated.actions.length - index)));
    const branchBudget = { ...budget, maxNodes: Math.min(limits.maxNodes, budget.nodes + allowance) };
    const proof = next ? defense(next, state.turn, next.state.turn !== state.turn, branchBudget, 1) : { status: 'unknown' as const, line: [] };
    budget.nodes = branchBudget.nodes;
    if (proof.status === 'win') {
      return { ...result, status: 'win', winningAction: action, winningLine: [action, ...proof.line], nodes: budget.nodes, complete: true };
    }
    if (proof.status === 'loss') result.losingActions.push(action);
    else if (proof.status === 'safe') result.safeActions.push(action);
    else result.unknownActions.push(action);
  }
  result.nodes = budget.nodes;
  result.complete = generated.complete && result.unknownActions.length === 0;
  if (result.complete && generated.actions.length > 0 && result.losingActions.length === generated.actions.length) result.status = 'forcedLoss';
  return result;
}
