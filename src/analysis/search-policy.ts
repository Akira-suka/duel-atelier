import { applyAction, getLegalActions, getStats } from '../game/engine';
import { GEM_COLORS, type Action, type GameState, type PlayerId } from '../game/types';
import { chooseSimulationAction, policyPriors, positionSeed, randomizeFuture, resourcePotential, sampleSeed, summarizeEstimate, type AnalysisOptions, type PlayoutResult, type WinEstimate } from './win-probability';
import { searchMcts } from './search';
import { analyzeTactics, enumerateTacticalActions, findImmediateWin, tacticalActionKey } from './tactics';

export interface PolicyOptions { iterations?: number; seed?: number }
export interface SearchAnalysisOptions extends AnalysisOptions { searchIterations?: number }
const budget = (value: number | undefined, fallback: number, maximum: number) =>
  Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
const finiteSeed = (value: number | undefined, fallback = 0x5eeda11) =>
  Number.isFinite(value) ? value! >>> 0 : fallback >>> 0;
export function analysisRandom(seed: number) {
  let value = finiteSeed(seed) || 1;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return ((value >>> 0) + .5) / 4294967296; };
}
const progress = (state: GameState, id: PlayerId) => {
  const stats = getStats(state, id);
  return Math.max(stats.points / 20, stats.crowns / 10, ...GEM_COLORS.map(color => stats.colorPoints[color] / 10));
};

/** A leaf ordering heuristic. Only real terminal outcomes are used in displayed odds. */
export function searchLeafValue(state: GameState): number {
  if (state.winner !== null) return Number(state.winner === 0);
  const strength = (id: PlayerId) => {
    const stats = getStats(state, id);
    const lead = Math.max(stats.points / 20, stats.crowns / 10, ...GEM_COLORS.map(color => stats.colorPoints[color] / 10));
    const economy = GEM_COLORS.reduce((sum, color) => sum + Math.log1p(stats.bonuses[color]), 0);
    return lead * lead * 9 + stats.points * .13 + stats.crowns * .18 + economy * .85
      + resourcePotential(state, id) * .16 + state.players[id].privileges * .25 + Number(state.turn === id) * .18;
  };
  return 1 / (1 + Math.exp((strength(1) - strength(0)) * .65));
}

export function chooseSearchAction(state: GameState, random: () => number, options: PolicyOptions = {}): Action | null {
  if (state.winner !== null) return null;
  const ownProgress = progress(state, state.turn), opponentProgress = progress(state, state.turn === 0 ? 1 : 0);
  if (ownProgress >= .5 || state.phase === 'effect') {
    const immediate = findImmediateWin(state, { maxNodes: 80, maxDepth: 12, maxActions: 192 });
    if (immediate.status === 'win' && immediate.action) return immediate.action;
  }
  let rootActions = enumerateTacticalActions(state, { maxActions: 192 }).actions;
  if (!rootActions.length) return null;
  if (opponentProgress >= .6) {
    const advice = analyzeTactics(state, { maxNodes: 192, maxDepth: 12, maxActions: 192 });
    if (advice.winningAction) return advice.winningAction;
    const losing = new Set(advice.losingActions.map(tacticalActionKey));
    const remaining = rootActions.filter(action => !losing.has(tacticalActionKey(action)));
    if (remaining.length) rootActions = remaining;
  }
  if (rootActions.length === 1) return rootActions[0];
  const iterations = budget(options.iterations, 24, 256);
  const seed = Number.isFinite(options.seed) ? finiteSeed(options.seed) : finiteSeed(Math.floor(random() * 0xffffffff));
  const result = searchMcts(state, { iterations, treeDepth: 6, rolloutDepth: 0, seed }, {
    policy: chooseSimulationAction,
    actions: position => position.revision === state.revision ? rootActions : getLegalActions(position),
    prior: policyPriors,
    cutoffValue: searchLeafValue,
  });
  return result.action;
}

export function runSearchPlayout(position: GameState, seed: number, maxActions = 600, searchIterations = 8): PlayoutResult {
  seed = finiteSeed(seed);
  maxActions = budget(maxActions, 600, 2000);
  searchIterations = budget(searchIterations, 8, 256);
  let state = randomizeFuture(position, seed);
  const random = analysisRandom(seed ^ 0xa5a5a5a5);
  let actions = 0;
  while (state.winner === null && actions < maxActions) {
    const action = chooseSearchAction(state, random, { iterations: searchIterations });
    if (!action) break;
    const result = applyAction(state, action);
    if (!result.ok) throw new Error(`搜索续弈产生非法行动：${result.error}`);
    state = result.state; state.log = []; actions++;
  }
  return { winner: state.winner, actions };
}

export function estimateSearchWinProbability(state: GameState, options: SearchAnalysisOptions = {}): WinEstimate {
  if (state.winner !== null) return summarizeEstimate(state, [0, 0], 0, 0);
  const samples = budget(options.samples, 24, 512);
  const maxActions = budget(options.maxActions, 600, 2000);
  const seed = positionSeed(state, finiteSeed(options.seed));
  const wins: [number, number] = [0, 0]; let unfinished = 0;
  for (let sample = 0; sample < samples; sample++) {
    const result = runSearchPlayout(state, sampleSeed(seed, sample), maxActions, options.searchIterations ?? 8);
    if (result.winner === null) unfinished++; else wins[result.winner]++;
  }
  return summarizeEstimate(state, wins, unfinished, samples);
}
