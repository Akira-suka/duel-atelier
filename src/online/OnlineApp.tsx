import { useEffect, useRef, useState } from 'react';
import { getJewel, getRoyal } from '../game/catalog';
import { emptyWallet } from '../game/engine';
import { parseMatch } from '../game/match';
import type { ArchivedMatch } from '../game/archive';
import { COST_COLORS, GEM_COLORS, TOKEN_COLORS, type Action, type CardSource, type PlayerId, type Wallet } from '../game/types';
import { Card, Crown, Gem, Portrait, Royal, Scroll, Token } from '../ui/TablePieces';
import { ResourceCount } from '../ui/ResourceCount';
import { ArchivedReplay } from '../ui/ArchivedReplay';
import { DECKS, RESOURCE_NAMES, themedLog } from '../theme';
import { OnlineClient, type OnlineState } from './client';
import type { RoomSnapshot } from './protocol';
import './online.css';

const sameSource = (a: CardSource, b: CardSource) => a.kind === b.kind && ('level' in a ? a.level : 0) === ('level' in b ? b.level : 0) && ('index' in a ? a.index : 0) === ('index' in b ? b.index : 0);
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function OnlineApp({ onLocal }: { onLocal: () => void }) {
  const client = useRef<OnlineClient | null>(null);
  const [state, setState] = useState<OnlineState>({ snapshot: null, connected: false, busy: false, error: '', saved: false });
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [replay, setReplay] = useState<ArchivedMatch | null>(null);
  useEffect(() => { const owner = new OnlineClient(setState); client.current = owner; return () => { owner.close(); client.current = null; }; }, []);
  const openReplay = async () => {
    try {
      const loaded = parseMatch(await client.current!.replay());
      if (!loaded || loaded.game.winner === null) throw Error('回放数据无效');
      setReplay({ ...loaded, id: `online-${state.snapshot!.code}`, savedAt: Date.now() });
    } catch (error) { setError(error instanceof Error ? error.message : '回放下载失败'); }
  };
  const restore = async (file?: File) => {
    if (!file) return;
    try { if (file.size > 4096) throw Error('凭证文件过大'); client.current!.restore(await file.text()); setError(''); }
    catch (error) { setError(error instanceof Error ? error.message : '恢复失败'); }
  };
  return <>
    {state.snapshot ? <OnlineTable key={state.snapshot.code} room={state.snapshot} connected={state.connected} busy={state.busy}
      send={action => client.current!.move(action)} onReplay={() => void openReplay()} />
      : <main className="online-lobby"><h1>双人联机</h1><p>创建房间，将邀请码发给另一位玩家。</p>
        <button disabled={!state.connected || state.busy || state.saved} onClick={() => client.current!.start()}>创建房间 · Asuka</button>
        <form onSubmit={event => { event.preventDefault(); client.current!.start(code); }}><label>邀请码<input value={code} maxLength={8} onChange={event => setCode(event.target.value.toUpperCase())} autoComplete="off" /></label><button disabled={!state.connected || state.busy || state.saved || !/^[A-HJ-NP-Z2-9]{8}$/.test(code)}>加入房间 · Sinji</button></form>
        <label className="online-file">恢复重连凭证<input type="file" accept=".json" onChange={event => void restore(event.target.files?.[0])} /></label>
        <p>{state.busy ? '正在恢复房间…' : state.connected ? '服务器已连接' : '正在连接服务器…'}</p>
      </main>}
    <nav className="online-toolbar" aria-label="联机菜单">
      {state.snapshot && <span>房间 <b>{state.snapshot.code}</b> · {state.snapshot.view.players[state.snapshot.seat].name} · {state.connected ? '已连接' : '重连中'}</span>}
      <button onClick={onLocal}>同机对战</button>
      {state.saved && <><button onClick={() => download(client.current!.credentialFile(), 'duel-reconnect-private.json')}>保存重连凭证</button><button onClick={() => client.current!.reconnect()}>重新连接</button><button onClick={() => { if (window.confirm('离开后可用已下载的重连凭证找回座位；请先保存凭证。确定清除本站的座位记录？')) client.current!.forget(); }}>离开房间</button></>}
      {state.snapshot?.view.winner !== null && state.snapshot?.view.winner !== undefined && <button onClick={() => void client.current!.replay().then(text => download(text, `duel-${state.snapshot!.code}.json`)).catch(() => setError('导出失败，请重试'))}>导出对局</button>}
    </nav>
    {(state.error || error) && <div className="online-error" role="alert">{error || state.error}<button onClick={() => { setError(''); void client.current!.sync(); }}>同步</button></div>}
    {replay && <ArchivedReplay item={replay} onClose={() => setReplay(null)} />}
  </>;
}

function OnlineTable({ room, connected, busy, send, onReplay }: { room: RoomSnapshot; connected: boolean; busy: boolean; send: (action: Action) => void; onReplay: () => void }) {
  const game = room.view, me = game.players[room.seat];
  const canAct = connected && !busy && room.ready && game.turn === room.seat && game.winner === null;
  const legal = room.legal;
  const [scale, setScale] = useState(1);
  const [indices, setIndices] = useState<number[]>([]);
  const [gold, setGold] = useState<number | null>(null);
  const [target, setTarget] = useState<CardSource | null>(null);
  const [reserve, setReserve] = useState(false);
  const [privilege, setPrivilege] = useState(false);
  const [payment, setPayment] = useState<Wallet>(emptyWallet);
  const [discard, setDiscard] = useState<Wallet>(emptyWallet);
  const [drawer, setDrawer] = useState<'reserve' | 'log' | PlayerId | null>(null);
  const clear = () => { setIndices([]); setGold(null); setTarget(null); setReserve(false); setPrivilege(false); setPayment(emptyWallet()); setDiscard(emptyWallet()); };
  useEffect(() => { clear(); setDrawer(null); }, [game.revision]);
  useEffect(() => {
    const resize = () => setScale(Math.min(window.innerWidth / 1600, (window.innerHeight - 44) / 900));
    resize(); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  const buyFor = (source: CardSource) => legal.find((action): action is Extract<Action, { type: 'buy' }> => action.type === 'buy' && sameSource(action.source, source));
  const reserveFor = (source: CardSource, index = gold) => legal.some(action => action.type === 'reserve' && sameSource(action.source, source) && (index === null || action.goldIndex === index));
  const chooseCard = (source: CardSource) => {
    if (!canAct || game.pending) return;
    const buy = buyFor(source); setTarget(source); setIndices([]); setPrivilege(false); setDrawer(null);
    setReserve(source.kind === 'deck' || (source.kind !== 'reserve' && (reserve || gold !== null || !buy)));
    setPayment(buy?.payment ?? emptyWallet());
  };
  const targetId = target?.kind === 'market' ? game.market[target.level][target.index] : target?.kind === 'reserve' ? me.reserved[target.index] : null;
  const cost = targetId ? getJewel(targetId).cost : null;
  const isTake = legal.some(action => action.type === 'takeTokens' && action.indices.length === indices.length && action.indices.every(index => indices.includes(index)));
  const boardAllowed = (index: number) => canAct && legal.some(action => (action.type === 'takeTokens' && !privilege && action.indices.includes(index))
    || (action.type === 'reserve' && !privilege && action.goldIndex === index)
    || (action.type === 'usePrivilege' && privilege && action.index === index) || (action.type === 'takeBonusToken' && action.index === index));
  const boardClick = (index: number) => {
    if (game.pending?.kind === 'takeBonusToken') { send({ type: 'takeBonusToken', index }); return; }
    if (privilege) { send({ type: 'usePrivilege', index }); return; }
    if (game.board[index] === 'gold') { setGold(index); setReserve(true); setIndices([]); return; }
    setTarget(null); setReserve(false); setGold(null);
    setIndices(indices.includes(index) ? indices.filter(value => value !== index) : indices.length < 3 ? [...indices, index] : [index]);
  };
  const status = !connected ? '连接中，行动已暂停' : busy ? '等待服务器确认' : !room.ready ? '等待另一位玩家加入'
    : game.winner !== null ? `${game.players[game.winner].name} 获胜` : !canAct ? `等待 ${game.players[game.turn].name}`
    : game.pending ? ({ chooseColor: '选择加成颜色', takeBonusToken: '领取同色筹码', stealToken: '拿取对手筹码', chooseRoyal: '选择王室牌', discard: '归还超额筹码' }[game.pending.kind])
    : target ? reserve ? '选择黄金并确认预留' : '确认付款' : privilege ? '选择一枚筹码使用特权' : '选择筹码或卡牌';
  return <div className="table-viewport online-viewport"><div className="game-table" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
    <div className="table-menu"><span>第 {game.turnNumber} 回合 · {room.connected[room.seat === 0 ? 1 : 0] ? '对手在线' : '对手离线，可等待重连'}</span><button className="menu-toggle" onClick={() => setDrawer('log')}>记录</button></div>
    <aside className="player-rail">{([0, 1] as const).map(id => { const player = game.players[id]; return <section key={id} className={`player-seat${game.turn === id ? ' is-active' : ''}`}>
      <button className="seat-portrait" onClick={() => setDrawer(id)} aria-label={`查看${player.name}已购卡牌`}><Portrait index={id + 4} /></button><h2 className="seat-name">{player.name}{id === room.seat ? ' · 你' : ''}</h2>
      <div className="seat-score"><span>{player.stats.points}<small>/20</small></span><span><Crown />{player.stats.crowns}<small>/10</small></span></div>
      <div className="seat-resource-grid">{GEM_COLORS.map(color => <ResourceCount key={color} color={color} tokens={player.tokens[color]} assets={player.stats.bonuses[color]} />)}</div>
      <div className="seat-special">{(['gold','pearl'] as const).map(color => <ResourceCount key={color} color={color} tokens={player.tokens[color]} />)}<span className="seat-privilege"><Scroll /><b>{player.privileges}</b></span></div>
      <div className="seat-links"><button onClick={() => setDrawer(id)}>已购 {player.cards.length}</button><span>预留 {player.reserved.length}/3</span></div>
    </section>; })}</aside>
    <main className="market" aria-label="公共卡牌市场">{([3,2,1] as const).map(level => <div className="market-row" key={level}>
      <button className={`deck deck-${level}`} style={{ backgroundImage: `url("${DECKS[level].image}")` }} disabled={!canAct || !reserveFor({ kind: 'deck', level })} onClick={() => chooseCard({ kind: 'deck', level })} aria-label={`盲预留 ${level} 级牌库`}><span className="deck-level">{level}</span><strong className="deck-count">{game.deckCounts[level]}</strong></button>
      <div className="card-row">{game.market[level].map((id, index) => { const source: CardSource = { kind: 'market', level, index }; return id ? <Card key={index} card={getJewel(id)} affordable={canAct && !!buyFor(source)} selected={!!target && sameSource(target, source)} disabled={!canAct || !!game.pending} onClick={() => chooseCard(source)} /> : <div className="empty-card" key={index} />; })}</div>
    </div>)}</main>
    <section className="board-zone"><div className="board-topline"><span>◈ {game.bagCount}</span><Scroll count={game.privilegeSupply} /></div><div className="token-board">{game.board.map((color, index) => <button key={index} className={`board-cell${color ? '' : ' empty'}${indices.includes(index) || gold === index ? ' selected' : ''}`} disabled={!boardAllowed(index)} aria-label={`筹码 ${index + 1} ${color ? RESOURCE_NAMES[color] : '空'}`} onClick={() => boardClick(index)}>{color && <Token color={color} selected={indices.includes(index) || gold === index} />}</button>)}</div>
      <div className="board-tools"><button disabled={!canAct || !legal.some(action => action.type === 'usePrivilege')} onClick={() => { clear(); setPrivilege(!privilege); }}>使用特权</button><button disabled={!canAct || !legal.some(action => action.type === 'refill')} onClick={() => send({ type: 'refill' })}>补盘</button></div>
    </section>
    <aside className="royal-rail">{game.royals.map(id => <Royal key={id} card={getRoyal(id)} disabled={!canAct || !legal.some(action => action.type === 'chooseRoyal' && action.cardId === id)} onClick={() => send({ type: 'chooseRoyal', cardId: id })} />)}</aside>
    <footer className="player-tray"><div className="tray-owner"><span>{me.name}</span><small>{me.stats.tokenCount}/10</small></div><div className="gem-resources">{GEM_COLORS.map(color => <div className="tray-resource" key={color}><Token color={color} count={me.tokens[color]} /><span className="bonus-badge">+{me.stats.bonuses[color]}</span><span className="color-score">{me.stats.colorPoints[color]}/10</span></div>)}</div><div className="special-resources"><div className="tray-special"><Token color="gold" count={me.tokens.gold} /></div><div className="tray-special"><Token color="pearl" count={me.tokens.pearl} /></div><div className="tray-special"><Scroll count={me.privileges} /></div></div><button className="tray-reserve" onClick={() => setDrawer('reserve')}><span className="reserve-fan" />预留 {me.reserved.length}/3</button></footer>
    <section className="action-dock"><span className="action-status" role="status">{status}</span><div className="action-controls">
      {game.winner !== null && <button onClick={onReplay}>胜率回放</button>}
      {canAct && <>
        {(game.pending?.kind === 'chooseColor' || game.pending?.kind === 'stealToken') && game.pending.colors.map(color => <button key={color} onClick={() => send(game.pending!.kind === 'chooseColor' ? { type: 'chooseColor', color: color as typeof GEM_COLORS[number] } : { type: 'stealToken', color })}><Gem color={color} small /></button>)}
        {game.pending?.kind === 'discard' && <><div className="choice-controls">{TOKEN_COLORS.filter(color => me.tokens[color]).map(color => <label className="online-wallet" key={color}><Gem color={color} small /><input aria-label={`归还${RESOURCE_NAMES[color]}`} type="number" min={0} max={me.tokens[color]} value={discard[color]} onChange={event => setDiscard({ ...discard, [color]: Math.max(0, Math.min(me.tokens[color], Number(event.target.value))) })} /></label>)}</div><button disabled={Object.values(discard).reduce((a,b) => a+b, 0) !== game.pending.count} onClick={() => send({ type: 'discard', tokens: discard })}>确认归还 {game.pending.count}</button></>}
        {!game.pending && <>{target ? <>
          {target.kind === 'market' && <button onClick={() => { setReserve(!reserve); setPayment(buyFor(target)?.payment ?? emptyWallet()); }}>{reserve ? '改为购买' : '改为预留'}</button>}
          {!reserve && buyFor(target) && <details className="online-payment"><summary>付款 {Object.values(payment).reduce((a,b) => a+b, 0)} 枚 · 调整</summary><div>{COST_COLORS.filter(color => cost && cost[color] > 0).map(color => { const needed = Math.max(0, (cost?.[color] ?? 0) - (color === 'pearl' ? 0 : me.stats.bonuses[color])); return <label className="online-wallet" key={color}><Gem color={color} small /><input aria-label={`支付${RESOURCE_NAMES[color]}`} type="number" min={0} max={Math.min(needed, me.tokens[color])} value={payment[color]} onChange={event => { const n = Math.max(0, Math.min(needed, me.tokens[color], Number(event.target.value))); const delta = payment[color] - n; if (payment.gold + delta >= 0 && payment.gold + delta <= me.tokens.gold) setPayment({ ...payment, [color]: n, gold: payment.gold + delta }); }} /></label>; })}<span>黄金 {payment.gold}</span></div></details>}
          <button disabled={reserve ? gold === null || !reserveFor(target, gold) : !buyFor(target)} onClick={() => reserve && gold !== null ? send({ type: 'reserve', source: target, goldIndex: gold }) : send({ type: 'buy', source: target, payment })}>{reserve ? '确认预留' : '确认购买'}</button>
        </> : !privilege && <button disabled={!isTake} onClick={() => send({ type: 'takeTokens', indices })}>确认拿取 {indices.length || ''}</button>}<button onClick={clear}>取消选择</button></>}
      </>}
    </div></section>
    {drawer !== null && <section className="online-drawer" aria-label="牌桌详情"><button className="secondary-button" onClick={() => setDrawer(null)}>关闭</button>{drawer === 'log' ? <ol>{game.log.map((line, index) => <li key={index}>{themedLog(line, game.players.map(player => player.name))}</li>)}</ol> : <div className="collection-cards">{drawer === 'reserve' ? me.reserved.map((id, index) => id && <Card key={index} card={getJewel(id)} disabled={!canAct || !!game.pending} affordable={canAct && !!buyFor({ kind: 'reserve', index })} onClick={() => chooseCard({ kind: 'reserve', index })} />) : game.players[drawer].cards.map(card => <Card key={card.cardId} card={getJewel(card.cardId)} disabled />)}</div>}</section>}
  </div></div>;
}
