import { applyAction } from '../game/engine';
import type { Action, GameState } from '../game/types';
import { searchActionKey } from './search';
import { enumerateTacticalActions, findImmediateWin } from './tactics';
import { policyPriors, positionSeed, randomizeFuture, runPlayout, sampleSeed } from './win-probability';

export interface CandidateReview { action: Action; wins: number; losses: number; unfinished: number; probability: number | null }
export interface ActionReview { candidates: CandidateReview[]; actual: CandidateReview; samples: number; legalCount: number; score: number | null; loss: number | null }
export function performanceScore(best: number, actual: number) { return Math.round(100 * (1 - Math.max(0, best - actual))); }

/** Fixed-budget counterfactuals; resample BEFORE the action, never use the recorded next frame. */
export async function reviewAction(state: GameState, actual: Action, yieldSample: () => Promise<void> = async () => {}) : Promise<ActionReview> {
  const legal = enumerateTacticalActions(state, { maxActions: 192 }).actions;
  const priors = policyPriors(state, legal);
  const selected = legal.map((action, i) => ({ action, prior: priors[i] })).sort((a,b) => b.prior-a.prior).slice(0, 6).map(item => item.action);
  const winning = findImmediateWin(state, { maxNodes: 80, maxDepth: 12, maxActions: 192 });
  if (winning.status === 'win' && winning.action && !selected.some(action => searchActionKey(action) === searchActionKey(winning.action!))) {
    selected.unshift(winning.action); selected.splice(6);
  }
  // Always compare the player's exact action, including a custom payment.
  if (!applyAction(state, actual).ok) throw Error('无法评价非法操作');
  const unique = new Map([...selected, actual].map(action => [searchActionKey(action), action]));
  const candidates: CandidateReview[] = [...unique.values()].map(action => ({ action, wins: 0, losses: 0, unfinished: 0, probability: null }));
  const samples = 24;
  for (let sample = 0; sample < samples; sample++) {
    const seed = sampleSeed(positionSeed(state, 0x731b91), sample);
    for (const candidate of candidates) {
      const result = applyAction(randomizeFuture(state, seed), candidate.action);
      if (!result.ok) throw Error(result.error);
      const winner = result.state.winner ?? runPlayout(result.state, seed ^ 0x41c6ce57, 600).winner;
      if (winner === null) candidate.unfinished++; else if (winner === state.turn) candidate.wins++; else candidate.losses++;
      await yieldSample();
    }
  }
  for (const item of candidates) item.probability = item.wins + item.losses ? item.wins / (item.wins + item.losses) : null;
  candidates.sort((a,b) => (b.probability ?? -1) - (a.probability ?? -1) || searchActionKey(a.action).localeCompare(searchActionKey(b.action)));
  const played = candidates.find(item => searchActionKey(item.action) === searchActionKey(actual))!;
  const best = candidates[0].probability;
  const valid = best !== null && played.probability !== null && candidates.every(item => !item.unfinished);
  return { candidates, actual: played, samples, legalCount: legal.length, score: valid ? performanceScore(best!, played.probability!) : null,
    loss: valid ? Math.max(0, best! - played.probability!) : null };
}
