import { useEffect, useMemo, useRef, useState } from 'react';
import { getJewel, getRoyal } from '../game/catalog';
import { getStats } from '../game/engine';
import { replayMatch, type MatchRecord } from '../game/match';
import { GEM_COLORS, TOKEN_COLORS, type Action, type CardSource, type GameState, type PlayerId } from '../game/types';
import { summarizeEstimate, type WinEstimate } from '../analysis/win-probability';
import { STANDARD_SAMPLES, DEEP_SAMPLES, type AnalysisMethod, type ProgressiveResponse } from '../analysis/progressive';
import { getCardArt, RESOURCE_NAMES } from '../theme';
import { Card, Crown, Gem, Royal, Token } from './TablePieces';
import './replay.css';

const cache = new WeakMap<MatchRecord, Partial<Record<AnalysisMethod, (WinEstimate | undefined)[]>>>();
function saveEstimates(record: MatchRecord, method: AnalysisMethod, values: (WinEstimate | undefined)[]) {
  cache.set(record, { ...cache.get(record), [method]: values });
}
const percent = (value: number) => `${Math.round(value * 100)}%`;
const delta = (value: number) => value > 0 ? `+${value}` : String(value);

function actionSummary(action: Action, before: GameState): string {
  const actor = before.players[before.turn];
  const cardName = (source: CardSource) => {
    if (source.kind === 'deck') return `${source.level} 级牌堆`;
    const id = source.kind === 'market' ? before.market[source.level][source.index] : actor.reserved[source.index];
    return id ? getCardArt(id).title : '卡牌';
  };
  const tokenAt = (index: number) => before.board[index] ? RESOURCE_NAMES[before.board[index]!] : '筹码';
  let detail: string;
  switch (action.type) {
    case 'usePrivilege': detail = `使用特权，拿取${tokenAt(action.index)}`; break;
    case 'refill': detail = '补充筹码盘'; break;
    case 'takeTokens': detail = `拿取${action.indices.map(tokenAt).join('、')}`; break;
    case 'reserve': detail = action.source.kind === 'deck' ? `从 ${action.source.level} 级牌堆盲预留` : `预留「${cardName(action.source)}」`; break;
    case 'buy': detail = `购买「${cardName(action.source)}」`; break;
    case 'chooseColor': detail = `将加成设为${RESOURCE_NAMES[action.color]}`; break;
    case 'takeBonusToken': detail = `获得同色奖励：${tokenAt(action.index)}`; break;
    case 'stealToken': detail = `拿取对手的${RESOURCE_NAMES[action.color]}`; break;
    case 'chooseRoyal': detail = `获得王室「${getCardArt(action.cardId).title}」`; break;
    case 'discard': detail = `归还${TOKEN_COLORS.filter(color => action.tokens[color] > 0).map(color => `${RESOURCE_NAMES[color]} ${action.tokens[color]}`).join('、')}`; break;
  }
  return `${actor.name} · ${detail}`;
}

function initialEstimates(record: MatchRecord, frames: GameState[], method: AnalysisMethod) {
  const values = cache.get(record)?.[method]?.slice() ?? [];
  frames.forEach((state, index) => {
    if (state.phase === 'gameOver' && state.winner !== null) values[index] = summarizeEstimate(state, [0, 0], 0, 0);
  });
  saveEstimates(record, method, values);
  return values;
}

function ProbabilityChart({ estimates, index, count, names, onSelect }: {
  estimates: (WinEstimate | undefined)[]; index: number; count: number;
  names: [string, string]; onSelect: (index: number) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(780);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(160, Math.round(element.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const x = (step: number) => 36 + step / Math.max(1, count - 1) * (width - 72);
  const y = (probability: number) => 12 + (1 - probability) * 96;
  const groups: number[][] = [];
  for (let step = 0; step < count; step++) {
    if (estimates[step]?.probability == null) continue;
    const last = groups[groups.length - 1];
    if (last && last[last.length - 1] === step - 1) last.push(step); else groups.push([step]);
  }
  return <div className="replay-chart">
    <svg ref={svg} viewBox={`0 0 ${width} 130`} role="img" aria-label={`${names[0]}与${names[1]}的逐步模拟胜率曲线，空白表示尚无估计。可使用下方步骤滑块定位。`}
      onPointerDown={event => {
        const matrix = event.currentTarget.getScreenCTM();
        if (!matrix) return;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        onSelect(Math.round(Math.max(0, Math.min(1, (point.x - 36) / (width - 72))) * Math.max(0, count - 1)));
      }}>
      {[0, .5, 1].map(value => <g key={value}><line className="replay-gridline" x1="36" x2={width - 36} y1={y(value)} y2={y(value)} /><text x="28" y={y(value) + 4} textAnchor="end">{percent(value)}</text></g>)}
      {groups.map((steps, group) => <g key={group}>
        {steps.length > 1 && <polygon className="replay-confidence" points={[
          ...steps.map(step => `${x(step)},${y(estimates[step]!.interval[1])}`),
          ...[...steps].reverse().map(step => `${x(step)},${y(estimates[step]!.interval[0])}`),
        ].join(' ')} />}
        {([0, 1] as const).map(player => <g key={player} className={`replay-curve replay-curve-${player}`}>
          {steps.length > 1 && <polyline points={steps.map(step => `${x(step)},${y(player === 0 ? estimates[step]!.probability! : 1 - estimates[step]!.probability!)}`).join(' ')} />}
          {steps.length === 1 && <circle cx={x(steps[0])} cy={y(player === 0 ? estimates[steps[0]]!.probability! : 1 - estimates[steps[0]]!.probability!)} r="3" />}
        </g>)}
      </g>)}
      <line className="replay-cursor" x1={x(index)} x2={x(index)} y1="8" y2="112" />
      <text x="36" y="125">起始</text><text x={width - 36} y="125" textAnchor="end">{count - 1} 步</text>
    </svg>
    <div className="replay-legend"><span className="replay-name-0">● {names[0]}</span><span className="replay-name-1">● {names[1]}</span><span>阴影：{names[0]} 95% 抽样区间</span></div>
  </div>;
}

function PlayerSnapshot({ state, previous, id }: { state: GameState; previous: GameState; id: PlayerId }) {
  const player = state.players[id];
  const before = previous.players[id];
  const stats = getStats(state, id);
  const prior = getStats(previous, id);
  const gained = new Set(player.cards.filter(card => !before.cards.some(old => old.cardId === card.cardId)).map(card => card.cardId));
  return <section className={`replay-player replay-player-${id}${state.turn === id ? ' replay-player-active' : ''}`} aria-label={`${player.name}在此步骤的状态`}>
    <div className="replay-player-title"><h3>{player.name}</h3>{state.winner === id ? <span>胜者</span> : state.turn === id && state.winner === null ? <span>当前行动</span> : null}</div>
    <div className="replay-stats"><span>声望 <b>{stats.points}</b>{stats.points !== prior.points && <em>{delta(stats.points - prior.points)}</em>}</span><span><Crown /><b>{stats.crowns}</b>{stats.crowns !== prior.crowns && <em>{delta(stats.crowns - prior.crowns)}</em>}</span><span>已购 <b>{player.cards.length}</b>{gained.size > 0 && <em>+{gained.size}</em>}</span><span>预留 <b>{player.reserved.length}</b></span><span>特权 <b>{player.privileges}</b>{player.privileges !== before.privileges && <em>{delta(player.privileges - before.privileges)}</em>}</span></div>
    <div className="replay-resources">{TOKEN_COLORS.map(color => {
      const change = player.tokens[color] - before.tokens[color];
      return <span key={color} title={`${RESOURCE_NAMES[color]} ${player.tokens[color]}枚${change ? `，本步${delta(change)}` : ''}`}><Gem color={color} small /><b>{player.tokens[color]}</b>{change !== 0 && <em className={change < 0 ? 'replay-loss' : ''}>{delta(change)}</em>}</span>;
    })}</div>
    <div className="replay-bonuses">{GEM_COLORS.map(color => <span key={color} title={`${RESOURCE_NAMES[color]}：永久加成${stats.bonuses[color]}，同色声望${stats.colorPoints[color]}`}><Gem color={color} small /><b>+{stats.bonuses[color]}</b><small>{stats.colorPoints[color]}分</small></span>)}</div>
    <details className="replay-card-details"><summary>卡牌详情 · 已购 {player.cards.length} / 预留 {player.reserved.length} / 王室 {player.royals.length}</summary>
      <div className="replay-owned" aria-label="此时已购卡牌">{player.cards.map(card => <div key={card.cardId} className={gained.has(card.cardId) ? 'replay-gained' : ''} title={getCardArt(card.cardId).title}><Card card={getJewel(card.cardId)} disabled /></div>)}{player.cards.length === 0 && <span className="replay-empty">尚未购牌</span>}</div>
      {player.reserved.length > 0 && <><h4>当时预留</h4><div className="replay-owned" aria-label="此时预留卡牌">{player.reserved.map(id => <div key={id} title={getCardArt(id).title}><Card card={getJewel(id)} disabled /></div>)}</div></>}
      {player.royals.length > 0 && <div className="replay-owned-royals">{player.royals.map(id => <Royal key={id} card={getRoyal(id)} disabled />)}</div>}
    </details>
  </section>;
}

export function ReplayPanel({ record, onClose }: { record: MatchRecord; onClose: () => void }) {
  const rebuilt = useMemo(() => {
    try { return { frames: replayMatch(record), error: '' }; }
    catch (error) { return { frames: [record.initial], error: error instanceof Error ? error.message : '无法重建此对局' }; }
  }, [record]);
  const frames = rebuilt.frames;
  const [index, setIndex] = useState(frames.length - 1);
  const [playing, setPlaying] = useState(false);
  const [method, setMethod] = useState<AnalysisMethod>('baseline');
  const [estimates, setEstimates] = useState(() => initialEstimates(record, frames, 'baseline'));
  const [analysisError, setAnalysisError] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const analysisWorker = useRef<{ worker: Worker; id: string } | null>(null);
  const selectedStep = useRef(index);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const safeIndex = Math.max(0, Math.min(index, frames.length - 1));
  selectedStep.current = safeIndex;
  const state = frames[safeIndex];
  const previous = frames[Math.max(0, safeIndex - 1)];
  const current = estimates[safeIndex];
  const roundedProbability = current?.probability != null ? Math.round(current.probability * 100) : null;
  const names: [string, string] = [state.players[0].name, state.players[1].name];
  const partial = record.initial.revision > 0;
  const finishedPoints = frames.reduce((total, _, step) => total + Number(estimates[step] !== undefined), 0);
  const refinedPoints = frames.reduce((total, _, step) => total + Number(estimates[step]?.terminal || (estimates[step]?.requested ?? 0) >= STANDARD_SAMPLES), 0);
  const select = (step: number) => { setPlaying(false); setIndex(Math.max(0, Math.min(frames.length - 1, step))); };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  useEffect(() => {
    if (!playing) return;
    if (safeIndex >= frames.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setIndex(step => step + 1), 1100);
    return () => window.clearTimeout(timer);
  }, [playing, safeIndex, frames.length]);

  useEffect(() => {
    const values = initialEstimates(record, frames, method);
    setEstimates(values.slice());
    setAnalysisError('');
    if (rebuilt.error) { setAnalyzing(false); return; }
    let alive = true;
    let worker: Worker;
    setAnalyzing(true);
    const id = `replay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      worker = new Worker(new URL('../analysis/analysis.worker.ts', import.meta.url), { type: 'module' });
      analysisWorker.current = { worker, id };
      worker.onmessage = (event: MessageEvent<ProgressiveResponse>) => {
        if (!alive || event.data.id !== id) return;
        const message = event.data;
        if (message.type === 'point') {
          const step = message.index;
          if (!frames[step]) return;
          values[step] = message.estimate;
          saveEstimates(record, method, values);
          setEstimates(values.slice());
        } else if (message.type === 'done') {
          setAnalyzing(false);
        } else {
          setAnalysisError(message.message); setAnalyzing(false); worker.terminate(); analysisWorker.current = null;
        }
      };
      worker.onerror = event => {
        if (!alive) return;
        setAnalysisError(event.message || '本地模拟暂时无法运行'); setAnalyzing(false); worker.terminate(); analysisWorker.current = null;
      };
      worker.postMessage({ type: 'analyze', id, states: frames, method, resume: values, focus: selectedStep.current });
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : '浏览器无法启动本地模拟'); setAnalyzing(false);
    }
    return () => { alive = false; worker?.terminate(); analysisWorker.current = null; };
  }, [record, frames, rebuilt.error, method]);

  useEffect(() => {
    const active = analysisWorker.current;
    if (active) active.worker.postMessage({ type: 'focus', id: active.id, index: safeIndex });
  }, [safeIndex]);

  const deepen = () => {
    const active = analysisWorker.current;
    if (!active) return;
    setAnalyzing(true);
    active.worker.postMessage({ type: 'focus', id: active.id, index: safeIndex, deep: true });
  };

  const summary = safeIndex > 0 ? actionSummary(record.actions[safeIndex - 1], previous) : undefined;
  return <div className="replay-overlay" role="dialog" aria-modal="true" aria-labelledby="replay-title" ref={panel} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPlaying(false); onClose(); return; }
    if (event.key !== 'Tab') return;
    const targets = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]') ?? [])].filter(node => node.getClientRects().length > 0);
    const first = targets[0], last = targets[targets.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="replay-shell">
      <header className="replay-header"><div><h2 id="replay-title">对局回放</h2><p>{partial ? `从续局开始记录 · 起始已完成 ${record.initial.revision} 步` : '完整对局记录'} · {frames.length - 1} 步行动{frames.length === 1 ? ' · 只有当前终局快照，没有早期行动记录' : ''}</p></div><button ref={closeButton} type="button" className="replay-close" onClick={() => { setPlaying(false); onClose(); }} aria-label="关闭回放">关闭 ×</button></header>
      {rebuilt.error && <p role="alert" className="replay-error">记录重建失败：{rebuilt.error}</p>}
      <section className="replay-analysis" aria-label="本地模拟胜率">
        <div className="replay-analysis-modes" role="group" aria-label="预测策略">
          {(['baseline', 'search'] as const).map(value => <button type="button" key={value} aria-pressed={method === value} onClick={() => {
            if (method !== value) { setEstimates(initialEstimates(record, frames, value)); setMethod(value); }
          }}>{value === 'baseline' ? '快速基线' : '搜索复核 · 较慢'}</button>)}
          <span>搜索策略对战更强，概率误差暂未优于基线</span>
        </div>
        <div className="replay-probabilities">{([0, 1] as const).map(id => <div key={id} className={`replay-probability replay-name-${id}`}><span>{names[id]}</span><strong>{roundedProbability !== null ? `${id === 0 ? roundedProbability : 100 - roundedProbability}%` : estimates[safeIndex] ? '暂无估计' : analysisError ? '未计算' : '计算中'}</strong><small>{current?.terminal ? '本局结果' : current?.probability != null ? `${id === 0 ? Math.round(current.interval[0] * 100) : 100 - Math.round(current.interval[1] * 100)}%–${id === 0 ? Math.round(current.interval[1] * 100) : 100 - Math.round(current.interval[0] * 100)}%` : '—'}</small></div>)}<div className="replay-analysis-status"><b>{method === 'search' ? '搜索续弈估计' : '快速续弈估计'}</b><span>{analyzing ? '正在分析' : analysisError ? '分析已中断' : '分析完成'} · {finishedPoints}/{frames.length} 已出结果 · {refinedPoints} 已精算</span><progress max={frames.length} value={refinedPoints} aria-label="胜率分析进度" /><small>{current?.terminal ? '终局直接采用真实结果' : current ? `${current.completed}/${current.requested} 次模拟完成${current.unfinished ? `，${current.unfinished} 次截断` : ''}` : `先 8 次，再补至 ${STANDARD_SAMPLES} 次`}</small><button type="button" onClick={deepen} disabled={!!current?.terminal || (current?.requested ?? 0) >= DEEP_SAMPLES || !!analysisError}>精算此步 · {DEEP_SAMPLES} 次</button></div></div>
        <ProbabilityChart estimates={estimates} index={safeIndex} count={frames.length} names={names} onSelect={select} />
        {analysisError && <p className="replay-error" role="status">{analysisError}；已完成的结果仍可查看，关闭重开可继续。</p>}
        <details className="replay-method"><summary>估计方法</summary><p>快速基线使用原有随机启发式策略；搜索复核加入战术检查与有限预算 MCTS。两种策略分别统计、分别缓存。每次从当前局面重新打乱未知牌库和袋中筹码，续弈到实际终局后统计胜负。搜索叶评分和访问次数不直接作为胜率。优先分析选中的步骤，其余步骤先做 8 次再补至 24 次，可单独精算至 64 次；关闭回放会停止计算，重开继续已有样本。局后分析使用双方当时预留牌的完整信息，不读取之后的实际行动。胜率仅针对这套模拟策略，不等于真人胜率。阴影是单个固定样本量的 95% 抽样区间，不保证整条曲线或反复查看时同时覆盖，也不包含策略误差；截断会扩大区间。最终真实胜者只用于终局帧。</p></details>
      </section>
      <nav className="replay-controls" aria-label="回放步骤"><button type="button" onClick={() => select(0)} disabled={safeIndex === 0}>起始</button><button type="button" onClick={() => select(safeIndex - 1)} disabled={safeIndex === 0} aria-label="上一步">←</button><button type="button" className="replay-play" disabled={frames.length < 2} onClick={() => { if (!playing && safeIndex === frames.length - 1) setIndex(0); setPlaying(value => !value); }}>{playing ? '暂停' : '播放'}</button><button type="button" onClick={() => select(safeIndex + 1)} disabled={safeIndex === frames.length - 1} aria-label="下一步">→</button><input type="range" min="0" max={frames.length - 1} value={safeIndex} disabled={frames.length < 2} aria-label="回放步骤" aria-valuetext={`第 ${safeIndex} 步，共 ${frames.length - 1} 步`} onChange={event => select(Number(event.target.value))} /><output>{safeIndex} / {frames.length - 1}</output><button type="button" onClick={() => select(frames.length - 1)} disabled={safeIndex === frames.length - 1}>终局</button></nav>
      <div className="replay-step"><b>{safeIndex === 0 ? '起始局面' : `第 ${safeIndex} 步`}</b><span>{summary ?? (state.winner !== null ? `${state.players[state.winner].name}获胜` : `第 ${state.turnNumber} 回合 · ${state.players[state.turn].name}`)}</span></div>
      <div className="replay-position">
        <section className="replay-market" aria-label="历史牌市">{([3, 2, 1] as const).map(level => <div className="replay-market-row" key={level}><span className="replay-level">{level}<small>余 {state.decks[level].length}</small></span><div className="replay-market-cards">{state.market[level].map((id, slot) => id ? <Card key={`${slot}-${id}`} card={getJewel(id)} disabled /> : <span key={slot} className="replay-card-empty" />)}</div></div>)}</section>
        <section className="replay-board-area" aria-label="历史筹码棋盘"><div className="replay-board">{state.board.map((color, cell) => <span key={cell} className="replay-board-cell" title={`第${Math.floor(cell / 5) + 1}行第${cell % 5 + 1}列：${color ? RESOURCE_NAMES[color] : '空'}`}>{color && <Token color={color} />}</span>)}</div><div className="replay-board-caption"><span>袋中 {state.bag.length}</span><span>公共特权 {state.privilegeSupply}</span></div><div className="replay-royals">{state.royals.map(id => <Royal key={id} card={getRoyal(id)} disabled />)}</div></section>
        <div className="replay-players">{([0, 1] as const).map(id => <PlayerSnapshot key={id} state={state} previous={previous} id={id} />)}</div>
      </div>
    </div>
  </div>;
}
