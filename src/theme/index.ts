import { COLOR_NAMES, type TokenColor } from '../game/types';
import { atelier } from './atelier';
import type { Theme } from './types';

// Optional local themes are ignored by Git. A clean clone always runs independently.
const local = import.meta.glob<{ default: Theme }>('./local/*/theme.ts', { eager: true });
const requested = import.meta.env.VITE_THEME;
export const theme = Object.values(local).map(module => module.default).find(candidate => candidate.id === requested) ?? atelier;
export const UNITS = theme.units;
export const RESOURCE_NAMES = theme.resources;
export const DECKS = theme.decks;
const cards = new Map(theme.cards.map(card => [card.id, card]));
export function getCardArt(id: string) {
  const card = cards.get(id);
  if (!card) throw new Error(`缺少卡面主题：${id}`);
  return card;
}
export const PORTRAITS = theme.portraitIds.map(getCardArt);
export function themedText(text: string): string {
  return Object.entries(COLOR_NAMES).reduce((result, [key, name]) => result.replaceAll(name, RESOURCE_NAMES[key as TokenColor]), text);
}
export function themedLog(text: string, names: readonly string[]): string {
  if (names.some(first => names.some(second => text === `${first}先手，${second}获得 1 个特权。`))) return text;
  const name = [...names].sort((a, b) => b.length - a.length).find(value => text.startsWith(value));
  return name ? name + themedText(text.slice(name.length)) : themedText(text);
}
