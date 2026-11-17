import type { PlayerId } from '../game/types';

export interface DecisionLoss { actor: PlayerId; turn: number; loss: number | null; forced: boolean }

/** Equal weight per turn, so multi-click card effects do not outweigh ordinary turns. */
export function summarizePerformance(decisions: Iterable<DecisionLoss>, total: number, partial: boolean) {
  const rows = [...decisions];
  const complete = rows.length === total && total > 0;
  return ([0, 1] as const).map(actor => {
    const own = rows.filter(row => row.actor === actor && !row.forced);
    const turns = new Map<number, number[]>();
    for (const row of own) if (row.loss !== null) {
      const losses = turns.get(row.turn) ?? [];
      losses.push(row.loss); turns.set(row.turn, losses);
    }
    const valid = complete && !partial && own.length > 0 && own.every(row => row.loss !== null);
    const meanLoss = valid ? [...turns.values()].reduce((sum, losses) => sum + losses.reduce((a,b) => a+b, 0) / losses.length, 0) / turns.size : null;
    return { actor, reviewed: rows.length, total, complete, turns: turns.size, meanLoss,
      score: meanLoss === null ? null : Math.round(100 * (1 - meanLoss)) };
  });
}
