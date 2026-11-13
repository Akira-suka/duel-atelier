import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  applyAction, canBuy, countTokens, createGame, emptyWallet, getDiscountedCost,
  getLegalActions, getPayment, getStats,
} from './game/engine';
import { createMatch, parseMatch, serializeMatch, replayMatch, MAX_MATCH_ACTIONS, MAX_MATCH_BYTES, type MatchRecord } from './game/match';
import { getJewel, getRoyal } from './game/catalog';
import {
  COST_COLORS, GEM_COLORS, TOKEN_COLORS,
  type Action, type CardSource, type GameState, type Level,
  type PlayerId, type TokenColor, type Wallet,
} from './game/types';
import { Gem, Token, Scroll, Card, Royal, Portrait, Crown } from './ui/TablePieces';
import { DECKS, RESOURCE_NAMES as COLOR_NAMES, themedLog, themedText } from './theme';
import { useTableMotion } from './ui/useTableMotion';
import { ReplayPanel } from './ui/ReplayPanel';

const SAVE_KEY = 'splendor-duel.local.v1';
const DEFAULT_PLAYER_NAMES: [string, string] = ['Asuka', 'Sinji'];
type Mode = 'take' | 'buy' | 'reserve' | 'privilege';
type CardTarget = { id: string; source: CardSource };

function updateDefaultNames(state: GameState): GameState {
  const legacy = [['玩家一', '玩家1'], ['玩家二', '玩家2']];
  return { ...state, players: state.players.map((player, index) =>
    legacy[index].includes(player.name) ? { ...player, name: DEFAULT_PLAYER_NAMES[index] } : player,
  ) as GameState['players'] };
}

function renameMatch(restored: { record: MatchRecord; game: GameState }) {
  const { record } = restored;
  const initial = updateDefaultNames(record.initial);
  if (initial.players.every((player, index) => player.name === record.initial.players[index].name)) return restored;
  const renamed = { ...record, initial };
  return { record: renamed, game: replayMatch(renamed).at(-1)! };
}

function loadMatch(): { record: MatchRecord; game: GameState } {
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) {
      const restored = parseMatch(saved);
      if (restored) return renameMatch(restored);
    }
  } catch { /* Storage is optional; the game remains playable. */ }
  const game = createGame(undefined, DEFAULT_PLAYER_NAMES);
  return { game, record: createMatch(game) };
}

function Modal({ title, className = '', onClose, children }: {
  title: string; className?: string; onClose: () => void; children: ReactNode;
}) {
  return <div className="modal-backdrop" onClick={onClose}>
    <section className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
      <button type="button" className="modal-close" aria-label={`关闭${title}`} onClick={onClose}>×</button>
      <h2>{title}</h2>{children}
    </section>
  </div>;
}

export default function App() {
  const [match, setMatch] = useState(loadMatch);
  const { game, record } = match;
  const [handoff, setHandoff] = useState(true);
  const [mode, setMode] = useState<Mode>('take');
  const [indices, setIndices] = useState<number[]>([]);
  const [goldIndex, setGoldIndex] = useState<number | null>(null);
  const [target, setTarget] = useState<CardTarget | null>(null);
  const [payment, setPayment] = useState<Wallet>(emptyWallet);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [discard, setDiscard] = useState<Wallet>(emptyWallet);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [reserveOpen, setReserveOpen] = useState(false);
  const [collection, setCollection] = useState<PlayerId | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [names, setNames] = useState<[string, string]>([game.players[0].name, game.players[1].name]);
  const [saveFailed, setSaveFailed] = useState(false);
  const [tableScale, setTableScale] = useState(() => Math.min(window.innerWidth / 1600, window.innerHeight / 900));
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);
  const motion = useTableMotion();
  const playLock = useRef(false);
  const transitionId = useRef(0);
  const importRequestId = useRef(0);
  const [visualPlayer, setVisualPlayer] = useState<PlayerId | null>(null);
  const displayTurn = visualPlayer ?? game.turn;
  const inputLocked = motion.busy || visualPlayer !== null;

  const current = game.players[displayTurn];
  const legal = useMemo(() => getLegalActions(game), [game]);
  const stats = useMemo(() => [getStats(game, 0), getStats(game, 1)], [game]);
  const isMain = game.phase === 'start' || game.phase === 'main';
  const canRefill = legal.some(action => action.type === 'refill');
  const canPrivilege = legal.some(action => action.type === 'usePrivilege');
  const canReserve = legal.some(action => action.type === 'reserve');
  const cost = target && target.source.kind !== 'deck' ? getDiscountedCost(game, game.turn, target.id) : null;
  const affordable = !!target && target.source.kind !== 'deck' && canBuy(game, game.turn, target.id);
  const validTake = legal.some(action => action.type === 'takeTokens'
    && action.indices.length === indices.length && action.indices.every(index => indices.includes(index)));
  const totalDiscard = countTokens(discard);
  const givesPrivilege = validTake && (
    indices.length === 3 && indices.every(index => game.board[index] === game.board[indices[0]])
    || indices.filter(index => game.board[index] === 'pearl').length === 2
  );

  useEffect(() => {
    try { localStorage.setItem(SAVE_KEY, serializeMatch(record)); setSaveFailed(false); }
    catch { setSaveFailed(true); }
  }, [record]);

  useEffect(() => () => { transitionId.current++; }, []);

  useEffect(() => {
    const resize = () => setTableScale(Math.min(window.innerWidth / 1600, window.innerHeight / 900));
    const syncFullscreen = () => { setFullscreen(!!document.fullscreenElement); resize(); };
    window.addEventListener('resize', resize);
    document.addEventListener('fullscreenchange', syncFullscreen);
    resize();
    return () => {
      window.removeEventListener('resize', resize);
      document.removeEventListener('fullscreenchange', syncFullscreen);
    };
  }, []);

  useEffect(() => {
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setReserveOpen(false); setCollection(null); setLogOpen(false); setNewGameOpen(false);
      setMenuOpen(false); setPaymentOpen(false); setReplayOpen(false);
    }
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, []);

  useEffect(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'));
    const dialog = handoff && game.phase !== 'gameOver'
      ? document.querySelector<HTMLElement>('.handoff-modal') : dialogs.at(-1);
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
    ));
    const frame = requestAnimationFrame(() => focusable()[0]?.focus());
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0]; const last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog!.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog!.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', trapFocus);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', trapFocus); previousFocus?.focus(); };
  }, [handoff, game.phase, reserveOpen, collection, logOpen, newGameOpen]);

  function clearSelection(nextMode: Mode = 'take') {
    setMode(nextMode); setIndices([]); setGoldIndex(null); setTarget(null);
    setPayment(emptyWallet()); setPaymentOpen(false); setDiscard(emptyWallet());
    setError(''); setNotice('');
  }

  async function play(action: Action) {
    if (playLock.current || handoff || game.phase === 'gameOver') return;
    const result = applyAction(game, action);
    if (!result.ok) { setError(themedText(result.error)); return; }
    const next = result.state;
    const id = ++transitionId.current;
    playLock.current = true;
    setVisualPlayer(game.turn);
    let committed = false;
    const commit = () => {
      if (committed || id !== transitionId.current) return;
      committed = true;
      clearSelection(); setReserveOpen(false); setCollection(null); setMenuOpen(false);
      const history = record.actions.length >= MAX_MATCH_ACTIONS ? createMatch(game) : record;
      setMatch({ game: next, record: { ...history, actions: [...history.actions, structuredClone(action)] } });
    };
    try { await motion.animate(game, next, action, commit); }
    catch { commit(); } // A missing animation API must never prevent a legal move.
    finally {
      if (id === transitionId.current) {
        playLock.current = false;
        setVisualPlayer(null);
        if (next.turn !== game.turn && next.phase !== 'gameOver') setHandoff(true);
        else if (next.turnNumber !== game.turnNumber && next.phase !== 'gameOver') setNotice('额外回合');
      }
    }
  }

  function selectCard(id: string, source: CardSource) {
    if (!isMain || handoff || inputLocked) return;
    setTarget({ id, source }); setIndices([]); setError(''); setNotice(''); setPaymentOpen(false);
    if (mode !== 'reserve' || source.kind === 'reserve') {
      setMode('buy'); setGoldIndex(null); setPayment(getPayment(game, game.turn, id) ?? emptyWallet());
    }
    setReserveOpen(false);
  }

  function selectDeck(level: Level) {
    if (!isMain || handoff || inputLocked || !canReserve || !game.decks[level].length) return;
    setTarget({ id: `${level}级牌库`, source: { kind: 'deck', level } });
    setMode('reserve'); setIndices([]); setPaymentOpen(false); setError(''); setNotice('');
  }

  function changeCardAction(nextMode: 'buy' | 'reserve') {
    if (!target) return;
    setMode(nextMode); setIndices([]); setPaymentOpen(false); setError('');
    if (nextMode === 'buy') { setGoldIndex(null); setPayment(getPayment(game, game.turn, target.id) ?? emptyWallet()); }
  }

  function boardClick(index: number) {
    if (handoff || inputLocked) return;
    if (game.pending?.kind === 'takeBonusToken') { play({ type: 'takeBonusToken', index }); return; }
    if (!isMain) return;
    if (mode === 'privilege') { play({ type: 'usePrivilege', index }); return; }
    if (mode === 'reserve' || game.board[index] === 'gold') {
      setMode('reserve'); setGoldIndex(index); setIndices([]); setPaymentOpen(false); setError('');
      if (target?.source.kind === 'reserve') setTarget(null);
      return;
    }
    if (mode !== 'take') { clearSelection(); setIndices([index]); return; }
    if (indices.includes(index)) setIndices(indices.filter(i => i !== index));
    else if (indices.length < 3) setIndices([...indices, index]);
    else setError('最多选择三枚筹码');
  }

  function boardAllowed(index: number) {
    if (handoff) return false;
    if (game.pending?.kind === 'takeBonusToken') return game.pending.indices.includes(index);
    if (!isMain) return false;
    if (mode === 'reserve') return canReserve && game.board[index] === 'gold';
    if (mode === 'privilege') return legal.some(action => action.type === 'usePrivilege' && action.index === index);
    if (game.board[index] === 'gold') return canReserve;
    return indices.includes(index) || legal.some(action => action.type === 'takeTokens'
      && action.indices.includes(index) && (mode !== 'take' || indices.every(i => action.indices.includes(i))));
  }

  function adjustPayment(color: typeof COST_COLORS[number], delta: number) {
    if (!cost) return;
    const next = { ...payment, [color]: payment[color] + delta, gold: payment.gold - delta };
    if (next[color] < 0 || next[color] > cost[color] || next[color] > current.tokens[color]
      || next.gold < 0 || next.gold > current.tokens.gold) return;
    setPayment(next); setError('');
  }

  function adjustDiscard(color: TokenColor, delta: number) {
    if (game.pending?.kind !== 'discard') return;
    const value = discard[color] + delta;
    if (value < 0 || value > current.tokens[color] || totalDiscard + delta > game.pending.count) return;
    setDiscard({ ...discard, [color]: value });
  }

  function startNewGame() {
    transitionId.current++; motion.cancel(); playLock.current = false; setVisualPlayer(null);
    const cleaned: [string, string] = [names[0].trim() || DEFAULT_PLAYER_NAMES[0], names[1].trim() || DEFAULT_PLAYER_NAMES[1]];
    const next = createGame(undefined, cleaned);
    setMatch({ game: next, record: createMatch(next) }); setNames(cleaned); clearSelection(); setHandoff(true); setReplayOpen(false);
    setReserveOpen(false); setCollection(null); setNewGameOpen(false); setMenuOpen(false); setLogOpen(false);
  }

  function downloadSave() {
    const blob = new Blob([serializeMatch(record)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'splendor-duel-save.json'; anchor.click();
    URL.revokeObjectURL(url); setMenuOpen(false);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { setError('无法切换全屏，请使用浏览器的全屏功能'); }
  }

  async function importSave(file: File | undefined) {
    if (!file) return;
    const requestId = ++importRequestId.current;
    const startingTransition = transitionId.current;
    if (file.size > MAX_MATCH_BYTES) { setError('存档文件过大'); return; }
    try {
      const text = await file.text();
      if (requestId !== importRequestId.current || startingTransition !== transitionId.current) return;
      const restored = parseMatch(text);
      if (!restored) { setError('存档无效，当前对局未更改'); return; }
      transitionId.current++; motion.cancel(); playLock.current = false; setVisualPlayer(null);
      const renamed = renameMatch(restored);
      setMatch(renamed); setNames([renamed.game.players[0].name, renamed.game.players[1].name]); setReplayOpen(false);
      clearSelection(); setHandoff(true); setReserveOpen(false);
      setCollection(null); setMenuOpen(false); setLogOpen(false);
    } catch {
      if (requestId === importRequestId.current && startingTransition === transitionId.current) setError('读取存档失败');
    }
  }

  function renderPlayer(id: PlayerId) {
    const player = game.players[id]; const score = stats[id]; const active = displayTurn === id;
    return <section className={`player-seat${active ? ' is-active' : ''}`} data-motion-player={id} aria-label={`${player.name}状态`}>
      <button type="button" className="seat-portrait" data-motion-collection={id} onClick={() => setCollection(id)} aria-label={`查看${player.name}的已购卡牌`}><Portrait index={id + 4} /></button>
      <div className="seat-info"><h2 className="seat-name">{player.name}</h2>
        <div className="seat-score"><span title="声望"><strong>{score.points}</strong><small>/20</small></span><span title="王冠"><Crown /><strong>{score.crowns}</strong><small>/10</small></span></div>
      </div>
      <div className="seat-tokens">{TOKEN_COLORS.map(color => <span className="mini-token" key={color} data-motion-token={color} title={`${COLOR_NAMES[color]} ${player.tokens[color]}枚`}><Gem color={color} small /><b>{player.tokens[color]}</b></span>)}<span className="mini-token mini-scroll" title={`特权 ${player.privileges}`}><Scroll /><b>{player.privileges}</b></span></div>
      <div className="seat-bonuses">{GEM_COLORS.map(color => <span className="seat-bonus" key={color} title={`${COLOR_NAMES[color]}加成 ${score.bonuses[color]}，同色声望 ${score.colorPoints[color]}`}><Gem color={color} small /><b>+{score.bonuses[color]}</b></span>)}</div>
      <div className="seat-links"><button type="button" onClick={() => setCollection(id)}>卡牌 {player.cards.length}</button><button type="button" data-motion-reserve={id} disabled={!active || handoff || game.phase === 'gameOver'} onClick={() => setReserveOpen(true)}>预留 {player.reserved.length}/3</button></div>
    </section>;
  }

  function actionLabel() {
    if (game.phase === 'gameOver') return '对局结束';
    if (game.pending?.kind === 'chooseColor') return '选择颜色';
    if (game.pending?.kind === 'takeBonusToken') return `领取一枚${COLOR_NAMES[game.pending.color]}`;
    if (game.pending?.kind === 'stealToken') return '拿取对手一枚筹码';
    if (game.pending?.kind === 'chooseRoyal') return '选择一位王室';
    if (game.pending?.kind === 'discard') return `归还 ${game.pending.count} 枚筹码`;
    if (mode === 'privilege') return '选择一枚筹码';
    if (mode === 'reserve') return goldIndex === null ? '选择黄金' : target ? '预留这张牌' : '选择一张卡牌';
    if (mode === 'buy' && target) return affordable ? '购买这张牌' : '当前无法购买';
    if (indices.length) return validTake ? `拿取 ${indices.length} 枚${givesPrivilege ? ' · 对手 +1 特权' : ''}` : '请选择连续直线';
    return notice || '选择筹码或卡牌';
  }

  function renderActionControls() {
    const pending = game.pending;
    if (game.phase === 'gameOver') return <button type="button" className="primary-button" onClick={() => setReplayOpen(true)}>胜率回放</button>;
    if (pending?.kind === 'chooseColor') return <div className="choice-controls">{pending.colors.map(color => <button type="button" key={color} title={COLOR_NAMES[color]} onClick={() => play({ type: 'chooseColor', color })}><Gem color={color} /></button>)}</div>;
    if (pending?.kind === 'stealToken') return <div className="choice-controls">{pending.colors.map(color => <button type="button" key={color} title={`拿取${COLOR_NAMES[color]}`} onClick={() => play({ type: 'stealToken', color })}><Gem color={color} /></button>)}</div>;
    if (pending?.kind === 'discard') return <>
      <div className="choice-controls discard-controls">{TOKEN_COLORS.filter(color => current.tokens[color] > 0).map(color => <div key={color} className="discard-item"><Gem color={color} small /><button type="button" aria-label={`少弃一枚${COLOR_NAMES[color]}`} disabled={!discard[color]} onClick={() => adjustDiscard(color, -1)}>−</button><b>{discard[color]}</b><button type="button" aria-label={`多弃一枚${COLOR_NAMES[color]}`} disabled={discard[color] >= current.tokens[color] || totalDiscard >= pending.count} onClick={() => adjustDiscard(color, 1)}>+</button></div>)}</div>
      <button type="button" className="primary-button" disabled={totalDiscard !== pending.count || handoff} onClick={() => play({ type: 'discard', tokens: discard })}>确认 {totalDiscard}/{pending.count}</button>
    </>;
    if (pending) return null;
    if (mode === 'privilege') return <button type="button" className="secondary-button" onClick={() => clearSelection()}>取消</button>;
    if (target) return <>
      {target.source.kind === 'market' && <button type="button" className="secondary-button" disabled={mode === 'buy' && !canReserve} onClick={() => changeCardAction(mode === 'buy' ? 'reserve' : 'buy')}>{mode === 'buy' ? '改为预留' : '改为购买'}</button>}
      {mode === 'buy' && affordable && <div className="payment-summary">{TOKEN_COLORS.filter(color => payment[color] > 0).map(color => <span key={color}><Gem color={color} small /><b>{payment[color]}</b></span>)}{countTokens(payment) === 0 && <span>免费</span>}{current.tokens.gold > 0 && cost && COST_COLORS.some(color => cost[color] > 0) && <button type="button" onClick={() => setPaymentOpen(!paymentOpen)} aria-expanded={paymentOpen}>调整付款</button>}</div>}
      <button type="button" className="secondary-button" onClick={() => clearSelection()}>取消</button>
      <button type="button" className="primary-button" disabled={handoff || (mode === 'buy' ? !affordable : goldIndex === null)} onClick={() => mode === 'buy'
        ? play({ type: 'buy', source: target.source, payment })
        : goldIndex !== null && play({ type: 'reserve', goldIndex, source: target.source })}>{mode === 'buy' ? '购买此牌' : '预留此牌'}</button>
    </>;
    if (mode === 'reserve') return <button type="button" className="secondary-button" onClick={() => clearSelection()}>取消</button>;
    return <><div className="selected-tokens">{indices.map(index => <Gem key={index} color={game.board[index]!} small />)}</div>{indices.length > 0 && <button type="button" className="secondary-button" onClick={() => clearSelection()}>取消</button>}<button type="button" className="primary-button" disabled={!validTake || handoff} onClick={() => play({ type: 'takeTokens', indices })}>确认拿取{indices.length ? ` ${indices.length}` : ''}</button></>;
  }

  return <div className="table-viewport"><div className={`game-table${handoff && game.phase !== 'gameOver' ? ' is-handoff' : ''}${inputLocked ? ' is-animating' : ''}`} inert={inputLocked || replayOpen} aria-hidden={replayOpen || undefined} aria-busy={inputLocked} style={{ transform: `translate(-50%, -50%) scale(${tableScale})` }}>
    <div className="table-menu"><span className="table-turn">{game.turnNumber}</span><button type="button" className="menu-toggle fullscreen-toggle" aria-label="全屏" aria-pressed={fullscreen} title={fullscreen ? '退出全屏' : '进入全屏'} onClick={() => { void toggleFullscreen(); }}>⛶</button><button type="button" className="menu-toggle" aria-label="对局菜单" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>☰</button>
      {menuOpen && <div className="menu-popover"><button type="button" onClick={() => { setNewGameOpen(true); setMenuOpen(false); }}>新对局</button><button type="button" onClick={() => { setLogOpen(true); setMenuOpen(false); }}>行动记录</button><button type="button" onClick={downloadSave}>导出存档</button><label className="import-button">导入存档<input type="file" accept=".json,application/json" onChange={event => { void importSave(event.target.files?.[0]); event.target.value = ''; }} /></label><small className={saveFailed ? 'save-warning' : 'save-status'}>{saveFailed ? '请导出保存' : '已保存'}</small></div>}
    </div>

    <aside className="player-rail">{renderPlayer(0)}{renderPlayer(1)}</aside>

    <main className="market" aria-label="公共卡牌市场">{([3, 2, 1] as Level[]).map(level => <div className="market-row" key={level}>
      <button type="button" data-motion-deck={level} style={{ backgroundImage: `url("${DECKS[level].image}")` }} className={`deck deck-${level}${target?.source.kind === 'deck' && target.source.level === level ? ' selected' : ''}`} disabled={!isMain || handoff || !canReserve || !game.decks[level].length}
        aria-label={`盲预留${level}级牌库，${DECKS[level].name}，剩余${game.decks[level].length}张`} onClick={() => selectDeck(level)}><span className="deck-level">{['I', 'II', 'III'][level - 1]}</span><span className="deck-mark">{DECKS[level].unit}</span><strong className="deck-count">{game.decks[level].length}</strong></button>
      <div className="card-row">{game.market[level].map((id, index) => id ? <Card key={`${level}-${index}`} card={getJewel(id)} disabled={!isMain || handoff}
        selected={target?.source.kind === 'market' && target.source.level === level && target.source.index === index}
        affordable={isMain && canBuy(game, game.turn, id)} onClick={() => selectCard(id, { kind: 'market', level, index })} /> : <div className="empty-card" key={`${level}-${index}`} />)}</div>
    </div>)}</main>

    <section className="board-zone" aria-label="筹码棋盘"><div className="board-topline"><span className="bag-count" data-motion-bag title="袋中筹码">◈ {game.bag.length}</span><span className="privilege-pool" title={`公共特权 ${game.privilegeSupply}`}><Scroll count={game.privilegeSupply} /></span></div>
      <div className="token-board" aria-label="5乘5筹码棋盘">{game.board.map((color, index) => {
        const selected = indices.includes(index) || goldIndex === index;
        return <button type="button" key={index} className={`board-cell${color ? ` cell-${color}` : ' empty'}${selected ? ' selected' : ''}${boardAllowed(index) ? ' available' : ''}`}
          disabled={!color || !boardAllowed(index)} onClick={() => boardClick(index)} aria-pressed={selected}
          aria-label={`第${Math.floor(index / 5) + 1}行第${index % 5 + 1}列，${color ? COLOR_NAMES[color] : '空位'}`} data-board-index={index}>
          {color ? <Token color={color} selected={selected} /> : <span className="empty-dot" />}
        </button>;
      })}</div>
      <div className="board-tools"><button type="button" disabled={!canPrivilege || handoff} className={mode === 'privilege' ? 'is-active' : ''} onClick={() => clearSelection(mode === 'privilege' ? 'take' : 'privilege')}>使用特权</button><button type="button" disabled={!canRefill || handoff} onClick={() => play({ type: 'refill' })}>↻ 补盘</button></div>
    </section>

    <aside className="royal-rail" aria-label="王室卡牌">{game.royals.map(id => {
      const available = game.pending?.kind === 'chooseRoyal' && game.pending.cardIds.includes(id);
      return <Royal key={id} card={getRoyal(id)} selected={available} disabled={!available || handoff} onClick={() => play({ type: 'chooseRoyal', cardId: id })} />;
    })}</aside>

    <footer className="player-tray" data-motion-tray={displayTurn} aria-label={`${current.name}的资源`}>
      <div className="tray-owner"><Portrait index={displayTurn + 4} /><span>{current.name}</span><small>{stats[displayTurn].tokenCount}/10</small></div>
      <div className="gem-resources">{GEM_COLORS.map(color => <div className="tray-resource" key={color} data-motion-token={color} title={`${COLOR_NAMES[color]}：筹码 ${current.tokens[color]}，加成 ${stats[displayTurn].bonuses[color]}，声望 ${stats[displayTurn].colorPoints[color]}`}><Token color={color} count={current.tokens[color]} /><span className="bonus-badge">+{stats[displayTurn].bonuses[color]}</span><span className="color-score">{stats[displayTurn].colorPoints[color]}<small>/10</small></span></div>)}</div>
      <div className="special-resources"><div className="tray-special" data-motion-token="gold" title={`黄金 ${current.tokens.gold}`}><Token color="gold" count={current.tokens.gold} /></div><div className="tray-special" data-motion-token="pearl" title={`珍珠 ${current.tokens.pearl}`}><Token color="pearl" count={current.tokens.pearl} /></div><button type="button" className={`tray-special scroll-resource${mode === 'privilege' ? ' is-active' : ''}`} disabled={!canPrivilege || handoff} title="使用特权" onClick={() => clearSelection(mode === 'privilege' ? 'take' : 'privilege')}><Scroll count={current.privileges} /></button></div>
      <button type="button" className="tray-reserve" disabled={handoff || game.phase === 'gameOver'} onClick={() => setReserveOpen(true)} aria-label={`查看预留牌，${current.reserved.length}张`}><span className="reserve-fan"><i /><i /><i /></span><span>预留 {current.reserved.length}/3</span></button>
    </footer>

    <section className="action-dock" aria-label="当前操作"><div className="action-status" role="status"><span className="acting-player">{current.name}</span><strong>{actionLabel()}</strong></div><div className="action-controls">{renderActionControls()}</div>
      {paymentOpen && mode === 'buy' && target && cost && <div className="payment-popover"><button type="button" className="popover-close" aria-label="关闭付款调整" onClick={() => setPaymentOpen(false)}>×</button><h3>付款</h3><div className="payment-controls">{COST_COLORS.filter(color => cost[color] > 0).map(color => <div key={color}><Gem color={color} small /><span>{COLOR_NAMES[color]}</span><button type="button" aria-label={`用黄金替代一枚${COLOR_NAMES[color]}`} disabled={payment[color] <= 0 || payment.gold >= current.tokens.gold} onClick={() => adjustPayment(color, -1)}>−</button><b>{payment[color]}</b><button type="button" aria-label={`多支付一枚${COLOR_NAMES[color]}`} disabled={payment.gold === 0 || payment[color] >= Math.min(cost[color], current.tokens[color])} onClick={() => adjustPayment(color, 1)}>+</button></div>)}</div><div className="payment-total"><Gem color="gold" small /><b>{payment.gold}</b></div></div>}
    </section>

    {error && <div className="table-toast" role="alert">{error}<button type="button" aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}

    {handoff && game.phase !== 'gameOver' && <div className="modal-backdrop handoff-backdrop"><section className="modal handoff-modal" role="dialog" aria-modal="true" aria-label="交接回合"><Portrait index={game.turn + 4} /><h2>{current.name}</h2><button type="button" className="primary-button" onClick={() => setHandoff(false)}>开始回合</button></section></div>}

    {reserveOpen && !handoff && <Modal title="预留牌" className="reserve-modal" onClose={() => setReserveOpen(false)}><div className="private-cards">{current.reserved.length ? current.reserved.map((id, index) => <Card key={`${id}-${index}`} card={getJewel(id)} disabled={!isMain} affordable={canBuy(game, game.turn, id)} onClick={() => selectCard(id, { kind: 'reserve', index })} />) : <p className="empty-message">暂无预留牌</p>}</div><button type="button" className="secondary-button" onClick={() => setReserveOpen(false)}>收起</button></Modal>}

    {collection !== null && <Modal title={game.players[collection].name} className="collection-modal" onClose={() => setCollection(null)}><div className="collection-cards">{game.players[collection].cards.map(owned => <div className="owned-card" key={owned.cardId}><Card card={getJewel(owned.cardId)} disabled />{getJewel(owned.cardId).bonus?.color === 'choice' && owned.color && <span className="owned-color"><Gem color={owned.color} small /></span>}</div>)}</div>{!game.players[collection].cards.length && <p className="empty-message">暂无已购卡牌</p>}<div className="owned-royals">{game.players[collection].royals.map(id => <Royal key={id} card={getRoyal(id)} disabled />)}</div></Modal>}

    {logOpen && <Modal title="行动记录" className="log-modal" onClose={() => setLogOpen(false)}><ol className="game-log">{game.log.map((entry, index) => <li key={index}>{themedLog(entry, game.players.map(player => player.name))}</li>)}</ol></Modal>}

    {newGameOpen && <Modal title="新对局" className="new-game-modal" onClose={() => setNewGameOpen(false)}><label>{DEFAULT_PLAYER_NAMES[0]}<input maxLength={20} value={names[0]} onChange={event => setNames([event.target.value, names[1]])} /></label><label>{DEFAULT_PLAYER_NAMES[1]}<input maxLength={20} value={names[1]} onChange={event => setNames([names[0], event.target.value])} /></label><p>将替换当前对局。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setNewGameOpen(false)}>取消</button><button type="button" className="primary-button" onClick={startNewGame}>开始</button></div></Modal>}

    {!inputLocked && game.phase === 'gameOver' && game.winner !== null && <div className="victory-banner" role="status"><Crown /><strong>{game.players[game.winner].name} 获胜</strong><span>{game.victoryReasons.map(reason => ({ prestige: '20 声望', crowns: '10 王冠', color: '10 同色声望' })[reason]).join(' · ')}</span><button type="button" onClick={() => setNewGameOpen(true)}>再来一局</button></div>}
  </div>{replayOpen && game.phase === 'gameOver' && <ReplayPanel record={record} onClose={() => setReplayOpen(false)} />}</div>;
}
