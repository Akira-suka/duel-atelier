import { useEffect, useState } from 'react';
import type { ArchivedMatch } from '../game/archive';
import { serializeMatch } from '../game/match';
import { useMatchAnalysis } from '../analysis/useMatchAnalysis';
import { useMatchPersistence } from '../analysis/useMatchPersistence';
import { ReplayPanel } from './ReplayPanel';

/** Its owner pauses the live coordinator before mounting this independent historical view. */
export function ArchivedReplay({ item, onClose }: { item: ArchivedMatch; onClose: () => void }) {
  const analysis = useMatchAnalysis(item.record, item.game, false, false);
  const persistence = useMatchPersistence(item.record, item.game, analysis, false);
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  const exportBackup = () => {
    const blob = new Blob([serializeMatch(analysis.snapshot(item.record))], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `duel-history-${item.id}.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <>
    {ready && <ReplayPanel record={item.record} analysis={analysis} onClose={() => { persistence.flush(); onClose(); }}
      notice={persistence.failed && <div className="archive-save-warning" role="status">历史分析暂未保存。
        <button type="button" onClick={exportBackup}>导出历史存档</button></div>} />}
  </>;
}
