import type { GameState } from '../game/types';
import { runSearchPlayout } from './search-policy';
import { analysisSettings, positionSeed, runPlayout, sampleSeed, summarizeEstimate, type AnalysisOptions, type PlayoutResult, type WinEstimate } from './win-probability';

export const STANDARD_SAMPLES = 24;
export const DEEP_SAMPLES = 64;
export type AnalysisMethod = 'baseline' | 'search';
export type ProgressiveCommand =
  | { type: 'analyze'; id: string; states: GameState[]; method?: AnalysisMethod; resume?: (WinEstimate | undefined)[]; focus?: number; options?: AnalysisOptions }
  | { type: 'focus'; id: string; index: number; deep?: boolean }
  | { type: 'cancel'; id: string };
export type ProgressiveResponse =
  | { type: 'point'; id: string; index: number; estimate: WinEstimate }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; message: string };

/** Fixed sample milestones, not confidence-based stopping. Resume continues the seed stream. */
export class ProgressiveAnalysis {
  readonly estimates: (WinEstimate | undefined)[];
  private readonly seeds: number[];
  private readonly settings: ReturnType<typeof analysisSettings>;
  focus = -1;
  focusTarget: number;
  constructor(readonly states: GameState[], resume: (WinEstimate | undefined)[] = [], options: AnalysisOptions = {}, readonly method: AnalysisMethod = 'baseline') {
    this.settings = analysisSettings(options);
    this.focusTarget = this.settings.samples;
    this.seeds = states.map(state => positionSeed(state, this.settings.seed));
    this.estimates = states.map((state, index) => {
      if (state.winner !== null) return summarizeEstimate(state, [0, 0], 0, 0);
      const old = resume[index];
      if (!old || old.terminal || ![...old.wins, old.unfinished, old.requested].every(value => Number.isSafeInteger(value) && value >= 0)
        || old.requested > DEEP_SAMPLES || old.wins[0] + old.wins[1] + old.unfinished !== old.requested) return undefined;
      return summarizeEstimate(state, [...old.wins], old.unfinished, old.requested);
    });
  }
  prioritize(index: number, deep = false) {
    this.focus = Number.isSafeInteger(index) && index >= 0 && index < this.states.length ? index : -1;
    this.focusTarget = deep ? DEEP_SAMPLES : this.settings.samples;
  }
  next(): number {
    const needs = (index: number, target: number) => this.states[index].winner === null && (this.estimates[index]?.requested ?? 0) < target;
    if (this.focus >= 0 && needs(this.focus, this.focusTarget)) return this.focus;
    for (const target of [Math.min(8, this.settings.samples), this.settings.samples]) {
      const index = this.states.findIndex((_, step) => needs(step, target));
      if (index >= 0) return index;
    }
    return -1;
  }
  advance(index: number, playout: (state: GameState, seed: number, maxActions: number, iterations: number) => PlayoutResult = this.method === 'search' ? runSearchPlayout : runPlayout) {
    const state = this.states[index];
    if (state.winner !== null) return this.estimates[index]!;
    const old = this.estimates[index];
    const requested = old?.requested ?? 0;
    const wins: [number, number] = old ? [...old.wins] : [0, 0];
    let unfinished = old?.unfinished ?? 0;
    const result = playout(state, sampleSeed(this.seeds[index], requested), this.settings.maxActions, 8);
    if (result.winner === null) unfinished++; else wins[result.winner]++;
    return this.estimates[index] = summarizeEstimate(state, wins, unfinished, requested + 1);
  }
}
