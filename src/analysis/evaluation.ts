import { getJewel, getRoyal } from '../game/catalog';
import { applyAction, countTokens, createGame, getDiscountedCost, getLegalActions, getStats, validateState } from '../game/engine';
import { COST_COLORS, LEVELS, TOKEN_COLORS, type Action, type GameState, type PlayerId, type Wallet } from '../game/types';

export interface DecisionContext { seed: number; random: () => number; ply: number }
export type DecisionPolicy = (state: GameState, context: DecisionContext) => Action | null;
export interface EvaluationGame {
  state: GameState;
  actions: number;
  milliseconds: number;
  decisionMilliseconds: [number, number];
  decisionCounts: [number, number];
  snapshots: { ply: number; state: GameState }[];
}
export interface GameOptions { seed?: number; maxActions?: number; captureSteps?: readonly number[]; validateEveryStep?: boolean }

export function evaluationSeed(value: string): number {
  let seed = 2166136261;
  for (const character of value) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return (seed >>> 0) || 1;
}

export function evaluationRandom(seed: number): () => number {
  let value = seed || 1;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return ((value >>> 0) + .5) / 4294967296;
  };
}

function valid(state: GameState): void {
  const errors = validateState(state);
  if (errors.length) throw new Error(`Invalid evaluation position: ${errors.join('; ')}`);
}

/** The authoritative state is never passed to an agent, so an agent cannot alter its opponent's position. */
export function playEvaluationGame(initial: GameState, policies: [DecisionPolicy, DecisionPolicy], options: GameOptions = {}): EvaluationGame {
  valid(initial);
  const started = performance.now();
  let state = structuredClone(initial);
  const decisionMilliseconds: [number, number] = [0, 0];
  const decisionCounts: [number, number] = [0, 0];
  const snapshots: EvaluationGame['snapshots'] = [];
  const captures = new Set(options.captureSteps ?? []);
  const base = options.seed ?? evaluationSeed(initial.seed);
  const maxActions = options.maxActions ?? 600;
  if (!Number.isSafeInteger(maxActions) || maxActions < 0) throw new Error('Invalid action budget');
  let actions = 0;
  while (state.winner === null && actions < maxActions) {
    if (captures.has(actions)) snapshots.push({ ply: actions, state: structuredClone(state) });
    const actor = state.turn;
    const seed = evaluationSeed(`${base}:${actor}:${decisionCounts[actor]}`);
    const input = structuredClone(state);
    const decisionStarted = performance.now();
    const action = policies[actor](input, { seed, random: evaluationRandom(seed), ply: actions });
    decisionMilliseconds[actor] += performance.now() - decisionStarted;
    decisionCounts[actor]++;
    if (!action) throw new Error(`Policy returned no action at ply ${actions}`);
    const result = applyAction(state, action);
    if (!result.ok) throw new Error(`Illegal policy action at ply ${actions}: ${result.error}`);
    state = result.state;
    actions++;
    if (options.validateEveryStep !== false) valid(state);
  }
  if (captures.has(actions)) snapshots.push({ ply: actions, state: structuredClone(state) });
  valid(state);
  return { state, actions, milliseconds: performance.now() - started, decisionMilliseconds, decisionCounts, snapshots };
}

export interface ArenaGame {
  pairId: string;
  candidateSeat: PlayerId;
  candidateStarted: boolean;
  winner: 'candidate' | 'baseline' | null;
  actions: number;
  milliseconds: number;
  candidateDecisionMilliseconds: number;
  candidateDecisions: number;
  baselineDecisionMilliseconds: number;
  baselineDecisions: number;
}
export interface ArenaSummary {
  pairs: number; games: number; wins: number; losses: number; unfinished: number;
  completedWinRate: number | null;
  /** Correlated legs are grouped by independent seed; unfinished games allow either outcome. */
  pairedScoreBounds: [number, number];
  pairedHoeffding95: [number, number];
  candidateMeanDecisionMs: number; baselineMeanDecisionMs: number;
  firstPlayer: { wins: number; losses: number; unfinished: number };
  secondPlayer: { wins: number; losses: number; unfinished: number };
}

export function summarizeArena(games: readonly ArenaGame[]): ArenaSummary {
  const groups = new Map<string, ArenaGame[]>();
  for (const game of games) groups.set(game.pairId, [...(groups.get(game.pairId) ?? []), game]);
  for (const pair of groups.values()) {
    if (pair.length !== 2 || new Set(pair.map(game => game.candidateSeat)).size !== 2
      || pair[0].candidateStarted === pair[1].candidateStarted) throw new Error('Arena requires two swapped-seat games per unique seed');
  }
  const wins = games.filter(game => game.winner === 'candidate').length;
  const losses = games.filter(game => game.winner === 'baseline').length;
  const unfinished = games.length - wins - losses;
  const lower = games.length ? wins / games.length : 0;
  const upper = games.length ? (wins + unfinished) / games.length : 1;
  const radius = groups.size ? Math.sqrt(Math.log(40) / (2 * groups.size)) : 1;
  const meanTime = (side: 'candidate' | 'baseline') => {
    const count = games.reduce((sum, game) => sum + game[`${side}Decisions`], 0);
    return count ? games.reduce((sum, game) => sum + game[`${side}DecisionMilliseconds`], 0) / count : 0;
  };
  const seat = (starts: boolean) => ({
    wins: games.filter(game => game.candidateStarted === starts && game.winner === 'candidate').length,
    losses: games.filter(game => game.candidateStarted === starts && game.winner === 'baseline').length,
    unfinished: games.filter(game => game.candidateStarted === starts && game.winner === null).length,
  });
  return { pairs: groups.size, games: games.length, wins, losses, unfinished,
    completedWinRate: wins + losses ? wins / (wins + losses) : null,
    pairedScoreBounds: [lower, upper], pairedHoeffding95: [Math.max(0, lower - radius), Math.min(1, upper + radius)],
    candidateMeanDecisionMs: meanTime('candidate'), baselineMeanDecisionMs: meanTime('baseline'), firstPlayer: seat(true), secondPlayer: seat(false) };
}

/** Each seed starts twice from an identical physical position; only the two algorithms exchange seats. */
export function runPairedArena(seeds: readonly string[], candidate: DecisionPolicy, baseline: DecisionPolicy,
  options: GameOptions & { onGame?: (game: ArenaGame) => void } = {}): { games: ArenaGame[]; summary: ArenaSummary } {
  if (new Set(seeds).size !== seeds.length) throw new Error('Duplicate arena seed');
  const games: ArenaGame[] = [];
  for (const pairId of seeds) {
    const initial = createGame(pairId, ['Seat 0', 'Seat 1']);
    for (const candidateSeat of [0, 1] as const) {
      const result = playEvaluationGame(initial, candidateSeat === 0 ? [candidate, baseline] : [baseline, candidate],
        { ...options, seed: evaluationSeed(`arena:${pairId}`) });
      const other = candidateSeat === 0 ? 1 : 0;
      const game: ArenaGame = { pairId, candidateSeat, candidateStarted: initial.turn === candidateSeat,
        winner: result.state.winner === null ? null : result.state.winner === candidateSeat ? 'candidate' : 'baseline',
        actions: result.actions, milliseconds: result.milliseconds,
        candidateDecisionMilliseconds: result.decisionMilliseconds[candidateSeat], candidateDecisions: result.decisionCounts[candidateSeat],
        baselineDecisionMilliseconds: result.decisionMilliseconds[other], baselineDecisions: result.decisionCounts[other] };
      games.push(game); options.onGame?.(game);
    }
  }
  return { games, summary: summarizeArena(games) };
}

export interface PredictionObservation { gameId: string; probability: number | null; outcome: 0 | 1 }
export interface CalibrationBin { lower: number; upper: number; count: number; weight: number; meanPrediction: number; observedRate: number }
export interface PredictionMetrics {
  total: number; evaluated: number; abstained: number; games: number;
  brier: number | null; logLoss: number | null; accuracyAtHalf: number | null; expectedCalibrationError: number | null;
  calibration: CalibrationBin[];
}

/** Each game has weight one even if a caller supplies several correlated positions from that game. */
export function predictionMetrics(observations: readonly PredictionObservation[], bins = 5): PredictionMetrics {
  if (!Number.isSafeInteger(bins) || bins < 1 || bins > 100) throw new Error('Invalid calibration bin count');
  for (const item of observations) {
    if (!item.gameId || (item.outcome !== 0 && item.outcome !== 1)
      || (item.probability !== null && (!Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1))) throw new Error('Invalid prediction observation');
  }
  const included = observations.filter((item): item is PredictionObservation & { probability: number } => item.probability !== null);
  const counts = new Map<string, number>();
  for (const item of included) counts.set(item.gameId, (counts.get(item.gameId) ?? 0) + 1);
  const buckets = Array.from({ length: bins }, (_, index) => ({ lower: index / bins, upper: (index + 1) / bins, count: 0, weight: 0, meanPrediction: 0, observedRate: 0 }));
  let brier = 0, logLoss = 0, accuracy = 0;
  for (const item of included) {
    const weight = 1 / counts.get(item.gameId)!;
    const clipped = Math.max(1e-12, Math.min(1 - 1e-12, item.probability));
    brier += weight * (item.probability - item.outcome) ** 2;
    logLoss -= weight * (item.outcome * Math.log(clipped) + (1 - item.outcome) * Math.log(1 - clipped));
    accuracy += weight * Number((item.probability >= .5 ? 1 : 0) === item.outcome);
    const bucket = buckets[Math.min(bins - 1, Math.floor(item.probability * bins))];
    bucket.count++; bucket.weight += weight; bucket.meanPrediction += weight * item.probability; bucket.observedRate += weight * item.outcome;
  }
  const calibration = buckets.filter(bucket => bucket.count).map(bucket => ({ ...bucket,
    meanPrediction: bucket.meanPrediction / bucket.weight, observedRate: bucket.observedRate / bucket.weight }));
  const size = counts.size;
  return { total: observations.length, evaluated: included.length, abstained: observations.length - included.length, games: size,
    brier: size ? brier / size : null, logLoss: size ? logLoss / size : null, accuracyAtHalf: size ? accuracy / size : null,
    expectedCalibrationError: size ? calibration.reduce((sum, bucket) => sum + bucket.weight * Math.abs(bucket.meanPrediction - bucket.observedRate), 0) / size : null,
    calibration };
}

export function assertDisjointGameIds(first: readonly string[], second: readonly string[]): void {
  const ids = new Set(first);
  if (second.some(id => ids.has(id))) throw new Error('A game appears in both development and held-out data');
}

/** Independently authored reference opponents, deliberately different from either rollout/search implementation. */
export function referencePolicy(style: 'economy' | 'points' | 'crowns'): DecisionPolicy {
  return (state, { random }) => {
    const actions = getLegalActions(state);
    const actor = state.players[state.turn];
    const stats = getStats(state, state.turn);
    const cardId = (action: Extract<Action, { type: 'buy' | 'reserve' }>) => action.source.kind === 'market'
      ? state.market[action.source.level][action.source.index] : action.source.kind === 'reserve' ? actor.reserved[action.source.index] : null;
    const targets = [...LEVELS.flatMap(level => state.market[level].filter((id): id is string => id !== null)), ...actor.reserved];
    const demands = new Map<typeof COST_COLORS[number], number>();
    const tokenDemand = (color: typeof COST_COLORS[number]) => {
      const cached = demands.get(color);
      if (cached !== undefined) return cached;
      const demand = targets.reduce((value, id) => {
      const cost = getDiscountedCost(state, state.turn, id);
      const missing = COST_COLORS.reduce((sum, key) => sum + Math.max(0, cost[key] - actor.tokens[key]), 0) - actor.tokens.gold;
      return Math.max(value, cost[color] > actor.tokens[color] ? 1 / Math.max(1, missing) : 0);
      }, 0);
      demands.set(color, demand);
      return demand;
    };
    const score = (action: Action): number => {
      if (action.type === 'buy') {
        const card = getJewel(cardId(action)!);
        const color = card.bonus?.color;
        if (stats.points + card.points >= 20 || stats.crowns + card.crowns >= 10
          || (color && color !== 'choice' && stats.colorPoints[color] + card.points >= 10)) return 10000;
        const weights = style === 'points' ? [5, 1, 1] : style === 'crowns' ? [1, 6, 1] : [2, 2, 4];
        return 20 + card.points * weights[0] + card.crowns * weights[1] + (card.bonus?.amount ?? 0) * weights[2] - countTokens(action.payment!) * .2;
      }
      if (action.type === 'chooseColor') {
        const points = state.pending?.kind === 'chooseColor' ? getJewel(state.pending.cardId).points : 0;
        return stats.colorPoints[action.color] + points >= 10 ? 10000 : style === 'points' ? stats.colorPoints[action.color] : 5 - stats.bonuses[action.color];
      }
      if (action.type === 'chooseRoyal') return getRoyal(action.cardId).points * 10 + (getRoyal(action.cardId).effect === 'replay' ? 3 : 0);
      if (action.type === 'discard') return 0;
      if (action.type === 'refill') return state.board.filter(color => color && color !== 'gold').length < 3 ? 15 : -5;
      if (action.type === 'reserve') return cardId(action) ? 2 + getJewel(cardId(action)!).points - actor.reserved.length : -2;
      if (action.type === 'stealToken') return tokenDemand(action.color) + (action.color === 'pearl' ? .1 : 0);
      const indices = action.type === 'takeTokens' ? action.indices : [action.index];
      const gain = indices.reduce((sum, index) => sum + tokenDemand(state.board[index]! as typeof COST_COLORS[number]), 0);
      return gain * 4 + indices.length + (action.type === 'usePrivilege' ? 4 : 0) - Math.max(0, countTokens(actor.tokens) + indices.length - 10) * 5;
    };
    let selected: Action | null = null, best = -Infinity;
    for (const action of actions) {
      const value = score(action) + random() * .2;
      if (value > best) { best = value; selected = action; }
    }
    return selected;
  };
}

export interface HeldoutPosition { gameId: string; ply: number; state: GameState; outcome: 0 | 1 }
export function generateHeldoutCorpus(seeds: readonly string[], ply = 35, options: GameOptions = {}) {
  if (new Set(seeds).size !== seeds.length) throw new Error('Duplicate corpus seed');
  const positions: HeldoutPosition[] = [];
  const excluded: { gameId: string; reason: 'unfinished' | 'ended-before-snapshot' }[] = [];
  const policies = [referencePolicy('economy'), referencePolicy('points'), referencePolicy('crowns')];
  for (const [index, gameId] of seeds.entries()) {
    const result = playEvaluationGame(createGame(gameId), [policies[index % 3], policies[(index + 1) % 3]],
      { ...options, seed: evaluationSeed(`reference:${gameId}`), captureSteps: [ply] });
    const snapshot = result.snapshots.find(item => item.ply === ply && item.state.winner === null);
    if (result.state.winner === null) excluded.push({ gameId, reason: 'unfinished' });
    else if (!snapshot) excluded.push({ gameId, reason: 'ended-before-snapshot' });
    else positions.push({ gameId, ply, state: snapshot.state, outcome: result.state.winner === 0 ? 1 : 0 });
  }
  return { positions, excluded };
}

/** Repeatability is separate from predictive accuracy. Different seed estimates are expected to vary. */
export function samplingDispersion(values: readonly number[]): { count: number; mean: number | null; sampleSd: number | null; minimum: number | null; maximum: number | null } {
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('Invalid probability');
  if (!values.length) return { count: 0, mean: null, sampleSd: null, minimum: null, maximum: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { count: values.length, mean, sampleSd: values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null,
    minimum: Math.min(...values), maximum: Math.max(...values) };
}

export interface TacticalCase {
  id: string; description: string; state: GameState;
  /** Publicly checkable expected action, or a real win before yielding the turn. */
  expected: { kind: 'win-before-handoff' } | { kind: 'action'; action: Action };
}

/** Conserved real pieces, explicit oracles, independent of the candidate's search/evaluation code. */
export function tacticalBenchmarks(): TacticalCase[] {
  const detach = (state: GameState, id: string) => {
    for (const level of LEVELS) {
      state.decks[level] = state.decks[level].filter(card => card !== id);
      state.market[level] = state.market[level].map(card => card === id ? null : card);
    }
  };
  const own = (state: GameState, id: string, player: PlayerId) => {
    detach(state, id);
    const card = getJewel(id);
    state.players[player].cards.push({ cardId: id, color: card.bonus?.color === 'choice' ? 'green' : card.bonus?.color ?? null });
  };
  const offer = (state: GameState, id: string, slot = 0) => {
    detach(state, id); const level = getJewel(id).level;
    const previous = state.market[level][slot];
    if (previous) state.decks[level].push(previous);
    state.market[level][slot] = id;
  };
  const wallets = (state: GameState, first: Partial<Wallet>, second: Partial<Wallet>) => {
    const supply = { white: 4, blue: 4, green: 4, red: 4, black: 4, pearl: 2, gold: 3 };
    state.board.fill(null); state.bag = [];
    state.players[0].tokens = Object.fromEntries(TOKEN_COLORS.map(color => [color, first[color] ?? 0])) as Wallet;
    state.players[1].tokens = Object.fromEntries(TOKEN_COLORS.map(color => [color, second[color] ?? 0])) as Wallet;
    const remaining = TOKEN_COLORS.flatMap(color => Array.from({ length: supply[color] - (first[color] ?? 0) - (second[color] ?? 0) }, () => color));
    remaining.forEach((color, index) => { state.board[index] = color; });
  };
  const cases: TacticalCase[] = [];
  for (const [id, description, owned, target, claims] of [
    ['finish-prestige', '17声望可直接购入3分牌', ['j3-02', 'j3-04', 'j3-06', 'j3-08', 'j1-05'], 'j1-28', false],
    ['finish-crowns', '8皇冠可直接购入2皇冠牌', ['j3-12', 'j3-01', 'j3-03', 'j1-12'], 'j3-05', true],
    ['finish-color', '白色7分可直接购入白色3分牌', ['j3-02', 'j2-01', 'j1-05', 'j1-21', 'j1-16'], 'j3-01', false],
  ] as const) {
    const state = createGame(`tactical:${id}`); state.turn = 0; state.revision = 1;
    for (const card of owned) own(state, card, 0);
    if (claims) { state.players[0].royals = ['r1', 'r2']; state.players[0].royalClaims = [3, 6]; state.royals = ['r3', 'r4']; }
    offer(state, target);
    wallets(state, getDiscountedCost(state, 0, target), {});
    valid(state); cases.push({ id, description, state, expected: { kind: 'win-before-handoff' } });
  }
  const defense = createGame('tactical:steal-defense'); defense.turn = 0; defense.revision = 1;
  for (const id of ['j3-02', 'j3-04', 'j3-06', 'j3-08', 'j1-21', 'j1-22', 'j1-11', 'j1-16']) own(defense, id, 1);
  own(defense, 'j2-02', 0);
  detach(defense, 'j1-26'); defense.players[0].reserved.push('j1-26');
  ['j1-01', 'j1-02', 'j1-03', 'j1-04', 'j1-05'].forEach((id, slot) => offer(defense, id, slot));
  ['j2-06', 'j2-10', 'j2-14', 'j2-18'].forEach((id, slot) => offer(defense, id, slot));
  ['j3-10', 'j3-11', 'j3-12'].forEach((id, slot) => offer(defense, id, slot));
  wallets(defense, { black: 4 }, { red: 4, pearl: 1 });
  defense.phase = 'effect'; defense.effects = [{ kind: 'steal', cardId: 'j2-02' }];
  defense.pending = { kind: 'stealToken', colors: ['red', 'pearl'] };
  valid(defense);
  cases.push({ id: 'steal-defense', description: '偷红币阻止对手购入4分牌获胜；偷珍珠虽让自己可购牌却丢失防守', state: defense, expected: { kind: 'action', action: { type: 'stealToken', color: 'red' } } });
  return cases;
}

export function runTacticalBenchmarks(policy: DecisionPolicy, seed = 12345) {
  return tacticalBenchmarks().map(test => {
    let state = structuredClone(test.state); const actor = state.turn;
    const chosen: Action[] = [];
    for (let ply = 0; ply < 12 && state.winner === null && state.turn === actor; ply++) {
      const localSeed = evaluationSeed(`${seed}:${test.id}:${ply}`);
      const action = policy(structuredClone(state), { seed: localSeed, random: evaluationRandom(localSeed), ply });
      if (!action) throw new Error(`Tactical policy returned no action: ${test.id}`);
      const result = applyAction(state, action);
      if (!result.ok) throw new Error(`Illegal tactical policy action: ${result.error}`);
      chosen.push(action); state = result.state; valid(state);
      if (test.expected.kind === 'action') break;
    }
    const passed = test.expected.kind === 'win-before-handoff' ? state.winner === actor : JSON.stringify(chosen[0]) === JSON.stringify(test.expected.action);
    return { id: test.id, description: test.description, passed, actions: chosen };
  });
}
