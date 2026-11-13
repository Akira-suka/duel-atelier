import { useEffect, useRef, useState } from 'react';
import { archiveMatch } from '../game/archive';
import { serializeMatch, type MatchRecord } from '../game/match';
import type { GameState } from '../game/types';
import type { MatchAnalysis } from './match-analysis';

export const SAVE_KEY = 'splendor-duel.local.v1';

/** Counts save at most once per second; expensive completed-game validation at most every five. */
export function useMatchPersistence(record: MatchRecord, game: GameState, analysis: MatchAnalysis, current = true) {
  const [failed, setFailed] = useState(false);
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => {
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let archiveTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSaved = '', lastArchived = '', mounted = true;
    const persist = (includeArchive: boolean) => {
      let unsuccessful = false;
      try {
        const snapshot = analysis.snapshot(record);
        const text = serializeMatch(snapshot);
        if (current && text !== lastSaved) { localStorage.setItem(SAVE_KEY, text); lastSaved = text; }
        if (includeArchive && game.winner !== null && text !== lastArchived) {
          if (archiveMatch(localStorage, snapshot)) lastArchived = text;
          else unsuccessful = true;
        }
      } catch { unsuccessful = true; }
      if (mounted) setFailed(unsuccessful);
    };
    const clear = () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      if (archiveTimer !== null) clearTimeout(archiveTimer);
      saveTimer = archiveTimer = null;
    };
    const flush = () => { clear(); persist(true); };
    flushRef.current = flush;
    persist(true); // Every committed action is durable immediately.
    const unsubscribe = analysis.subscribe(() => {
      if (current && saveTimer === null) saveTimer = setTimeout(() => { saveTimer = null; persist(false); }, 1000);
      if (game.winner !== null && archiveTimer === null) archiveTimer = setTimeout(() => { archiveTimer = null; persist(true); }, 5000);
    });
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted = false; unsubscribe(); clear(); persist(true);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', visibility);
      if (flushRef.current === flush) flushRef.current = () => {};
    };
  }, [record, game, analysis, current]);
  return { failed, flush: () => flushRef.current() };
}
