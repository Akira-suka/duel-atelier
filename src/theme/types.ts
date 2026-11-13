import type { ComponentType } from 'react';
import type { GemColor, Level, TokenColor } from '../game/types';

export interface CardArt { id: string; title: string; file: string }
export interface ResourceStyle { name: string; model: string; shell: string; shade: string; accent: string; trim: string }
export interface Theme {
  id: string;
  title: string;
  units: Record<GemColor, ResourceStyle>;
  resources: Record<TokenColor, string>;
  decks: Record<Level, { name: string; unit: string; image: string }>;
  cards: CardArt[];
  portraitIds: string[];
  table: string;
  Emblem?: ComponentType<{ color: GemColor }>;
}
