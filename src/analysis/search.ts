import { applyAction, getLegalActions } from '../game/engine';
import { LEVELS, TOKEN_COLORS, type Action, type GameState, type PlayerId } from '../game/types';

export interface SearchOptions {
  iterations?: number;
  treeDepth?: number;
  rolloutDepth?: number;
  exploration?: number;
  seed?: number;
  /** Optional wall-clock guard. Omit for deterministic tests and comparisons. */
  maxMilliseconds?: number;
}

export interface TacticalAdvice {
  /** Must be a proved winning move, not a heuristic preference. */
  winning?: Action;
  /** Proved immediate losing moves. Unknown moves must remain searchable. */
  losing?: Action[];
}

export interface SearchHooks {
  policy: (state: GameState, random: () => number) => Action | null;
  actions?: (state: GameState) => Action[];
  /** Nonnegative weights, not win probabilities. Computed once per decision node. */
  prior?: (state: GameState, actions: Action[]) => number[];
  /** Player 0's heuristic value at an unfinished leaf. Never counted as a winner. */
  cutoffValue?: (state: GameState) => number;
  /** Advice must not inspect unrevealed deck order/RNG. Use a small bounded probe. */
  tactics?: (state: GameState) => TacticalAdvice;
}

export interface SearchActionResult {
  action: Action;
  visits: number;
  /** Search value for the ROOT player, including explicitly counted heuristic leaves. */
  value: number | null;
  /** Actual terminal outcomes only, always ordered [player 0, player 1]. */
  terminalWins: [number, number];
  cutoffs: number;
  /** Distinct revealed positions following this action (chance outcomes). */
  outcomes: number;
}

export interface SearchResult {
  action: Action | null;
  actions: SearchActionResult[];
  iterations: number;
  nodes: number;
  terminalWins: [number, number];
  cutoffs: number;
  provenWinner: PlayerId | null;
}

interface Edge {
  action: Action;
  prior: number;
  visits: number;
  sum: number;
  terminalWins: [number, number];
  cutoffs: number;
  outcomes: Map<string, Node>;
}
interface Node { turn: PlayerId; visits: number; edges: Edge[]; winning: Edge | null }

const integer = (value: number | undefined, fallback: number, max: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value!))) : fallback;
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : .5));

function rng(seed: number): () => number {
  let value = seed || 1;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return ((value >>> 0) + .5) / 4294967296;
  };
}

function shuffle<T>(values: T[], random: () => number) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}

/** Ignore order, original RNG, names, log and turn/revision counters. */
export function searchPositionKey(state: GameState): string {
  return JSON.stringify({
    turn: state.turn, phase: state.phase, board: state.board, market: state.market,
    players: state.players.map(({ name: _name, ...player }) => player),
    decks: LEVELS.map(level => [...state.decks[level]].sort()), bag: [...state.bag].sort(),
    royals: state.royals, privilegeSupply: state.privilegeSupply,
    pending: state.pending, effects: state.effects, extraTurns: state.extraTurns,
    winner: state.winner,
  });
}

export function searchActionKey(action: Action): string {
  if (action.type === 'buy') return JSON.stringify({ type: action.type, source: action.source, payment: action.payment ? TOKEN_COLORS.map(color => action.payment![color]) : null });
  if (action.type === 'discard') return JSON.stringify({ type: action.type, tokens: TOKEN_COLORS.map(color => action.tokens[color]) });
  if (action.type === 'takeTokens') return JSON.stringify({ type: action.type, indices: [...action.indices].sort((a, b) => a - b) });
  return JSON.stringify(action);
}

function samplePosition(canonical: GameState, random: () => number): GameState {
  const state = structuredClone(canonical);
  for (const level of LEVELS) shuffle(state.decks[level], random);
  shuffle(state.bag, random);
  state.rng = Math.floor(random() * 0xffffffff) + 1;
  return state;
}

function canonicalPosition(position: GameState): GameState {
  const state = structuredClone(position);
  for (const level of LEVELS) state.decks[level].sort();
  state.bag.sort(); state.rng = 1; state.seed = ''; state.log = [];
  return state;
}

function createNode(state: GameState, hooks: SearchHooks): Node {
  const advice = hooks.tactics?.(state);
  let actions = (hooks.actions ?? getLegalActions)(state);
  if (advice?.losing?.length) {
    const losing = new Set(advice.losing.map(searchActionKey));
    const filtered = actions.filter(action => !losing.has(searchActionKey(action)));
    if (filtered.length) actions = filtered;
  }
  const unique = new Map(actions.map(action => [searchActionKey(action), action]));
  actions = [...unique.values()];
  const supplied = hooks.prior?.(state, actions);
  const weights = actions.map((_, index) => {
    const value = supplied?.[index];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  const edges: Edge[] = actions.map((action, index) => ({
    action, prior: total > 0 ? .98 * weights[index] / total + .02 / actions.length : 1 / actions.length,
    visits: 0, sum: 0, terminalWins: [0, 0], cutoffs: 0, outcomes: new Map(),
  }));
  const winning = advice?.winning ? edges.find(edge => searchActionKey(edge.action) === searchActionKey(advice.winning!)) ?? null : null;
  return { turn: state.turn, visits: 0, edges, winning };
}

function selectEdge(node: Node, exploration: number, random: () => number): Edge | null {
  if (node.winning) return node.winning;
  let best: Edge | null = null;
  let bestScore = -Infinity;
  for (const edge of node.edges) {
    const p0 = edge.visits ? edge.sum / edge.visits : .5;
    const value = node.turn === 0 ? p0 : 1 - p0;
    const score = value + exploration * edge.prior * Math.sqrt(node.visits + 1) / (1 + edge.visits) + random() * 1e-9;
    if (score > bestScore) { bestScore = score; best = edge; }
  }
  return best;
}

function transition(state: GameState, action: Action): GameState {
  const result = applyAction(state, action);
  if (!result.ok) throw new Error(`MCTS 产生非法行动：${action.type}，${result.error}`);
  result.state.log = [];
  return result.state;
}

/**
 * PUCT over decision nodes with separate sampled outcome branches beneath each action.
 * Each simulation resamples the unknown future. Decisions are shared across futures
 * with the same revealed position, never conditioned on the stored deck top.
 * This is post-game, full-reserved-card analysis, NOT an imperfect-information solver.
 * Adaptive tree samples/leaf heuristics are search diagnostics, not calibrated odds.
 */
export function searchMcts(position: GameState, options: SearchOptions, hooks: SearchHooks): SearchResult {
  const iterations = integer(options.iterations, 48, 4096);
  const treeDepth = Math.max(1, integer(options.treeDepth, 10, 128));
  const rolloutDepth = integer(options.rolloutDepth, 24, 2000);
  const exploration = Number.isFinite(options.exploration) ? Math.max(0, Math.min(20, options.exploration!)) : 1.6;
  const random = rng((options.seed ?? 0x91c7a52) >>> 0);
  const budget = Number.isFinite(options.maxMilliseconds) ? Math.max(0, options.maxMilliseconds!) : Infinity;
  const started = performance.now();
  if (position.winner !== null) return { action: null, actions: [], iterations: 0, nodes: 0, terminalWins: [0, 0], cutoffs: 0, provenWinner: position.winner };
  const canonical = canonicalPosition(position);
  // Hooks see the same canonical order at the root on every call. They must not use it.
  const root = createNode(canonical, hooks);
  const terminalWins: [number, number] = [0, 0];
  let nodes = 1, cutoffs = 0, completedIterations = 0;
  if (!root.edges.length) return { action: null, actions: [], iterations: 0, nodes, terminalWins, cutoffs, provenWinner: null };
  if (root.winning) return {
    action: root.winning.action,
    actions: root.edges.map(edge => ({ action: edge.action, visits: 0, value: edge === root.winning ? 1 : null, terminalWins: [0, 0], cutoffs: 0, outcomes: 0 })),
    iterations: 0, nodes, terminalWins, cutoffs, provenWinner: position.turn,
  };

  for (let iteration = 0; iteration < iterations; iteration++) {
    if (performance.now() - started >= budget) break;
    let state = samplePosition(canonical, random);
    let node = root;
    const path: { node: Node; edge: Edge }[] = [];
    let depth = 0;
    while (state.winner === null && depth < treeDepth) {
      const edge = selectEdge(node, exploration, random);
      if (!edge) break;
      path.push({ node, edge });
      state = transition(state, edge.action); depth++;
      if (state.winner !== null) break;
      const key = searchPositionKey(state);
      const existing = edge.outcomes.get(key);
      if (existing) { node = existing; continue; }
      if (depth < treeDepth) {
        const child = createNode(state, hooks);
        edge.outcomes.set(key, child); nodes++; node = child;
      }
      break;
    }
    for (let step = 0; state.winner === null && step < rolloutDepth; step++) {
      const action = hooks.policy(state, random);
      if (!action) break;
      state = transition(state, action);
    }
    const winner = state.winner;
    const value = winner !== null ? Number(winner === 0) : clamp(hooks.cutoffValue?.(state) ?? .5);
    if (winner !== null) terminalWins[winner]++; else cutoffs++;
    for (const { node: visited, edge } of path) {
      visited.visits++; edge.visits++; edge.sum += value;
      if (winner !== null) edge.terminalWins[winner]++; else edge.cutoffs++;
    }
    completedIterations++;
  }
  const actions: SearchActionResult[] = root.edges.map(edge => ({
    action: edge.action, visits: edge.visits,
    value: edge.visits ? (position.turn === 0 ? edge.sum / edge.visits : 1 - edge.sum / edge.visits) : null,
    terminalWins: [...edge.terminalWins], cutoffs: edge.cutoffs, outcomes: edge.outcomes.size,
  }));
  // Most-visited choice is a policy decision. Visit share is never called a win rate.
  const best = root.edges.reduce((best, edge) => edge.visits > best.visits || (edge.visits === best.visits && edge.prior > best.prior) ? edge : best);
  return { action: best.action, actions, iterations: completedIterations, nodes, terminalWins, cutoffs, provenWinner: null };
}
