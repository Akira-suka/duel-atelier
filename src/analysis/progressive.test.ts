import { describe, expect, it, vi } from 'vitest';
import { createGame } from '../game/engine';
import type { PlayerId } from '../game/types';
import { ProgressiveAnalysis, type ProgressiveCommand, type ProgressiveResponse } from './progressive';
import * as baseline from './win-probability';
import * as search from './search-policy';

describe('progressive replay analysis', () => {
  it('routes the default baseline and optional search to separate real policies', () => {
    const oldRun = vi.spyOn(baseline, 'runPlayout');
    const newRun = vi.spyOn(search, 'runSearchPlayout');
    try {
      const states = [createGame('method-routing')];
      new ProgressiveAnalysis(states, [], { maxActions: 1 }).advance(0);
      expect(oldRun).toHaveBeenCalledTimes(1); expect(newRun).not.toHaveBeenCalled();
      new ProgressiveAnalysis(states, [], { maxActions: 1 }, 'search').advance(0);
      expect(oldRun).toHaveBeenCalledTimes(1); expect(newRun).toHaveBeenCalledTimes(1);
    } finally { oldRun.mockRestore(); newRun.mockRestore(); }
  });
  it('prioritizes the selected frame then covers all frames before refining', () => {
    const analysis = new ProgressiveAnalysis([createGame('a'), createGame('b'), createGame('c')]);
    analysis.prioritize(2);
    const complete = () => ({ winner: 0 as PlayerId, actions: 1 });
    for (let i = 0; i < 24; i++) { expect(analysis.next()).toBe(2); analysis.advance(2, complete); }
    for (let i = 0; i < 8; i++) { expect(analysis.next()).toBe(0); analysis.advance(0, complete); }
    for (let i = 0; i < 8; i++) { expect(analysis.next()).toBe(1); analysis.advance(1, complete); }
    expect(analysis.next()).toBe(0);
    analysis.prioritize(1, true);
    for (let i = 8; i < 64; i++) { expect(analysis.next()).toBe(1); analysis.advance(1, complete); }
    expect(analysis.next()).toBe(0);
  });

  it('resumes the exact seed stream without repeating samples or counting truncations as wins', () => {
    const state = createGame('resume'); const seen: number[] = [];
    const playout = (_: unknown, seed: number) => { seen.push(seed); return { winner: seed % 3 ? (seed % 2) as PlayerId : null, actions: 1 }; };
    const uninterrupted = new ProgressiveAnalysis([state]);
    for (let i = 0; i < 24; i++) uninterrupted.advance(0, playout);
    const allSeeds = seen.splice(0);
    const first = new ProgressiveAnalysis([state]);
    for (let i = 0; i < 8; i++) first.advance(0, playout);
    const resumed = new ProgressiveAnalysis([state], first.estimates);
    for (let i = 8; i < 24; i++) resumed.advance(0, playout);
    expect(seen).toEqual(allSeeds);
    expect(new Set(seen).size).toBe(24);
    expect(resumed.estimates).toEqual(uninterrupted.estimates);
    expect(resumed.estimates[0]!.unfinished).toBeGreaterThan(0);
    expect(resumed.next()).toBe(-1);
  });

  it('never simulates terminal frames and rejects inconsistent cached counts', () => {
    const end = createGame('end'); end.winner = 1; end.phase = 'gameOver';
    const analysis = new ProgressiveAnalysis([end, createGame('invalid-cache')], [undefined, {
      probability: 1, interval: [1, 1], wins: [24, 0], completed: 24, unfinished: 0, requested: 8, terminal: false,
    }]);
    analysis.prioritize(0, true);
    expect(analysis.next()).toBe(1);
    expect(analysis.estimates[0]).toMatchObject({ probability: 0, terminal: true, requested: 0 });
    expect(analysis.estimates[1]).toBeUndefined();
    analysis.prioritize(NaN); expect(analysis.next()).toBe(1);
  });

  it('streams worker results, continues cached samples, and suppresses cancelled jobs', async () => {
    const scope: { onmessage: ((event: MessageEvent<ProgressiveCommand>) => Promise<void>) | null } = { onmessage: null };
    const messages: ProgressiveResponse[] = [];
    vi.stubGlobal('self', scope); vi.stubGlobal('postMessage', (message: ProgressiveResponse) => messages.push(structuredClone(message)));
    try {
      await import('./analysis.worker');
      const terminal = createGame('worker-end'); terminal.phase = 'gameOver'; terminal.winner = 0;
      const send = (data: ProgressiveCommand) => scope.onmessage!({ data } as MessageEvent<ProgressiveCommand>);
      await send({ type: 'analyze', id: 'complete', states: [createGame('worker-start'), terminal], options: { samples: 1, maxActions: 1 } });
      expect(messages.map(message => message.type)).toEqual(['point', 'point', 'done']);
      expect(messages[0]).toMatchObject({ index: 1, estimate: { probability: 1, terminal: true } });
      expect(messages[1]).toMatchObject({ index: 0, estimate: { probability: null, unfinished: 1 } });
      const cached = messages[1]; if (cached.type !== 'point') throw new Error('missing result');
      messages.length = 0;
      await send({ type: 'analyze', id: 'resume', states: [createGame('worker-start')], resume: [cached.estimate], options: { samples: 2, maxActions: 1 } });
      expect(messages[1]).toMatchObject({ estimate: { requested: 2, unfinished: 2 } });
      expect(messages.at(-1)?.type).toBe('done');
      messages.length = 0;
      const pending = send({ type: 'analyze', id: 'cancelled', states: [createGame('worker-cancel')], options: { samples: 24, maxActions: 1 } });
      await send({ type: 'cancel', id: 'cancelled' }); await pending;
      expect(messages).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });
});
