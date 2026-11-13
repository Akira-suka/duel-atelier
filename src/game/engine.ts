import { getJewel, getRoyal, JEWEL_CARDS, ROYAL_CARDS } from './catalog';
import {
  COLOR_NAMES, COST_COLORS, GEM_COLORS, LEVELS, TOKEN_COLORS,
  type Action, type ActionResult, type CardSource, type Cost, type GameState,
  type GemColor, type Level, type PlayerId, type PlayerState, type PlayerStats,
  type TokenColor, type Wallet,
} from './types';

// The board's printed spiral, from its centre. Existing tokens never move on refill.
export const SPIRAL = [12, 17, 16, 11, 6, 7, 8, 13, 18, 23, 22, 21, 20, 15, 10, 5, 0, 1, 2, 3, 4, 9, 14, 19, 24];
const INITIAL_TOKENS: Wallet = { white: 4, blue: 4, green: 4, red: 4, black: 4, pearl: 2, gold: 3 };
const MARKET_SIZE: Record<Level, number> = { 1: 5, 2: 4, 3: 3 };

class RuleError extends Error {}
function requireRule(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RuleError(message);
}

export function emptyWallet(): Wallet {
  return { white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0 };
}

export function countTokens(tokens: Wallet): number {
  return TOKEN_COLORS.reduce((total, color) => total + tokens[color], 0);
}

function emptyGems(): Record<GemColor, number> {
  return { white: 0, blue: 0, green: 0, red: 0, black: 0 };
}

function seedNumber(seed: string): number {
  let n = 2166136261;
  for (const c of seed) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return (n >>> 0) || 1;
}

function random(state: GameState): number {
  let n = state.rng;
  n ^= n << 13;
  n ^= n >>> 17;
  n ^= n << 5;
  state.rng = n >>> 0;
  return state.rng / 4294967296;
}

function shuffle<T>(state: GameState, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random(state) * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function newPlayer(name: string): PlayerState {
  return { name: name.trim().slice(0, 20) || '玩家', tokens: emptyWallet(), cards: [], reserved: [], royals: [], privileges: 0, royalClaims: [] };
}

function log(state: GameState, message: string): void {
  state.log.push(message);
  if (state.log.length > 120) state.log.shift();
}

export function createGame(seed = String(Date.now()), names: [string, string] = ['玩家一', '玩家二']): GameState {
  const state: GameState = {
    version: 1, seed: String(seed), rng: seedNumber(String(seed)), revision: 0,
    turn: 0, turnNumber: 1, phase: 'start', players: [newPlayer(names[0]), newPlayer(names[1])],
    board: Array<TokenColor | null>(25).fill(null), bag: [],
    decks: { 1: [], 2: [], 3: [] }, market: { 1: [], 2: [], 3: [] },
    royals: ROYAL_CARDS.map(card => card.id), privilegeSupply: 2, extraTurns: 0,
    effects: [], pending: null, winner: null, victoryReasons: [], log: [],
  };
  for (const level of LEVELS) {
    state.decks[level] = shuffle(state, JEWEL_CARDS.filter(card => card.level === level).map(card => card.id));
    state.market[level] = Array.from({ length: MARKET_SIZE[level] }, () => state.decks[level].pop()!);
  }
  for (const color of TOKEN_COLORS) {
    for (let i = 0; i < INITIAL_TOKENS[color]; i++) state.bag.push(color);
  }
  refillBoard(state);
  state.turn = random(state) < 0.5 ? 0 : 1;
  state.players[other(state.turn)].privileges = 1;
  log(state, `${state.players[state.turn].name}先手，${state.players[other(state.turn)].name}获得 1 个特权。`);
  return state;
}

function other(player: PlayerId): PlayerId { return player === 0 ? 1 : 0; }

export function getStats(state: GameState, playerId: PlayerId): PlayerStats {
  const player = state.players[playerId];
  const stats: PlayerStats = { points: 0, crowns: 0, bonuses: emptyGems(), colorPoints: emptyGems(), tokenCount: countTokens(player.tokens) };
  for (const owned of player.cards) {
    const card = getJewel(owned.cardId);
    stats.points += card.points;
    stats.crowns += card.crowns;
    if (owned.color !== null) {
      stats.colorPoints[owned.color] += card.points;
      stats.bonuses[owned.color] += card.bonus?.amount ?? 0;
    }
  }
  for (const id of player.royals) stats.points += getRoyal(id).points;
  return stats;
}

export function getDiscountedCost(state: GameState, playerId: PlayerId, cardId: string): Cost {
  const card = getJewel(cardId);
  const { bonuses } = getStats(state, playerId);
  return {
    white: Math.max(0, card.cost.white - bonuses.white),
    blue: Math.max(0, card.cost.blue - bonuses.blue),
    green: Math.max(0, card.cost.green - bonuses.green),
    red: Math.max(0, card.cost.red - bonuses.red),
    black: Math.max(0, card.cost.black - bonuses.black),
    pearl: card.cost.pearl,
  };
}

export function getPayment(state: GameState, playerId: PlayerId, cardId: string): Wallet | null {
  const cost = getDiscountedCost(state, playerId, cardId);
  const wallet = state.players[playerId].tokens;
  const payment = emptyWallet();
  for (const color of COST_COLORS) {
    payment[color] = Math.min(cost[color], wallet[color]);
    payment.gold += cost[color] - payment[color];
  }
  return payment.gold <= wallet.gold ? payment : null;
}

export function canBuy(state: GameState, playerId: PlayerId, cardId: string): boolean {
  const card = getJewel(cardId);
  if (card.bonus?.color === 'choice' && !state.players[playerId].cards.some(owned => owned.color !== null && getJewel(owned.cardId).bonus !== null)) return false;
  return getPayment(state, playerId, cardId) !== null;
}

function isIndex(index: number): boolean { return Number.isInteger(index) && index >= 0 && index < 25; }

export function isValidTake(state: GameState, indices: number[]): boolean {
  if (indices.length < 1 || indices.length > 3 || new Set(indices).size !== indices.length) return false;
  if (indices.some(index => !isIndex(index) || state.board[index] === null || state.board[index] === 'gold')) return false;
  if (indices.length === 1) return true;
  const cells = [...indices].sort((a, b) => a - b);
  const dr = Math.floor(cells[1] / 5) - Math.floor(cells[0] / 5);
  const dc = cells[1] % 5 - cells[0] % 5;
  if (Math.abs(dr) > 1 || Math.abs(dc) > 1 || (!dr && !dc)) return false;
  for (let i = 1; i < cells.length; i++) {
    if (Math.floor(cells[i] / 5) - Math.floor(cells[i - 1] / 5) !== dr || cells[i] % 5 - cells[i - 1] % 5 !== dc) return false;
  }
  return true;
}

function refillBoard(state: GameState): void {
  shuffle(state, state.bag);
  for (const index of SPIRAL) {
    if (state.board[index] === null && state.bag.length) state.board[index] = state.bag.pop()!;
  }
}

function grantPrivilege(state: GameState, playerId: PlayerId): void {
  const player = state.players[playerId];
  if (state.privilegeSupply > 0) {
    state.privilegeSupply--;
    player.privileges++;
  } else if (state.players[other(playerId)].privileges > 0) {
    state.players[other(playerId)].privileges--;
    player.privileges++;
  } else {
    log(state, `${player.name}已持有全部特权。`);
    return;
  }
  log(state, `${player.name}获得 1 个特权。`);
}

function resolveSource(state: GameState, source: CardSource): string | null {
  if (source.kind === 'market') {
    if (!LEVELS.includes(source.level) || !Number.isInteger(source.index)) return null;
    return state.market[source.level][source.index] ?? null;
  }
  if (source.kind === 'reserve') return Number.isInteger(source.index) ? state.players[state.turn].reserved[source.index] ?? null : null;
  if (source.kind === 'deck' && LEVELS.includes(source.level)) return state.decks[source.level].at(-1) ?? null;
  return null;
}

function removeSource(state: GameState, source: CardSource): void {
  if (source.kind === 'market') state.market[source.level][source.index] = state.decks[source.level].pop() ?? null;
  else if (source.kind === 'reserve') state.players[state.turn].reserved.splice(source.index, 1);
  else state.decks[source.level].pop();
}

function purchasableSources(state: GameState): CardSource[] {
  const sources: CardSource[] = [];
  for (const level of LEVELS) {
    state.market[level].forEach((id, index) => {
      if (id !== null && canBuy(state, state.turn, id)) sources.push({ kind: 'market', level, index });
    });
  }
  state.players[state.turn].reserved.forEach((id, index) => {
    if (canBuy(state, state.turn, id)) sources.push({ kind: 'reserve', index });
  });
  return sources;
}

function reservableSources(state: GameState): CardSource[] {
  const sources: CardSource[] = [];
  for (const level of LEVELS) {
    if (state.decks[level].length) sources.push({ kind: 'deck', level });
    state.market[level].forEach((id, index) => { if (id !== null) sources.push({ kind: 'market', level, index }); });
  }
  return sources;
}

function hasMandatoryAction(state: GameState): boolean {
  if (state.board.some(token => token !== null && token !== 'gold')) return true;
  if (state.players[state.turn].reserved.length < 3 && state.board.includes('gold') && reservableSources(state).length) return true;
  return purchasableSources(state).length > 0;
}

function takeToken(state: GameState, index: number): TokenColor {
  const token = state.board[index]!;
  state.board[index] = null;
  state.players[state.turn].tokens[token]++;
  return token;
}

function privilegeCanCompleteTurn(state: GameState, index: number): boolean {
  if (state.bag.length || state.board.some((token, i) => i !== index && token !== null && token !== 'gold')) return true;
  const next = structuredClone(state);
  takeToken(next, index);
  return hasMandatoryAction(next);
}

function assertWallet(value: Wallet): void {
  requireRule(value !== null && typeof value === 'object' && TOKEN_COLORS.every(color => Number.isSafeInteger(value[color]) && value[color] >= 0), '筹码数量必须是非负整数。');
}

function pay(state: GameState, id: string, payment: Wallet): void {
  assertWallet(payment);
  const wallet = state.players[state.turn].tokens;
  const cost = getDiscountedCost(state, state.turn, id);
  let requiredGold = 0;
  for (const color of COST_COLORS) {
    requireRule(payment[color] <= cost[color] && payment[color] <= wallet[color], '支付筹码超过费用或持有数量。');
    requiredGold += cost[color] - payment[color];
  }
  requireRule(payment.gold === requiredGold && payment.gold <= wallet.gold, '黄金数量不足或付款金额不正确。');
  for (const color of TOKEN_COLORS) {
    wallet[color] -= payment[color];
    for (let i = 0; i < payment[color]; i++) state.bag.push(color);
  }
}

function finishTurn(state: GameState): void {
  const stats = getStats(state, state.turn);
  if (stats.tokenCount > 10) {
    state.phase = 'discard';
    state.pending = { kind: 'discard', count: stats.tokenCount - 10 };
    return;
  }
  state.pending = null;
  state.victoryReasons = [];
  if (stats.points >= 20) state.victoryReasons.push('prestige');
  if (stats.crowns >= 10) state.victoryReasons.push('crowns');
  if (GEM_COLORS.some(color => stats.colorPoints[color] >= 10)) state.victoryReasons.push('color');
  if (state.victoryReasons.length) {
    state.winner = state.turn;
    state.phase = 'gameOver';
    log(state, `${state.players[state.turn].name}获胜！`);
    return;
  }
  if (state.extraTurns > 0) {
    state.extraTurns--;
    log(state, `${state.players[state.turn].name}开始额外回合。`);
  } else state.turn = other(state.turn);
  state.turnNumber++;
  state.phase = 'start';
}

function resolveEffects(state: GameState): void {
  state.pending = null;
  state.phase = 'effect';
  const player = state.players[state.turn];
  while (state.effects.length) {
    const task = state.effects[0];
    if (task.kind === 'chooseColor') {
      const colors = GEM_COLORS.filter(color => player.cards.some(owned => owned.color === color && getJewel(owned.cardId).bonus !== null));
      state.pending = { kind: 'chooseColor', cardId: task.cardId!, colors };
      return;
    }
    if (task.kind === 'drawGem') {
      const color = player.cards.find(owned => owned.cardId === task.cardId)?.color;
      const indices = state.board.flatMap((token, index) => token === color ? [index] : []);
      if (color && indices.length) {
        state.pending = { kind: 'takeBonusToken', cardId: task.cardId!, color, indices };
        return;
      }
      log(state, '棋盘没有对应颜色筹码，跳过取币能力。');
    } else if (task.kind === 'steal') {
      const colors = COST_COLORS.filter(color => state.players[other(state.turn)].tokens[color] > 0);
      if (colors.length) {
        state.pending = { kind: 'stealToken', colors };
        return;
      }
      log(state, '对手没有可拿取的非黄金筹码，跳过能力。');
    } else if (task.kind === 'privilege') grantPrivilege(state, state.turn);
    else if (task.kind === 'replay') {
      state.extraTurns++;
      log(state, `${player.name}获得 1 个额外回合。`);
    } else if (task.kind === 'royal') {
      state.pending = { kind: 'chooseRoyal', threshold: task.threshold!, cardIds: [...state.royals] };
      return;
    }
    state.effects.shift();
  }
  finishTurn(state);
}

function apply(state: GameState, action: Action): void {
  requireRule(state.phase !== 'gameOver', '本局已经结束，请开始新局。');
  const player = state.players[state.turn];
  const pending = state.pending;
  if (pending) {
    if (pending.kind === 'discard' && action.type === 'discard') {
      assertWallet(action.tokens);
      requireRule(countTokens(action.tokens) === pending.count, `请选择恰好 ${pending.count} 枚筹码归还。`);
      requireRule(TOKEN_COLORS.every(color => action.tokens[color] <= player.tokens[color]), '不能归还未持有的筹码。');
      for (const color of TOKEN_COLORS) {
        player.tokens[color] -= action.tokens[color];
        for (let i = 0; i < action.tokens[color]; i++) state.bag.push(color);
      }
      log(state, `${player.name}归还 ${pending.count} 枚筹码。`);
      finishTurn(state);
      return;
    }
    if (pending.kind === 'chooseColor' && action.type === 'chooseColor') {
      requireRule(pending.colors.includes(action.color), '只能复制自己已有的加成颜色。');
      player.cards.find(owned => owned.cardId === pending.cardId)!.color = action.color;
      log(state, `${player.name}将复制牌归入${COLOR_NAMES[action.color]}。`);
    } else if (pending.kind === 'takeBonusToken' && action.type === 'takeBonusToken') {
      requireRule(pending.indices.includes(action.index), '请选择棋盘上对应颜色的筹码。');
      takeToken(state, action.index);
      log(state, `${player.name}通过能力获得 1 枚${COLOR_NAMES[pending.color]}。`);
    } else if (pending.kind === 'stealToken' && action.type === 'stealToken') {
      requireRule(pending.colors.includes(action.color), '对手没有这种可拿取筹码。');
      state.players[other(state.turn)].tokens[action.color]--;
      player.tokens[action.color]++;
      log(state, `${player.name}从对手处拿取 1 枚${COLOR_NAMES[action.color]}。`);
    } else if (pending.kind === 'chooseRoyal' && action.type === 'chooseRoyal') {
      requireRule(pending.cardIds.includes(action.cardId), '请选择一张剩余王室牌。');
      state.royals.splice(state.royals.indexOf(action.cardId), 1);
      player.royals.push(action.cardId);
      player.royalClaims.push(pending.threshold);
      log(state, `${player.name}获得王室牌 ${action.cardId}。`);
      state.effects.shift();
      const effect = getRoyal(action.cardId).effect;
      if (effect) state.effects.unshift({ kind: effect });
      resolveEffects(state);
      return;
    } else throw new RuleError('请先完成当前的选择。');
    state.effects.shift();
    resolveEffects(state);
    return;
  }
  requireRule(state.phase === 'start' || state.phase === 'main', '当前不能执行主行动。');
  if (action.type === 'usePrivilege') {
    requireRule(state.phase === 'start', '补充棋盘之后不能再使用特权。');
    requireRule(player.privileges > 0, '你没有可用的特权。');
    requireRule(isIndex(action.index) && state.board[action.index] !== null && state.board[action.index] !== 'gold', '特权只能拿取一枚非黄金筹码。');
    requireRule(privilegeCanCompleteTurn(state, action.index), '这次使用特权会导致无法完成主行动，请保留筹码或直接执行主行动。');
    player.privileges--;
    state.privilegeSupply++;
    const token = takeToken(state, action.index);
    log(state, `${player.name}使用特权拿取 1 枚${COLOR_NAMES[token]}。`);
    return;
  }
  if (action.type === 'refill') {
    requireRule(state.phase === 'start', '每回合只能在主行动之前补充一次棋盘。');
    requireRule(state.bag.length > 0, '袋中没有筹码，无法补充。');
    refillBoard(state);
    state.phase = 'main';
    log(state, `${player.name}补充棋盘。`);
    grantPrivilege(state, other(state.turn));
    return;
  }
  if (action.type === 'takeTokens') {
    requireRule(isValidTake(state, action.indices), '请选择一条横、竖或斜线上的 1～3 枚连续非黄金筹码。');
    const tokens = action.indices.map(index => takeToken(state, index));
    log(state, `${player.name}拿取 ${tokens.map(token => COLOR_NAMES[token]).join('、')}。`);
    if ((tokens.length === 3 && tokens.every(token => token === tokens[0])) || tokens.filter(token => token === 'pearl').length === 2) grantPrivilege(state, other(state.turn));
    finishTurn(state);
    return;
  }
  if (action.type === 'reserve') {
    requireRule(player.reserved.length < 3, '最多只能预留 3 张牌。');
    requireRule(isIndex(action.goldIndex) && state.board[action.goldIndex] === 'gold', '预留卡牌需要先拿取棋盘上的一枚黄金。');
    requireRule(action.source.kind !== 'reserve', '只能预留公开牌或牌库顶牌。');
    const id = resolveSource(state, action.source);
    requireRule(id !== null, '这里没有可预留的卡牌。');
    takeToken(state, action.goldIndex);
    removeSource(state, action.source);
    player.reserved.push(id);
    // A blind reservation must never put its identity in the public log.
    log(state, action.source.kind === 'deck' ? `${player.name}从 ${action.source.level} 级牌库盲预留 1 张牌。` : `${player.name}预留公开牌 ${id}。`);
    finishTurn(state);
    return;
  }
  if (action.type === 'buy') {
    requireRule(action.source.kind !== 'deck', '不能直接购买牌库里的牌。');
    const id = resolveSource(state, action.source);
    requireRule(id !== null, '这里没有可购买的卡牌。');
    requireRule(canBuy(state, state.turn, id), '筹码不足，或尚未拥有可复制的加成颜色。');
    pay(state, id, action.payment ?? getPayment(state, state.turn, id)!);
    removeSource(state, action.source);
    const card = getJewel(id);
    player.cards.push({ cardId: id, color: card.bonus && card.bonus.color !== 'choice' ? card.bonus.color : null });
    log(state, `${player.name}购买卡牌 ${id}。`);
    if (card.bonus?.color === 'choice') state.effects.push({ kind: 'chooseColor', cardId: id });
    state.effects.push(...card.effects.map(kind => ({ kind, cardId: id })));
    const crowns = getStats(state, state.turn).crowns;
    for (const threshold of [3, 6] as const) {
      if (crowns >= threshold && !player.royalClaims.includes(threshold)) state.effects.push({ kind: 'royal', threshold });
    }
    resolveEffects(state);
    return;
  }
  throw new RuleError('当前阶段不能执行这个操作。');
}

/** Atomic transition: invalid commands never mutate the supplied snapshot. */
export function applyAction(state: GameState, action: Action): ActionResult {
  const next = structuredClone(state);
  try {
    apply(next, action);
    next.revision++;
    return { ok: true, state: next };
  } catch (error) {
    if (error instanceof RuleError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Enumerates choices; buy/discard use one default payment, not every equivalent wallet. */
export function getLegalActions(state: GameState): Action[] {
  if (state.phase === 'gameOver') return [];
  const pending = state.pending;
  if (pending) {
    if (pending.kind === 'chooseColor') return pending.colors.map(color => ({ type: 'chooseColor', color }));
    if (pending.kind === 'takeBonusToken') return pending.indices.map(index => ({ type: 'takeBonusToken', index }));
    if (pending.kind === 'stealToken') return pending.colors.map(color => ({ type: 'stealToken', color }));
    if (pending.kind === 'chooseRoyal') return pending.cardIds.map(cardId => ({ type: 'chooseRoyal', cardId }));
    const tokens = emptyWallet();
    let remaining = pending.count;
    for (const color of TOKEN_COLORS) {
      tokens[color] = Math.min(remaining, state.players[state.turn].tokens[color]);
      remaining -= tokens[color];
    }
    return [{ type: 'discard', tokens }];
  }
  const actions: Action[] = [];
  if (state.phase === 'start') {
    if (state.players[state.turn].privileges > 0) {
      state.board.forEach((token, index) => {
        if (token !== null && token !== 'gold' && privilegeCanCompleteTurn(state, index)) actions.push({ type: 'usePrivilege', index });
      });
    }
    if (state.bag.length) actions.push({ type: 'refill' });
  }
  for (let start = 0; start < 25; start++) {
    if (isValidTake(state, [start])) actions.push({ type: 'takeTokens', indices: [start] });
    for (const [dr, dc] of [[0, 1], [1, -1], [1, 0], [1, 1]]) {
      const indices = [start];
      for (let step = 1; step < 3; step++) {
        const r = Math.floor(start / 5) + dr * step;
        const c = start % 5 + dc * step;
        if (r < 0 || r >= 5 || c < 0 || c >= 5) break;
        indices.push(r * 5 + c);
        if (isValidTake(state, indices)) actions.push({ type: 'takeTokens', indices: [...indices] });
      }
    }
  }
  if (state.players[state.turn].reserved.length < 3) {
    const sources = reservableSources(state);
    state.board.forEach((token, goldIndex) => {
      if (token === 'gold') for (const source of sources) actions.push({ type: 'reserve', goldIndex, source });
    });
  }
  for (const source of purchasableSources(state)) actions.push({ type: 'buy', source, payment: getPayment(state, state.turn, resolveSource(state, source)!)! });
  return actions;
}

/** Projection for future network transport. Never send the full GameState to a peer. */
export function getPlayerView(state: GameState, viewer: PlayerId) {
  return {
    version: state.version, revision: state.revision, turn: state.turn, turnNumber: state.turnNumber,
    phase: state.phase, board: [...state.board], bagCount: state.bag.length,
    deckCounts: { 1: state.decks[1].length, 2: state.decks[2].length, 3: state.decks[3].length },
    market: structuredClone(state.market), royals: [...state.royals], privilegeSupply: state.privilegeSupply,
    players: state.players.map((player, i) => ({
      name: player.name, tokens: { ...player.tokens }, cards: structuredClone(player.cards),
      reserved: i === viewer ? [...player.reserved] : player.reserved.map(() => null),
      royals: [...player.royals], privileges: player.privileges, stats: getStats(state, i as PlayerId),
    })),
    pending: viewer === state.turn ? structuredClone(state.pending) : null,
    winner: state.winner, victoryReasons: [...state.victoryReasons], log: [...state.log],
  };
}

export function validateState(state: GameState): string[] {
  const errors: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) errors.push(message); };
  const integer = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  try {
    check(state.version === 1, '存档版本不支持');
    check(typeof state.seed === 'string' && state.seed.length <= 1000, '随机种子无效');
    check(integer(state.rng) && state.rng > 0 && state.rng <= 0xffffffff, '随机状态无效');
    check(integer(state.revision) && integer(state.turnNumber) && state.turnNumber > 0, '回合计数无效');
    check(state.turn === 0 || state.turn === 1, '当前玩家无效');
    check(['start', 'main', 'effect', 'discard', 'gameOver'].includes(state.phase), '阶段无效');
    check(state.players.length === 2 && state.board.length === 25, '局面大小无效');
    check(integer(state.privilegeSupply) && integer(state.extraTurns), '特权或额外回合无效');
    check(state.bag.every(token => TOKEN_COLORS.includes(token)), '袋中筹码类型无效');
    const totals = emptyWallet();
    for (const token of [...state.board, ...state.bag]) {
      if (token !== null) {
        check(TOKEN_COLORS.includes(token), '未知筹码');
        totals[token]++;
      }
    }
    const cardIds: string[] = [];
    const royalIds = [...state.royals];
    for (const level of LEVELS) {
      check(state.market[level].length === MARKET_SIZE[level], '市场大小无效');
      check(state.decks[level].every(id => typeof id === 'string' && getJewel(id).level === level), '牌库包含无效卡牌');
      for (const id of [...state.decks[level], ...state.market[level]]) {
        if (id !== null) {
          check(getJewel(id).level === level, '卡牌等级错误');
          cardIds.push(id);
        }
      }
    }
    for (const [i, player] of state.players.entries()) {
      check(typeof player.name === 'string' && player.name.length <= 20, '玩家名称无效');
      check(integer(player.privileges) && player.privileges <= 3, '玩家特权数无效');
      check(player.reserved.length <= 3, '预留牌超过上限');
      check(player.royals.length <= 2 && player.royalClaims.length === player.royals.length, '王室奖励记录错误');
      check(new Set(player.royalClaims).size === player.royalClaims.length && player.royalClaims.every(n => n === 3 || n === 6), '王室门槛无效');
      check(!player.royalClaims.includes(6) || player.royalClaims.includes(3), '王室门槛顺序错误');
      for (const color of TOKEN_COLORS) {
        check(integer(player.tokens[color]), '玩家筹码数量无效');
        totals[color] += player.tokens[color];
      }
      if (i !== state.turn || state.phase === 'gameOver' || (state.phase === 'start' && state.revision === 0)) check(countTokens(player.tokens) <= 10, '非行动玩家筹码超过上限');
      cardIds.push(...player.reserved);
      for (const owned of player.cards) {
        const card = getJewel(owned.cardId);
        cardIds.push(owned.cardId);
        const unresolved = state.pending?.kind === 'chooseColor' && state.pending.cardId === owned.cardId && i === state.turn;
        check(card.bonus?.color === 'choice' ? (owned.color !== null && GEM_COLORS.includes(owned.color)) || (owned.color === null && unresolved) : owned.color === (card.bonus?.color ?? null), '卡牌加成颜色错误');
      }
      royalIds.push(...player.royals);
      check(player.royalClaims.every(n => getStats(state, i as PlayerId).crowns >= n), '王冠不足以领取王室');
    }
    check(TOKEN_COLORS.every(color => totals[color] === INITIAL_TOKENS[color]), '筹码不守恒');
    check(state.privilegeSupply + state.players[0].privileges + state.players[1].privileges === 3, '特权不守恒');
    check(cardIds.length === JEWEL_CARDS.length && new Set(cardIds).size === JEWEL_CARDS.length && cardIds.every(id => JEWEL_CARDS.some(card => card.id === id)), '宝石牌不守恒');
    check(royalIds.length === ROYAL_CARDS.length && new Set(royalIds).size === ROYAL_CARDS.length && royalIds.every(id => ROYAL_CARDS.some(card => card.id === id)), '王室牌不守恒');
    check(Array.isArray(state.log) && state.log.length <= 120 && state.log.every(item => typeof item === 'string' && item.length <= 500), '日志格式无效');
    check(Array.isArray(state.effects) && state.effects.length <= 12 && state.effects.every(task => ['chooseColor', 'royal', 'drawGem', 'steal', 'replay', 'privilege'].includes(task.kind)), '效果队列无效');
    const active = state.players[state.turn];
    for (const task of state.effects) {
      if (task.kind === 'royal') {
        check((task.threshold === 3 || task.threshold === 6) && !active.royalClaims.includes(task.threshold) && getStats(state, state.turn).crowns >= task.threshold && state.royals.length > 0, '王室奖励来源无效');
      } else if (task.cardId !== undefined) {
        const owned = active.cards.find(card => card.cardId === task.cardId);
        check(owned !== undefined, '效果来源卡牌不属于当前玩家');
        const card = getJewel(task.cardId);
        if (task.kind === 'chooseColor') check(card.bonus?.color === 'choice' && owned?.color === null, '复制颜色来源无效');
        else check(card.effects.includes(task.kind), '卡牌不具有待处理能力');
      } else {
        check(task.kind !== 'chooseColor' && task.kind !== 'drawGem' && active.royals.some(id => getRoyal(id).effect === task.kind), '缺少有效的能力来源');
      }
    }
    if (state.phase === 'effect') {
      check(state.pending !== null && state.pending.kind !== 'discard' && state.effects.length > 0, '缺少能力选择');
      const probe = structuredClone(state);
      resolveEffects(probe);
      check(JSON.stringify(probe.pending) === JSON.stringify(state.pending) && JSON.stringify(probe.effects) === JSON.stringify(state.effects), '能力目标与局面不匹配');
    } else if (state.phase === 'discard') {
      check(state.effects.length === 0 && state.pending?.kind === 'discard' && state.pending.count === countTokens(state.players[state.turn].tokens) - 10 && state.pending.count > 0, '弃币数量无效');
    } else check(state.pending === null && state.effects.length === 0, '阶段与待选项不匹配');
    if (state.phase === 'gameOver') {
      const stats = getStats(state, state.turn);
      const reasons = [stats.points >= 20 && 'prestige', stats.crowns >= 10 && 'crowns', GEM_COLORS.some(color => stats.colorPoints[color] >= 10) && 'color'].filter(Boolean);
      check(state.winner === state.turn && reasons.length > 0 && JSON.stringify(reasons) === JSON.stringify(state.victoryReasons), '胜负记录无效');
    } else check(state.winner === null && state.victoryReasons.length === 0, '未结束对局包含胜者');
    if (!errors.length && state.phase !== 'gameOver') check(getLegalActions(state).length > 0, '对局没有可执行操作');
  } catch {
    errors.push('存档结构不完整或包含未知卡牌');
  }
  return errors;
}

export function serializeGame(state: GameState): string { return JSON.stringify(state); }

export function parseSave(json: string): GameState | null {
  if (json.length > 250_000) return null;
  try {
    const state = JSON.parse(json) as GameState;
    return validateState(state).length === 0 ? state : null;
  } catch { return null; }
}
