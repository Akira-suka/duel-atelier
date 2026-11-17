import { describe, expect, it } from 'vitest';
import { summarizePerformance, type DecisionLoss } from './match-performance';

describe('whole-match performance', () => {
  const decisions: DecisionLoss[] = [
    { actor: 0, turn: 1, loss: .2, forced: false },
    { actor: 0, turn: 1, loss: 0, forced: false },
    { actor: 1, turn: 2, loss: .3, forced: false },
    { actor: 0, turn: 3, loss: .3, forced: false },
    { actor: 0, turn: 3, loss: 0, forced: true },
  ];
  it('equally weights turns, separates players and excludes forced clicks', () => {
    const result = summarizePerformance(decisions, 5, false);
    expect(result[0]).toMatchObject({ score: 80, turns: 2, complete: true });
    expect(result[1].score).toBe(70);
  });
  it('withholds final grades for missing actions, partial records and failed simulations', () => {
    expect(summarizePerformance(decisions, 6, false).every(row => row.score === null)).toBe(true);
    expect(summarizePerformance(decisions, 5, true).every(row => row.score === null)).toBe(true);
    const truncated = decisions.map(row => ({ ...row, loss: null }));
    expect(summarizePerformance(truncated, 5, false).every(row => row.score === null)).toBe(true);
    expect(summarizePerformance([], 0, false).every(row => row.score === null)).toBe(true);
  });
  it('does not award free points for forced actions', () => {
    expect(summarizePerformance([{ actor: 0, turn: 1, loss: 0, forced: true }], 1, false)[0].score).toBeNull();
  });
});
