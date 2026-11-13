import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, createGame, getLegalActions } from '../game/engine';
import { createMatch, MAX_MATCH_ACTIONS, parseMatch, serializeMatch, type MatchRecord } from '../game/match';
import type { GameState } from '../game/types';
import { MatchAnalysis, type AnalysisWorker } from './match-analysis';
import type { ProgressiveCommand, ProgressiveResponse } from './progressive';
import { chooseSimulationAction, summarizeEstimate } from './win-probability';
import { ANALYSIS_POLICIES, analysisPositionKey } from './analysis-cache';
import type { SavedAnalysis } from '../game/analysis-save';

class FakeWorker implements AnalysisWorker {
  onmessage: AnalysisWorker['onmessage'] = null;
  onerror: AnalysisWorker['onerror'] = null;
  messages: ProgressiveCommand[] = [];
  terminated = false;
  postMessage(message: ProgressiveCommand) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  send(message: ProgressiveResponse) { this.onmessage?.({ data: message } as MessageEvent<ProgressiveResponse>); }
  finish() {
    const command = this.messages.at(-1)!;
    if (command.type !== 'analyze') throw Error('Expected analysis');
    const samples = command.options!.samples!;
    const previous = command.resume?.[0];
    const wins: [number, number] = [(previous?.wins[0] ?? 0) + samples - (previous?.requested ?? 0), previous?.wins[1] ?? 0];
    this.send({ type: 'point', id: command.id, index: 0, estimate: summarizeEstimate(command.states[0], wins, previous?.unfinished ?? 0, samples) });
    this.send({ type: 'done', id: command.id });
  }
}
function setup() {
  const workers: FakeWorker[] = [];
  const analysis = new MatchAnalysis(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const game = createGame('background-test'); const record = createMatch(game);
  analysis.update(record, game); analysis.setActivity(true, true, false);
  return { analysis, workers, game, record };
}
function append(record: MatchRecord, state: GameState) {
  const actions = getLegalActions(state);
  const action = actions.find(action => action.type === 'takeTokens') ?? actions.find(action => action.type === 'refill') ?? actions[0];
  const next = applyAction(state, action);
  if (!next.ok) throw Error(next.error);
  return { record: { ...record, actions: [...record.actions, action] }, game: next.state };
}

function savedAnalysis(): SavedAnalysis {
  return { version: 1, policies: { ...ANALYSIS_POLICIES }, points: { baseline: [], search: [] } };
}

function terminalContinuation() {
  let game = createGame('persisted-terminal');
  for (let step = 0; step < 600; step++) {
    const action = chooseSimulationAction(game, () => .5)!;
    const next = applyAction(game, action); if (!next.ok) throw Error(next.error);
    if (next.state.winner !== null) return { record: { ...createMatch(game), actions: [action] }, game: next.state };
    game = next.state;
  }
  throw Error('Fixture did not finish');
}

describe('shared background analysis ownership', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('keeps one worker and one in-flight snapshot during rapid appends, with no live odds exposed', () => {
    let { analysis, workers, record, game } = setup();
    vi.advanceTimersByTime(150);
    for (let i = 0; i < 30; i++) {
      ({ record, game } = append(record, game)); analysis.update(record, game);
    }
    expect(workers).toHaveLength(1); expect(workers[0].messages).toHaveLength(1);
    const sent = workers[0].messages[0];
    expect(sent).toMatchObject({ states: [expect.objectContaining({ log: [] })], restRatio: 1 });
    expect(analysis.diagnostics).toMatchObject({ workers: 1, inFlight: 1, steps: 31 });
    expect(analysis.diagnostics.cachedFrames).toBeLessThanOrEqual(4);
    analysis.setView(0, 'search', true); workers[0].finish();
    expect(analysis.estimates('baseline')).toEqual([]); expect(analysis.estimates('search')).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(workers[0].messages.at(-1)).toMatchObject({ restRatio: 1 });
    analysis.suspend();
  });

  it('drops stale point/done/error messages when switching games', () => {
    const { analysis, workers } = setup(); vi.advanceTimersByTime(150);
    const old = workers[0]; const staleError = old.onerror;
    const fresh = createGame('new-background-game'); analysis.update(createMatch(fresh), fresh);
    expect(old.terminated).toBe(true); old.finish(); staleError?.({ message: 'stale failure' } as ErrorEvent);
    vi.advanceTimersByTime(150);
    expect(workers).toHaveLength(2); expect(analysis.error).toBe('');
    expect(analysis.diagnostics).toMatchObject({ workers: 1, inFlight: 1, estimates: 0, steps: 1 });
    analysis.suspend();
  });

  it('pauses immediately for hidden tabs, animation, and disabled precomputation, then resumes counts', () => {
    const { analysis, workers } = setup(); vi.advanceTimersByTime(150); workers[0].finish();
    analysis.setActivity(true, false, false); expect(workers[0].terminated).toBe(true);
    vi.advanceTimersByTime(10000); expect(workers).toHaveLength(1);
    analysis.setActivity(true, true, true); vi.advanceTimersByTime(1000); expect(workers).toHaveLength(1);
    analysis.setActivity(false, true, false); vi.advanceTimersByTime(1000); expect(workers).toHaveLength(1);
    analysis.setActivity(true, true, false); vi.advanceTimersByTime(150);
    expect(workers[1].messages[0]).toMatchObject({ resume: [expect.objectContaining({ requested: 2 })], options: { samples: 4 } });
    analysis.suspend(); analysis.setActivity(true, true, false); vi.advanceTimersByTime(150);
    expect(workers.filter(worker => !worker.terminated)).toHaveLength(1);
    analysis.suspend();
  });

  it('reuses live estimates after a real terminal game and releases idle worker; replay adds no second worker', () => {
    let { analysis, workers, record, game } = setup(); vi.advanceTimersByTime(150); workers[0].finish();
    for (let i = 0; game.winner === null && i < 600; i++) {
      const action = chooseSimulationAction(game, () => .5)!; const result = applyAction(game, action);
      if (!result.ok) throw Error(result.error);
      record = { ...record, actions: [...record.actions, action] }; game = result.state;
    }
    expect(game.winner).not.toBeNull(); analysis.update(record, game);
    expect(analysis.estimates('baseline')[0]?.requested).toBe(2);
    analysis.setActivity(false, true, false); analysis.setView(0, 'baseline'); vi.advanceTimersByTime(150);
    const worker = workers.at(-1)!;
    expect(worker.messages[0]).toMatchObject({ resume: [expect.objectContaining({ requested: 2 })], restRatio: 0 });
    expect(workers.filter(worker => !worker.terminated)).toHaveLength(1);
    analysis.setView(0, 'search'); worker.finish(); vi.advanceTimersByTime(0);
    expect(worker.messages.at(-1)).toMatchObject({ method: 'search', resume: [undefined] });
    analysis.setView(null); expect(worker.terminated).toBe(true);
    // A terminal-only record needs no simulations, and frees the idle worker.
    analysis.update(createMatch(game), game); analysis.setActivity(true, true, false); vi.advanceTimersByTime(150);
    expect(analysis.diagnostics).toMatchObject({ workers: 0, inFlight: 0, estimates: 2 });
    analysis.suspend();
  });

  it('bounds snapshots for a maximum-length legal game; backlogged older steps still get scheduled', () => {
    let { analysis, workers, record, game } = setup();
    for (let i = 0; i < MAX_MATCH_ACTIONS; i++) ({ record, game } = append(record, game));
    analysis.update(record, game); vi.advanceTimersByTime(150);
    expect(analysis.diagnostics).toMatchObject({ workers: 1, inFlight: 1, steps: MAX_MATCH_ACTIONS + 1 });
    expect(analysis.diagnostics.cachedFrames).toBeLessThanOrEqual(4);
    expect(workers[0].messages[0]).toMatchObject({ states: [expect.objectContaining({ revision: MAX_MATCH_ACTIONS })] });
    workers[0].finish(); vi.advanceTimersByTime(150);
    expect(workers[0].messages.at(-1)).toMatchObject({ states: [expect.objectContaining({ revision: 0 })] });
    expect(analysis.diagnostics.estimates).toBe(1);
    analysis.suspend();
  });

  it('round-trips real match JSON and resumes sample 2 through 4 without exposing live odds', () => {
    const { analysis, workers, record } = setup(); vi.advanceTimersByTime(150);
    const first = workers[0].messages[0]; if (first.type !== 'analyze') throw Error('Expected analysis');
    workers[0].send({ type: 'point', id: first.id, index: 0, estimate: summarizeEstimate(first.states[0], [1, 1], 0, 2) });
    workers[0].send({ type: 'done', id: first.id }); analysis.suspend();
    const exported = analysis.snapshot(record);
    expect(exported.analysis?.points.baseline[0]).toEqual([0, analysisPositionKey(record.initial), 1, 1, 0, 24]);
    expect(record.analysis).toBeUndefined();
    const loaded = parseMatch(serializeMatch(exported)); expect(loaded).not.toBeNull();
    const restartedWorkers: FakeWorker[] = [];
    const restarted = new MatchAnalysis(() => { const worker = new FakeWorker(); restartedWorkers.push(worker); return worker; });
    restarted.update(loaded!.record, loaded!.game);
    expect(restarted.estimates('baseline')).toEqual([]); expect(restarted.estimates('search')).toEqual([]);
    restarted.setActivity(true, true, false); vi.advanceTimersByTime(150);
    expect(restartedWorkers[0].messages[0]).toMatchObject({ method: 'baseline', resume: [{ requested: 2, wins: [1, 1], probability: .5 }], options: { samples: 4 } });
    restartedWorkers[0].finish();
    expect(restarted.snapshot(loaded!.record).analysis?.points.baseline[0]).toEqual([0, analysisPositionKey(loaded!.record.initial), 3, 1, 0, 24]);
    expect(restarted.estimates('baseline')).toEqual([]);
    restarted.suspend();
  });

  it('discards only the unknown policy or mismatching position while retaining other cached counts', () => {
    const game = createGame('cache-compatibility');
    const continued = append(createMatch(game), game);
    const saved = savedAnalysis();
    saved.points.baseline = [[0, analysisPositionKey(game), 1, 1, 0, 24], [1, analysisPositionKey(continued.game), 2, 1, 1, 24]];
    saved.points.search = [[0, analysisPositionKey(game), 3, 1, 0, 24]];
    const analysis = new MatchAnalysis(() => new FakeWorker());
    const unknown = structuredClone(saved); unknown.policies.baseline = 'unsupported-policy-version';
    const unknownRecord = { ...continued.record, analysis: unknown };
    analysis.update(unknownRecord, continued.game);
    expect(analysis.snapshot(unknownRecord).analysis?.points).toEqual({ baseline: [], search: saved.points.search });
    const mismatched = structuredClone(saved); mismatched.points.baseline[0][1] = '0000000000000000';
    const freshRecord = { ...continued.record, initial: structuredClone(continued.record.initial), analysis: mismatched };
    analysis.update(freshRecord, continued.game);
    expect(analysis.snapshot(freshRecord).analysis?.points).toEqual({ baseline: [saved.points.baseline[1]], search: saved.points.search });
    expect(analysis.estimates('baseline')).toEqual([]);
    analysis.suspend();
  });

  it('preserves a 64-sample target across refresh and completes it without downgrading or restarting', () => {
    const { record, game } = terminalContinuation();
    const saved = savedAnalysis();
    saved.points.baseline = [[0, analysisPositionKey(record.initial), 24, 0, 0, 24]];
    saved.points.search = [[0, analysisPositionKey(record.initial), 40, 20, 2, 64]];
    const loaded = parseMatch(serializeMatch({ ...record, analysis: saved })); expect(loaded).not.toBeNull();
    const workers: FakeWorker[] = [];
    const analysis = new MatchAnalysis(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
    analysis.update(loaded!.record, loaded!.game);
    expect(analysis.estimates('search')[0]).toEqual(summarizeEstimate(record.initial, [40, 20], 2, 62));
    expect(analysis.estimates('search')[1]).toMatchObject({ terminal: true, probability: Number(game.winner === 0) });
    analysis.setActivity(true, true, false); vi.advanceTimersByTime(150);
    expect(workers[0].messages[0]).toMatchObject({ method: 'search', resume: [{ requested: 62, wins: [40, 20], unfinished: 2 }], options: { samples: 64 } });
    workers[0].finish(); vi.advanceTimersByTime(150);
    expect(workers[0].terminated).toBe(true);
    expect(analysis.snapshot(loaded!.record).analysis?.points.search).toEqual([[0, analysisPositionKey(record.initial), 42, 20, 2, 64]]);
    expect(analysis.estimates('search')[0]).toEqual(summarizeEstimate(record.initial, [42, 20], 2, 64));
    expect(analysis.diagnostics).toMatchObject({ workers: 0, inFlight: 0 });
    analysis.suspend();
  });

  it('persists a newly requested deep target before sampling and never attaches old counts to a new match', () => {
    const { record, game } = terminalContinuation();
    const analysis = new MatchAnalysis(() => new FakeWorker()); analysis.update(record, game);
    analysis.setView(0, 'search', true);
    const saved = analysis.snapshot(record);
    expect(saved.analysis?.points.search).toEqual([[0, analysisPositionKey(record.initial), 0, 0, 0, 64]]);
    analysis.suspend();
    const loaded = parseMatch(serializeMatch(saved)); expect(loaded).not.toBeNull();
    analysis.update(loaded!.record, loaded!.game); analysis.setView(0, 'search');
    expect(analysis.snapshot(loaded!.record).analysis?.points.search[0][5]).toBe(64);
    const otherGame = createGame('unrelated-live-game'); const other = createMatch(otherGame);
    analysis.update(other, otherGame);
    expect(analysis.snapshot(other).analysis?.points).toEqual({ baseline: [], search: [] });
    expect(analysis.snapshot(record)).toBe(record);
    expect(analysis.snapshot(saved)).toBe(saved);
    expect(analysis.estimates('baseline')).toEqual([]); expect(analysis.estimates('search')).toEqual([]);
    analysis.suspend();
  });
});
