import { useId } from 'react';
import { theme, UNITS } from '../theme';
import type { GemColor } from '../game/types';
import './unit-emblem.css';

export function UnitEmblem({ color }: { color: GemColor }) {
  const id = `gem-${useId().replace(/:/g, '')}`;
  if (theme.Emblem) { const Emblem = theme.Emblem; return <Emblem color={color} />; }
  const unit = UNITS[color];
  return <svg className="unit-emblem" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <defs><linearGradient id={id} x2="1" y2="1"><stop stopColor={unit.trim}/><stop offset=".45" stopColor={unit.shell}/><stop offset="1" stopColor={unit.shade}/></linearGradient></defs>
    <path d="M18 10H46L59 27L32 57L5 27Z" fill={`url(#${id})`} stroke={unit.trim} strokeWidth="2"/>
    <path d="M18 10L24 27L32 57L40 27L46 10M5 27H59M24 27L32 10L40 27" fill="none" stroke={unit.trim} strokeWidth="1.5" opacity=".7"/>
  </svg>;
}
