import { applyAction, validateState } from './engine';
import { createMatch, MAX_MATCH_ACTIONS, type MatchRecord } from './match';
import type { GameState } from './types';

const snapshot = (state: GameState): GameState => structuredClone({ ...state, log: [] });

/** Lazy replay with at most four log-free checkpoints, never a full history of states. */
export class ReplayWindow {
  private record!: MatchRecord;
  private actions: string[] = [];
  private readonly cache = new Map<number, GameState>();
  constructor(record: MatchRecord, private readonly capacity = 4) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) throw new RangeError('回放缓存容量必须为 1–4');
    this.update(record);
  }
  get cachedCount() { return this.cache.size; }

  /** latest must be a trusted live-engine state; imported records must pass parseMatch first. */
  update(record: MatchRecord, latest?: GameState): void {
    if (!record || record.version !== 1 || !Array.isArray(record.actions) || record.actions.length > MAX_MATCH_ACTIONS) {
      throw new Error('回放记录无效或超过行动上限');
    }
    const actions = record.actions.map(action => JSON.stringify(action));
    const append = this.record?.initial === record.initial && actions.length >= this.actions.length
      && this.actions.every((action, index) => action === actions[index]);
    const initial = append ? undefined : snapshot(createMatch(record.initial).initial);
    let current: GameState | undefined;
    if (latest) {
      if (latest.revision !== record.initial.revision + actions.length || latest.seed !== record.initial.seed
        || validateState(latest).length) throw new Error('当前局面与回放记录不匹配');
      current = snapshot(latest);
    }
    this.record = record;
    this.actions = actions;
    if (!append) { this.cache.clear(); this.remember(0, initial!); }
    if (current) this.remember(actions.length, current);
  }

  get(index: number): GameState {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.actions.length) throw new RangeError('回放步骤越界');
    const cached = this.cache.get(index);
    if (cached) { this.remember(index, cached); return snapshot(cached); }
    let start = 0;
    let state = this.record.initial;
    for (const [step, checkpoint] of this.cache) if (step <= index && step >= start) {
      start = step; state = checkpoint;
    }
    state = snapshot(state);
    for (let step = start; step < index; step++) {
      const result = applyAction(state, this.record.actions[step]);
      if (!result.ok) throw new Error(`对局记录第 ${step + 1} 步无效：${result.error}`);
      state = result.state; state.log = [];
    }
    this.remember(index, state);
    return snapshot(state);
  }

  private remember(index: number, state: GameState) {
    this.cache.delete(index); this.cache.set(index, state);
    while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
  }
}
