import { useCallback, useEffect, useRef, useState } from 'react';
import { getJewel } from '../game/catalog';
import { TOKEN_COLORS, type Action, type GameState, type Level, type PlayerId, type TokenColor } from '../game/types';
import { DECKS } from '../theme';
import './table-motion.css';

export interface MotionMove {
  from: string[];
  to: string[];
  count: number;
  back?: Level;
  flip?: boolean;
}
export interface MotionArrival { from: string[]; to: string; level?: Level }
export interface TableMotionPlan { moves: MotionMove[]; arrivals: MotionArrival[] }

const board = (index: number) => `[data-board-index="${index}"] .token`;
const deck = (level: Level) => `[data-motion-deck="${level}"]`;
const market = (id: string) => `.market [data-card-id="${id}"]`;
const reserve = (player: PlayerId) => [`.player-rail [data-motion-reserve="${player}"]`, `[data-motion-reserve="${player}"]`];
const token = (player: PlayerId, color: TokenColor) => [
  `[data-motion-tray="${player}"] [data-motion-token="${color}"] .token`,
  `[data-motion-player="${player}"] [data-motion-token="${color}"] .gem`,
];

/** A visual plan contains only public selectors; blind reservations never read a card ID. */
export function planTableMotion(before: GameState, after: GameState, action: Action): TableMotionPlan {
  const actor = before.turn;
  const plan: TableMotionPlan = { moves: [], arrivals: [] };
  const take = (index: number) => {
    const color = before.board[index];
    if (color) plan.moves.push({ from: [board(index)], to: token(actor, color), count: 1 });
  };
  if (action.type === 'takeTokens') action.indices.forEach(take);
  if (action.type === 'usePrivilege' || action.type === 'takeBonusToken') take(action.index);
  if (action.type === 'stealToken') plan.moves.push({ from: token(actor === 0 ? 1 : 0, action.color), to: token(actor, action.color), count: 1 });
  if (action.type === 'buy' || action.type === 'discard') {
    for (const color of TOKEN_COLORS) {
      const count = Math.max(0, before.players[actor].tokens[color] - after.players[actor].tokens[color]);
      if (count) plan.moves.push({ from: token(actor, color), to: ['[data-motion-bag]'], count });
    }
  }
  if (action.type === 'reserve') {
    take(action.goldIndex);
    if (action.source.kind === 'deck') {
      plan.moves.push({ from: [deck(action.source.level)], to: reserve(actor), count: 1, back: action.source.level });
    } else if (action.source.kind === 'market') {
      const id = before.market[action.source.level][action.source.index];
      if (id) plan.moves.push({ from: [market(id)], to: reserve(actor), count: 1, back: action.source.level, flip: true });
    }
  }
  if (action.type === 'buy') {
    const destination = [`[data-motion-collection="${actor}"]`];
    if (action.source.kind === 'market') {
      const id = before.market[action.source.level][action.source.index];
      if (id) plan.moves.push({ from: [market(id)], to: destination, count: 1 });
    } else if (action.source.kind === 'reserve') {
      const id = before.players[actor].reserved[action.source.index];
      if (id) plan.moves.push({ from: reserve(actor), to: destination, count: 1, back: getJewel(id).level });
    }
  }
  if (action.type === 'chooseRoyal') plan.moves.push({ from: [`.royal-rail [data-royal-id="${action.cardId}"]`], to: [`[data-motion-collection="${actor}"]`], count: 1 });
  for (const level of [1, 2, 3] as const) {
    after.market[level].forEach((id, index) => {
      if (id && id !== before.market[level][index]) plan.arrivals.push({ from: [deck(level)], to: market(id), level });
    });
  }
  if (action.type === 'refill') after.board.forEach((color, index) => {
    if (color && before.board[index] === null) plan.arrivals.push({ from: ['[data-motion-bag]'], to: board(index) });
  });
  return plan;
}

interface Snapshot { node: HTMLElement; rect: DOMRect; width: number; height: number }
interface Run { finish: () => void }
let ghostSequence = 0;

function find(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const node = document.querySelector<HTMLElement>(selector);
    if (node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0) return node;
  }
  return null;
}

function snapshot(node: HTMLElement | null): Snapshot | null {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { node: node.cloneNode(true) as HTMLElement, rect, width: node.offsetWidth || rect.width, height: node.offsetHeight || rect.height };
}

function backSnapshot(level: Level, rect: DOMRect): Snapshot {
  const node = document.createElement('div');
  node.className = 'table-motion-back';
  node.style.backgroundImage = `url("${DECKS[level].image}")`;
  const width = Math.max(32, Math.min(rect.width, 110));
  const height = width / .75;
  return { node, width, height, rect: new DOMRect(rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height) };
}

/** Clones never retain live selectors, focus targets, public labels or duplicate SVG IDs. */
function prepareClone(source: Snapshot): HTMLElement {
  const clone = source.node.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.token-count,.deck-count').forEach(node => node.remove());
  const nodes = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
  const ids = new Map<string, string>();
  const prefix = `motion-${++ghostSequence}-`;
  for (const node of nodes) if (node.id) ids.set(node.id, prefix + ids.size);
  for (const node of nodes) {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('data-') || attr.name.startsWith('aria-') || attr.name.startsWith('on') || attr.name === 'title' || attr.name === 'tabindex') node.removeAttribute(attr.name);
      else if (attr.name === 'id') node.id = ids.get(attr.value)!;
      else {
        let value = attr.value;
        for (const [old, next] of ids) value = value.replaceAll(`url(#${old})`, `url(#${next})`).replaceAll(`url("#${old}")`, `url("#${next}")`);
        if ((attr.name === 'href' || attr.name === 'xlink:href') && value.startsWith('#') && ids.has(value.slice(1))) value = '#' + ids.get(value.slice(1));
        if (value !== attr.value) node.setAttribute(attr.name, value);
      }
    }
  }
  clone.classList.remove('selected', 'affordable', 'token-selected');
  Object.assign(clone.style, {
    position: 'absolute', left: '0', top: '0', margin: '0',
    width: `${source.width}px`, height: `${source.height}px`, minWidth: '0', minHeight: '0', maxWidth: 'none', maxHeight: 'none',
    transform: `scale(${source.rect.width / source.width}, ${source.rect.height / source.height})`, transformOrigin: '0 0',
    transition: 'none', animation: 'none', visibility: 'visible', opacity: '1', pointerEvents: 'none',
  });
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  return clone;
}

export function useTableMotion() {
  const [busy, setBusy] = useState(false);
  const active = useRef<Run | null>(null);
  const mounted = useRef(true);
  const cancel = useCallback(() => { active.current?.finish(); }, []);

  useEffect(() => {
    mounted.current = true;
    const visibility = () => { if (document.hidden) cancel(); };
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const preference = () => { if (media.matches) cancel(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', cancel);
    media.addEventListener('change', preference);
    return () => {
      mounted.current = false;
      cancel();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', cancel);
      media.removeEventListener('change', preference);
    };
  }, [cancel]);

  const animate = useCallback((before: GameState, after: GameState, action: Action, commit: () => void): Promise<void> => {
    cancel();
    let committed = false;
    const commitOnce = () => { if (!committed) { committed = true; commit(); } };
    if (!mounted.current || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof Element.prototype.animate !== 'function') {
      commitOnce();
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      let done = false;
      let frame = 0;
      let timer = 0;
      const animations: Animation[] = [];
      const hidden = new Set<string>();
      const layer = document.createElement('div');
      layer.className = 'table-motion-layer';
      layer.setAttribute('aria-hidden', 'true');
      layer.inert = true;
      const style = document.createElement('style');
      layer.append(style);
      const updateHidden = () => { style.textContent = [...hidden].map(selector => `${selector}{visibility:hidden!important}`).join('\n'); };
      const reveal = (selector: string) => { hidden.delete(selector); updateHidden(); };
      const run: Run = { finish: () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        animations.forEach(animation => { try { animation.cancel(); } catch { /* Already detached. */ } });
        layer.remove();
        try { commitOnce(); } finally {
          if (active.current === run) { active.current = null; if (mounted.current) setBusy(false); }
          resolve();
        }
      } };
      active.current = run;
      if (mounted.current) setBusy(true);

      const play = (node: HTMLElement, frames: Keyframe[], duration: number, delay: number) => {
        const animation = node.animate(frames, { duration, delay, easing: 'cubic-bezier(.22,.7,.25,1)', fill: 'both' });
        animations.push(animation);
        return animation.finished.catch(() => undefined);
      };
      const fly = (source: Snapshot, target: DOMRect, delay: number, flip?: { level: Level; incoming: boolean }, revealSelector?: string) => {
        const ghost = document.createElement('div');
        ghost.className = 'table-motion-ghost';
        Object.assign(ghost.style, { left: `${source.rect.x}px`, top: `${source.rect.y}px`, width: `${source.rect.width}px`, height: `${source.rect.height}px` });
        const front = document.createElement('div');
        front.className = 'table-motion-face';
        front.append(prepareClone(source));
        ghost.append(front);
        layer.append(ghost);
        const promises: Promise<unknown>[] = [];
        const duration = flip ? 440 : 380;
        if (flip) {
          const back = document.createElement('div');
          back.className = 'table-motion-face table-motion-back';
          back.style.backgroundImage = `url("${DECKS[flip.level].image}")`;
          ghost.append(back);
          const departing = flip.incoming ? back : front;
          const arriving = flip.incoming ? front : back;
          promises.push(play(departing, [{ transform: 'rotateY(0deg)', opacity: 1 }, { transform: 'rotateY(90deg)', opacity: 1, offset: .49 }, { transform: 'rotateY(90deg)', opacity: 0, offset: .5 }, { transform: 'rotateY(90deg)', opacity: 0 }], duration, delay));
          promises.push(play(arriving, [{ transform: 'rotateY(-90deg)', opacity: 0 }, { transform: 'rotateY(-90deg)', opacity: 0, offset: .49 }, { transform: 'rotateY(-90deg)', opacity: 1, offset: .5 }, { transform: 'rotateY(0deg)', opacity: 1 }], duration, delay));
        }
        const dx = target.x + target.width / 2 - source.rect.x - source.rect.width / 2;
        const dy = target.y + target.height / 2 - source.rect.y - source.rect.height / 2;
        const sx = target.width / source.rect.width;
        const sy = target.height / source.rect.height;
        promises.push(play(ghost, [
          { transform: 'translate(0px,0px) scale(1)', opacity: 1 },
          { transform: `translate(${dx * .5}px,${dy * .5 - 28}px) scale(${(1 + sx) / 2},${(1 + sy) / 2})`, opacity: 1, offset: .5 },
          { transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})`, opacity: revealSelector ? 1 : 0 },
        ], duration, delay));
        return Promise.all(promises).finally(() => { ghost.remove(); if (!done && revealSelector) reveal(revealSelector); });
      };

      try {
        const plan = planTableMotion(before, after, action);
        const captured = plan.moves.map(move => {
          let source = snapshot(find(move.from));
          if (source && move.back && !move.flip) source = backSnapshot(move.back, source.rect);
          return { move, source };
        });
        const incoming = plan.arrivals.map(arrival => ({ arrival, sourceRect: find(arrival.from)?.getBoundingClientRect() }));
        incoming.forEach(({ arrival, sourceRect }) => { if (sourceRect) hidden.add(arrival.to); });
        updateHidden();
        document.body.append(layer);
        timer = window.setTimeout(run.finish, 650);
        commitOnce();
        frame = requestAnimationFrame(() => {
          if (done) return;
          try {
            const promises: Promise<unknown>[] = [];
            let ordinal = 0;
            for (const { move, source } of captured) {
              const target = find(move.to)?.getBoundingClientRect();
              if (!source || !target) continue;
              for (let i = 0; i < move.count; i++) promises.push(fly(source, target, Math.min(ordinal++ * 18, 90), move.flip && move.back ? { level: move.back, incoming: false } : undefined));
            }
            incoming.forEach(({ arrival, sourceRect }, index) => {
              const destination = snapshot(find([arrival.to]));
              if (!destination || !sourceRect) { reveal(arrival.to); return; }
              const targetRect = destination.rect;
              const width = arrival.level ? Math.min(sourceRect.width, targetRect.width) : targetRect.width * .6;
              const height = arrival.level ? width / .75 : targetRect.height * .6;
              destination.rect = new DOMRect(sourceRect.x + (sourceRect.width - width) / 2, sourceRect.y + (sourceRect.height - height) / 2, width, height);
              promises.push(fly(destination, targetRect, arrival.level ? 110 : Math.min(index * 9, 160), arrival.level ? { level: arrival.level, incoming: true } : undefined, arrival.to));
            });
            void Promise.allSettled(promises).then(run.finish);
          } catch { run.finish(); }
        });
      } catch { run.finish(); }
    });
  }, [cancel]);

  return { busy, animate, cancel };
}
