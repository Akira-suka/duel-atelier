import { describe, expect, it } from 'vitest';
import { createGame, getLegalActions } from '../game/engine';
import { performanceScore, reviewAction } from './action-review';
import { searchActionKey } from './search';

describe('counterfactual action review', () => {
  it('scores probability-point regret rather than observed next-frame change', () => {
    expect(performanceScore(.7,.6)).toBe(90);
    expect(performanceScore(.6,.7)).toBe(100);
    expect(performanceScore(1,0)).toBe(0);
  });
  it('includes actual play, bounds work and never mutates the original state', async () => {
    const state = createGame('review-coverage'); const original = structuredClone(state);
    const actual = getLegalActions(state).at(-1)!;
    const review = await reviewAction(state, actual);
    expect(state).toEqual(original);
    expect(review.candidates.length).toBeLessThanOrEqual(7);
    expect(searchActionKey(review.actual.action)).toBe(searchActionKey(actual));
    for (const candidate of review.candidates) expect(candidate.wins+candidate.losses+candidate.unfinished).toBe(24);
    expect(review.score === null || review.score >= 0 && review.score <= 100).toBe(true);
    // Hidden recorded deck/bag order must not leak into any candidate's evaluation.
    for (const level of [1,2,3] as const) state.decks[level].reverse();
    state.bag.reverse(); state.rng = 99; state.log = ['unrelated future record'];
    expect(await reviewAction(state, actual)).toEqual(review);
  }, 30000);
});
