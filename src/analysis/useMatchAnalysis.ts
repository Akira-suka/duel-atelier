import { useEffect, useState } from 'react';
import type { MatchRecord } from '../game/match';
import type { GameState } from '../game/types';
import { MatchAnalysis } from './match-analysis';

export function useMatchAnalysis(record: MatchRecord, game: GameState, enabled: boolean, busy: boolean) {
  const [analysis] = useState(() => new MatchAnalysis());
  useEffect(() => { analysis.update(record, game); }, [analysis, record, game]);
  useEffect(() => {
    const sync = () => analysis.setActivity(enabled, document.visibilityState !== 'hidden', busy);
    sync(); document.addEventListener('visibilitychange', sync);
    return () => { document.removeEventListener('visibilitychange', sync); analysis.suspend(); };
  }, [analysis, enabled, busy]);
  return analysis;
}
