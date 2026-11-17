import type { ActionReview } from './action-review';
import { summarizePerformance, type DecisionLoss } from './match-performance';
import type { GameState } from '../game/types';
import { MAX_MATCH_ACTIONS, type MatchRecord } from '../game/match';
import { ReplayWindow } from '../game/replay-window';
import { parseSavedAnalysis, type SavedAnalysis } from '../game/analysis-save';
import { ANALYSIS_POLICIES, analysisPositionKey } from './analysis-cache';
import { DEEP_SAMPLES, STANDARD_SAMPLES, type AnalysisMethod, type ProgressiveCommand, type ProgressiveResponse } from './progressive';
import { summarizeEstimate, type WinEstimate } from './win-probability';

export interface AnalysisWorker {
  postMessage(message: ProgressiveCommand): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<ProgressiveResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}
type Job = { id: string; index: number; method: AnalysisMethod };
type View = { index: number; method: AnalysisMethod; target: number };
const METHODS: AnalysisMethod[] = ['baseline', 'search'];
export const ANALYSIS_BATCH = 2;

/** One owner for live play and replay. Queue = indices implicit in the action record. */
export class MatchAnalysis {
  private reviews = new Map<number, ActionReview>();
  private reviewIndex: number | null = null;
  private decisions = new Map<number, DecisionLoss>();
  private performanceRequested = false;
  private preferReview = true;
  private record: MatchRecord | null = null;
  private frames: ReplayWindow | null = null;
  private values: Record<AnalysisMethod, (WinEstimate | undefined)[]> = { baseline: [], search: [] };
  private keys = new Map<number, string>();
  private targets: Record<AnalysisMethod, Map<number, 24 | 64>> = { baseline: new Map(), search: new Map() };
  private listeners = new Set<() => void>();
  private worker: AnalysisWorker | null = null;
  private job: Job | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private serial = 0;
  private cursor = 0;
  private preferLatest = true;
  private visible = true;
  private busy = false;
  private background = false;
  private view: View | null = null;
  private finished = false;
  error = '';

  constructor(private readonly createWorker: () => AnalysisWorker = () => new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })) {}

  update(record: MatchRecord, latest: GameState) {
    if (record.actions.length > MAX_MATCH_ACTIONS) throw new Error('分析记录超过上限');
    const previous = this.record;
    const continuation = previous?.initial === record.initial && record.actions.length >= previous.actions.length
      && previous.actions.every((action, index) => action === record.actions[index]);
    if (!continuation) {
      this.decisions.clear(); this.performanceRequested = false;
      this.halt(); this.reviews.clear(); this.reviewIndex = null; this.values = { baseline: [], search: [] }; this.cursor = 0; this.view = null; this.error = '';
      this.keys.clear(); this.targets = { baseline: new Map(), search: new Map() };
      this.frames = new ReplayWindow(record);
    }
    this.record = record;
    this.frames!.update(record, latest);
    if (!continuation) this.restore(record);
    this.finished = latest.winner !== null;
    if (latest.winner !== null) for (const method of METHODS) {
      this.values[method][record.actions.length] = summarizeEstimate(latest, [0, 0], 0, 0);
    }
    this.emit(); this.schedule();
  }

  setActivity(background: boolean, visible: boolean, busy: boolean) {
    this.background = background; this.visible = visible; this.busy = busy;
    if (!this.canRun()) this.halt(); else this.schedule();
  }
  setView(index: number | null, method: AnalysisMethod = 'baseline', deep = false) {
    // Even a caller error cannot expose live-game analysis through the replay API.
    if (index !== null && this.record && this.finished
      && Number.isSafeInteger(index) && index >= 0 && index <= this.record.actions.length) {
      this.error = '';
      const target = deep || this.targets[method].get(index) === DEEP_SAMPLES ? DEEP_SAMPLES : STANDARD_SAMPLES;
      this.targets[method].set(index, target);
      this.keys.set(index, analysisPositionKey(this.frames!.get(index)));
      this.view = { index, method, target };
      this.emit();
    } else this.view = null;
    if (!this.canRun()) this.halt(); else this.schedule();
  }
  review(index: number) { return this.finished ? this.reviews.get(index) : undefined; }
  performance() { return summarizePerformance(this.finished ? this.decisions.values() : [], this.record?.actions.length ?? 0, (this.record?.initial.revision ?? 0) > 0); }
  requestPerformance() { if (this.finished) { this.performanceRequested = true; this.emit(); this.schedule(); } }
  requestReview(index: number | null) {
    this.reviewIndex = this.finished && index !== null && index > 0 && index <= this.record!.actions.length ? index : null;
    this.schedule();
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Owned compact counts; never mix results into a different or superseded record. */
  snapshot(record: MatchRecord): MatchRecord {
    if (record !== this.record) return record;
    const analysis: SavedAnalysis = { version: 1, policies: { ...ANALYSIS_POLICIES }, points: { baseline: [], search: [] } };
    for (const method of METHODS) {
      const indices = new Set([...this.targets[method].keys(), ...this.values[method].flatMap((value, index) => value ? [index] : [])]);
      for (const index of [...indices].sort((a, b) => a - b)) {
        const value = this.values[method][index]; const key = this.keys.get(index);
        if (!key || value?.terminal) continue;
        analysis.points[method].push([index, key, value?.wins[0] ?? 0, value?.wins[1] ?? 0,
          value?.unfinished ?? 0, this.targets[method].get(index) ?? STANDARD_SAMPLES]);
      }
    }
    return { ...record, analysis };
  }
  private restore(record: MatchRecord) {
    const saved = parseSavedAnalysis(record.analysis, record.actions.length);
    if (!saved) return;
    const rows = METHODS.flatMap(method => saved.policies[method] === ANALYSIS_POLICIES[method]
      ? saved.points[method].map(row => ({ method, row })) : []).sort((a, b) => a.row[0] - b.row[0]);
    for (const { method, row: [index, key, wins0, wins1, unfinished, target] } of rows) {
      const state = this.frames!.get(index);
      if (state.winner !== null || analysisPositionKey(state) !== key) continue;
      this.keys.set(index, key); this.targets[method].set(index, target);
      this.values[method][index] = summarizeEstimate(state, [wins0, wins1], unfinished, wins0 + wins1 + unfinished);
    }
  }
  estimates(method: AnalysisMethod): (WinEstimate | undefined)[] {
    if (!this.record || !this.finished) return [];
    return this.values[method].slice();
  }
  get working() { return !!this.job || !!this.timer; }
  get paused() { return !this.canRun(); }
  get diagnostics() {
    return { workers: Number(!!this.worker), inFlight: Number(!!this.job), cachedFrames: this.frames?.cachedCount ?? 0,
      estimates: METHODS.reduce((sum, method) => sum + this.values[method].filter(Boolean).length, 0), steps: (this.record?.actions.length ?? -1) + 1 };
  }
  /** Reusable after StrictMode cleanup. Frees the worker immediately, retains numeric results. */
  suspend() { this.halt(); }
  private canRun() { return this.visible && !this.busy && (this.background || !!this.view) && !this.error; }
  private emit() { this.listeners.forEach(listener => listener()); }
  private halt() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null; this.job = null; this.worker?.terminate(); this.worker = null; this.serial++; this.emit();
  }
  private schedule() {
    if (!this.record || !this.canRun() || this.job || this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; this.dispatch(); }, this.view ? 0 : 150);
  }
  private choose(): (Omit<Job, 'id'> & { target: number }) | null {
    const count = this.record!.actions.length + 1;
    const needs = (index: number, method: AnalysisMethod, target: number) => {
      const value = this.values[method][index]; return !value?.terminal && (value?.requested ?? 0) < target;
    };
    if (this.view && needs(this.view.index, this.view.method, this.view.target)) return this.view;
    if (!this.background && !this.view) return null;
    const methods = this.view ? [this.view.method] : METHODS;
    if (this.preferLatest && !this.view) {
      for (const target of [8, STANDARD_SAMPLES]) for (const method of methods) if (needs(count - 1, method, target)) {
        this.preferLatest = false; return { index: count - 1, method, target };
      }
    }
    for (const target of [8, STANDARD_SAMPLES]) for (let offset = 0; offset < count; offset++) {
      const index = (this.cursor + offset) % count;
      for (const method of methods) if (needs(index, method, target)) {
        this.cursor = (index + 1) % count; this.preferLatest = true; return { index, method, target };
      }
    }
    for (const method of methods) for (const [index, target] of this.targets[method]) {
      if (needs(index, method, target)) return { index, method, target };
    }
    return null;
  }
  private dispatch() {
    if (!this.canRun() || !this.record || this.job) return;
    let reviewIndex = this.view && this.reviewIndex !== null && !this.reviews.has(this.reviewIndex) ? this.reviewIndex : null;
    const estimate = this.choose();
    if (reviewIndex === null && this.view && this.performanceRequested && (this.preferReview || !estimate)) {
      for (let index = 1; index <= this.record.actions.length; index++) if (!this.decisions.has(index)) { reviewIndex = index; break; }
    }
    const next = reviewIndex !== null ? { index: reviewIndex, method: 'baseline' as const, target: 24 } : estimate;
    if (!next) { this.worker?.terminate(); this.worker = null; this.emit(); return; }
    try {
      const state = this.frames!.get(next.index);
      this.keys.set(next.index, analysisPositionKey(state));
      const id = `analysis-${++this.serial}`;
      this.job = { id, index: next.index, method: next.method };
      if (!this.worker) {
        const worker = this.createWorker(); this.worker = worker;
        worker.onmessage = event => {
          if (this.worker !== worker || event.data.id !== this.job?.id) return;
          const message = event.data; const job = this.job;
          if (message.type === 'review') {
            const before = this.frames!.get(job.index - 1);
            this.decisions.set(job.index, { actor: before.turn, turn: before.turnNumber, loss: message.review.loss, forced: message.review.legalCount === 1 });
            this.reviews.set(job.index, message.review);
            if (this.reviews.size > 64) this.reviews.delete([...this.reviews.keys()].find(index => index !== this.reviewIndex)!);
            this.emit();
          } else if (message.type === 'point') {
            this.values[job.method][job.index] = message.estimate; this.emit();
          } else if (message.type === 'done') {
            this.job = null; this.schedule(); this.emit();
          } else { this.error = message.message; this.halt(); }
        };
        worker.onerror = event => { if (this.worker === worker) { this.error = event.message || '后台分析中断'; this.halt(); } };
      }
      if (reviewIndex !== null) {
        this.preferReview = false;
        this.worker.postMessage({ type: 'review', id, state: this.frames!.get(reviewIndex - 1), action: this.record.actions[reviewIndex - 1] });
        this.emit(); return;
      }
      const resume = this.values[next.method][next.index];
      this.preferReview = true;
      const target = Math.min(next.target, (resume?.requested ?? 0) + ANALYSIS_BATCH);
      this.worker.postMessage({ type: 'analyze', id, states: [state], method: next.method, resume: [resume],
        options: { samples: target }, restRatio: this.view ? 0 : 1 });
      this.emit();
    } catch (error) { this.error = error instanceof Error ? error.message : '后台分析无法启动'; this.halt(); }
  }
}
