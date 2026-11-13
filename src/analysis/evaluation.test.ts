import { describe, expect, it } from 'vitest';
import { applyAction, createGame, getLegalActions, validateState } from '../game/engine';
import { assertDisjointGameIds, evaluationRandom, generateHeldoutCorpus, playEvaluationGame, predictionMetrics,
  referencePolicy, runPairedArena, samplingDispersion, summarizeArena, tacticalBenchmarks, type ArenaGame } from './evaluation';

describe('independent evaluation protocol', () => {
  it('uses identical shuffled positions with algorithms in both seats and does not count cutoffs as defeats', () => {
    const seen: { seed: string; board: unknown; market: unknown; side: string; turn: number }[] = [];
    const policy = (side: string) => (state: ReturnType<typeof createGame>) => {
      seen.push({ seed: state.seed, board: state.board, market: state.market, side, turn: state.turn });
      return getLegalActions(state)[0];
    };
    const result = runPairedArena(['paired-1', 'paired-2'], policy('new'), policy('old'), { maxActions: 1 });
    expect(result.summary).toMatchObject({ pairs: 2, games: 4, wins: 0, losses: 0, unfinished: 4, completedWinRate: null, pairedScoreBounds: [0, 1], pairedHoeffding95: [0, 1] });
    for (let i = 0; i < seen.length; i += 2) {
      expect(seen[i].board).toEqual(seen[i + 1].board);
      expect(seen[i].market).toEqual(seen[i + 1].market);
      expect(seen[i].turn).toBe(seen[i + 1].turn);
      expect(seen[i].side).not.toBe(seen[i + 1].side);
    }
    expect(() => runPairedArena(['repeat', 'repeat'], policy('a'), policy('b'))).toThrow('Duplicate');
  });

  it('isolates policy input mutation, rejects illegal actions and keeps the initial state intact', () => {
    const initial = createGame('evaluation-integrity');
    const before = structuredClone(initial);
    const mischievous = (state: ReturnType<typeof createGame>) => {
      const action = getLegalActions(state)[0];
      state.players[0].tokens.gold = 99;
      return action;
    };
    const result = playEvaluationGame(initial, [mischievous, mischievous], { maxActions: 1, captureSteps: [0, 1] });
    expect(initial).toEqual(before);
    expect(validateState(result.state)).toEqual([]);
    expect(result.snapshots.map(item => item.ply)).toEqual([0, 1]);
    expect(() => playEvaluationGame(initial, [() => ({ type: 'takeTokens', indices: [99] }), () => ({ type: 'takeTokens', indices: [99] })])).toThrow('Illegal policy action');
  });

  it('groups related legs instead of claiming independent-binomial certainty', () => {
    const games: ArenaGame[] = [];
    for (let i = 0; i < 100; i++) for (const seat of [0, 1] as const) games.push({ pairId: String(i), candidateSeat: seat, candidateStarted: seat === 0,
      winner: i < 75 ? 'candidate' : 'baseline', actions: 90, milliseconds: 100, candidateDecisionMilliseconds: 80, candidateDecisions: 40, baselineDecisionMilliseconds: 20, baselineDecisions: 40 });
    const summary = summarizeArena(games);
    expect(summary.completedWinRate).toBe(.75);
    expect(summary.pairedScoreBounds).toEqual([.75, .75]);
    expect(summary.pairedHoeffding95[0]).toBeGreaterThan(.61);
    expect(summary.pairedHoeffding95[0]).toBeLessThan(.62);
    expect(summary.pairedHoeffding95[1]).toBeGreaterThan(.88);
    expect(summary.candidateMeanDecisionMs).toBe(2);
    expect(summary.baselineMeanDecisionMs).toBe(.5);
    expect(() => summarizeArena(games.slice(1))).toThrow('swapped-seat');
  });

  it('computes game-balanced scores, retains abstentions, and keeps probability-one observations in the final bin', () => {
    const metrics = predictionMetrics([
      { gameId: 'short', probability: 1, outcome: 0 },
      ...Array.from({ length: 20 }, () => ({ gameId: 'long', probability: 1, outcome: 1 as const })),
      { gameId: 'unknown', probability: null, outcome: 1 },
    ]);
    expect(metrics).toMatchObject({ total: 22, evaluated: 21, abstained: 1, games: 2, brier: .5 });
    expect(metrics.accuracyAtHalf).toBeCloseTo(.5);
    expect(metrics.expectedCalibrationError).toBeCloseTo(.5);
    expect(metrics.calibration).toHaveLength(1);
    expect(metrics.calibration[0]).toMatchObject({ lower: .8, upper: 1, count: 21, meanPrediction: 1 });
    expect(metrics.logLoss).toBeGreaterThan(13);
    expect(predictionMetrics([{ gameId: 'missing', probability: null, outcome: 0 }]).brier).toBeNull();
    expect(() => predictionMetrics([{ gameId: 'bad', probability: 1.01, outcome: 0 }])).toThrow('Invalid prediction');
  });

  it('rejects shared games across development and holdout and measures sampling variability separately', () => {
    expect(() => assertDisjointGameIds(['a', 'b'], ['b', 'c'])).toThrow('both');
    expect(() => assertDisjointGameIds(['a'], ['b'])).not.toThrow();
    const randomA = evaluationRandom(42), randomB = evaluationRandom(42);
    expect(Array.from({ length: 5 }, randomA)).toEqual(Array.from({ length: 5 }, randomB));
    expect(samplingDispersion([.25, .5, .75])).toEqual({ count: 3, mean: .5, sampleSd: .25, minimum: .25, maximum: .75 });
    expect(samplingDispersion([]).mean).toBeNull();
  });

  it('generates independent reference trajectories with one preselected nonterminal snapshot per completed game', () => {
    const corpus = generateHeldoutCorpus(['evaluation-reference-1', 'evaluation-reference-2'], 20, { maxActions: 600 });
    expect(corpus.excluded).toEqual([]);
    expect(corpus.positions).toHaveLength(2);
    for (const point of corpus.positions) {
      expect(point.ply).toBe(20);
      expect(point.state.winner).toBeNull();
      expect(point.outcome === 0 || point.outcome === 1).toBe(true);
      expect(validateState(point.state)).toEqual([]);
    }
    const short = generateHeldoutCorpus(['evaluation-short'], 20, { maxActions: 1 });
    expect(short.positions).toEqual([]);
    expect(short.excluded).toEqual([{ gameId: 'evaluation-short', reason: 'unfinished' }]);
    const policy = referencePolicy('crowns');
    const initial = createGame('reference-legal');
    const action = policy(initial, { seed: 3, random: evaluationRandom(3), ply: 0 });
    expect(getLegalActions(initial)).toContainEqual(action);
  }, 30000);

  it('checks the defense oracle against actual legal winning purchases, rather than the candidate evaluator', () => {
    const cases = tacticalBenchmarks();
    for (const test of cases) expect(validateState(test.state)).toEqual([]);
    const defense = cases.find(test => test.id === 'steal-defense')!.state;
    for (const color of ['red', 'pearl'] as const) {
      const result = applyAction(defense, { type: 'stealToken', color });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const after = result.state;
      const winningBuys = getLegalActions(after).filter(action => action.type === 'buy').filter(action => {
        const next = applyAction(after, action);
        return next.ok && next.state.winner === 1;
      });
      expect(winningBuys.length > 0).toBe(color === 'pearl');
    }
  });
});
