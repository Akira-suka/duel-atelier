import type { GameState } from '../game/types';
import { positionSeed } from './win-probability';

// Bump an identifier whenever rules, card data, policy, seed schedule or rollout limits change.
export const ANALYSIS_POLICIES = {
  baseline: 'baseline-v1:s600:r5eeda11',
  search: 'tactical-puct-v1:i8:d6:s600:r5eeda11',
} as const;

/** Public-position identity, not a cryptographic authenticity guarantee. */
export function analysisPositionKey(state: GameState) {
  return [positionSeed(state), positionSeed(state, 0x9e3779b9)]
    .map(value => value.toString(16).padStart(8, '0')).join('');
}
