import { useId, type CSSProperties } from 'react';
import { COST_COLORS, type JewelCard, type RoyalCard, type TokenColor } from '../game/types';
import { getCardArt, PORTRAITS, RESOURCE_NAMES as COLOR_NAMES } from '../theme';
import { UnitEmblem } from './UnitEmblem';

const PALETTES: Record<'pearl' | 'gold' | 'choice', [string, string, string]> = {
  pearl: ['#fffdf3', '#e3d6d3', '#a699ae'],
  gold: ['#fff4a7', '#d6a338', '#81521a'], choice: ['#dfc4ff', '#7d81c5', '#4d286b'],
};
const EFFECT_NAMES = { replay: '额外回合', drawGem: '同色筹码', privilege: '特权', steal: '窃取' };
const EFFECT_ICONS = { replay: '↻', drawGem: '⊕', privilege: '▱', steal: '⇄' };

export function Gem({ color, small = false }: { color: TokenColor | 'choice'; small?: boolean }) {
  const id = useId().replace(/:/g, '');
  if (color !== 'gold' && color !== 'pearl' && color !== 'choice') return <span className={`gem unit-gem gem-${color}${small ? ' gem-small' : ''}`} aria-hidden="true"><UnitEmblem color={color} /></span>;
  const [light, mid, dark] = PALETTES[color as keyof typeof PALETTES];
  return <span className={`gem gem-${color}${small ? ' gem-small' : ''}`} aria-hidden="true"><svg viewBox="0 0 72 64" focusable="false">
    <defs>
      <linearGradient id={`${id}-cut`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor={light} /><stop offset=".38" stopColor={mid} /><stop offset="1" stopColor={dark} /></linearGradient>
      <radialGradient id={`${id}-round`} cx=".32" cy=".24" r=".75"><stop stopColor="#fffdf3" /><stop offset=".35" stopColor={light} /><stop offset=".75" stopColor={mid} /><stop offset="1" stopColor={dark} /></radialGradient>
    </defs>
    {color === 'pearl' ? <><circle cx="36" cy="32" r="25" fill={`url(#${id}-round)`} stroke="#eee3cb" strokeWidth="1.4" /><ellipse cx="28" cy="20" rx="8" ry="5" fill="#fff" opacity=".72" /><path d="M19 42Q36 57 54 40" fill="none" stroke="#fff9eb" opacity=".55" /></>
      : color === 'gold' ? <><path d="M15 17L55 12L66 42L16 53L6 39Z" fill={`url(#${id}-cut)`} stroke="#f5d16c" strokeWidth="1.5" /><path d="M15 17L55 12L53 35L16 43Z" fill="#efc963" stroke="#fff2ac" /><path d="M16 43L66 32L66 42L16 53Z" fill="#ac741d" /><path d="M24 25L44 22M25 29L42 26" stroke="#ab7529" strokeWidth="2" /></>
      : <><path d="M36 5L61 18V46L36 59L11 46V18Z" fill={`url(#${id}-cut)`} stroke="#d8c2ff" strokeWidth="2" /><path d="M25 22H45V40H25ZM29 18H49V36" fill="none" stroke="#fff0fe" strokeWidth="3" /></>}
  </svg></span>;
}
export function Token({ color, count, selected = false }: { color: TokenColor; count?: number; selected?: boolean }) {
  const special = color === 'pearl' || color === 'gold';
  return <span className={`token token-${color}${special ? ' special-token' : ''}${selected ? ' token-selected' : ''}`} aria-hidden="true">
    <Gem color={color} />{count !== undefined && <b className="token-count">{count}</b>}
  </span>;
}

export function Scroll({ count }: { count?: number }) {
  return <span className="scroll-piece" aria-hidden="true"><svg viewBox="0 0 66 62" focusable="false">
    <path d="M18 6H52Q59 6 56 14L46 48H13L23 13H16Q10 13 13 8Q14 6 18 6Z" fill="#ecd9a4" stroke="#92703e" strokeWidth="2" />
    <path d="M15 45H46Q43 55 35 55H9Q3 55 6 49Q8 43 15 45Z" fill="#c9a76b" stroke="#92703e" strokeWidth="2" />
    <path d="M23 12H52M25 21H45M22 27H42M20 33H36" stroke="#9a784c" strokeWidth="1.6" /><path d="M35 32L41 37L35 45L30 40Z" fill="#9b3445" stroke="#633040" />
  </svg>{count !== undefined && <b className="token-count">{count}</b>}</span>;
}

export function Crown() {
  return <svg className="crown-icon" viewBox="0 0 36 28" aria-hidden="true"><path d="M3 5L11 12L18 2L25 12L33 5L28 23H8Z" fill="#ffdf6d" stroke="#fff7cb" strokeWidth="1.5" strokeLinejoin="round" /><path d="M8 25H28" stroke="#ffdf6d" strokeWidth="3" /><path d="M10 19H26" stroke="#97552b" strokeWidth="2" /></svg>;
}

export function Card({ card, selected, disabled, affordable, onClick }: {
  card: JewelCard; selected?: boolean; disabled?: boolean; affordable?: boolean; onClick?: () => void;
}) {
  const color = card.bonus?.color ?? 'neutral';
  const art = getCardArt(card.id);
  const artStyle = { '--card-art': `url("${art.file}")` } as CSSProperties;
  const costs = COST_COLORS.filter(c => card.cost[c] > 0);
  const description = `${card.points}分，${card.crowns}王冠${card.bonus ? `，${card.bonus.color === 'choice' ? '复制已有颜色' : COLOR_NAMES[card.bonus.color]}加成${card.bonus.amount}` : ''}，费用${costs.map(c => `${COLOR_NAMES[c]}${card.cost[c]}`).join('、') || '零'}${card.effects.length ? `，${card.effects.map(e => EFFECT_NAMES[e]).join('、')}` : ''}`;
  return <button type="button" onClick={onClick} disabled={disabled} style={artStyle}
    className={`jewel-card card-${color}${selected ? ' selected' : ''}${affordable ? ' affordable' : ''}`}
    aria-pressed={selected || false} aria-label={`${art.title}，${description}`} title={art.title} data-card-id={card.id}>
    <span className="card-art" />
    <span className="card-sheen" />
    {card.points > 0 && <span className="card-points">{card.points}</span>}
    {card.bonus && <span className="card-bonus" title={card.bonus.color === 'choice' ? '复制已有颜色' : `${COLOR_NAMES[card.bonus.color]}加成${card.bonus.amount}`}><Gem color={card.bonus.color} />{card.bonus.amount > 1 && <b>×{card.bonus.amount}</b>}</span>}
    {card.crowns > 0 && <span className="card-crowns" title={`${card.crowns}王冠`} aria-label={`${card.crowns}王冠`}>{Array.from({ length: card.crowns }, (_, index) => <Crown key={index} />)}</span>}
    <span className="card-effects">{card.effects.map((effect, i) => <span key={`${effect}-${i}`} title={EFFECT_NAMES[effect]}>{EFFECT_ICONS[effect]}</span>)}</span>
    <span className="card-cost">{costs.map(c => <span key={c} className={`cost-pip cost-${c}`} title={`${COLOR_NAMES[c]} ${card.cost[c]}`}><Gem color={c} small /><svg className="cost-value" viewBox="0 0 40 40" aria-hidden="true"><text x="25" y="20" dominantBaseline="central" textAnchor="middle">{card.cost[c]}</text></svg></span>)}</span>
  </button>;
}

export function Portrait({ index }: { index: number }) {
  return <span className="portrait-art" style={{ backgroundImage: `url("${PORTRAITS[index].file}")` }} aria-hidden="true" />;
}

export function Royal({ card, selected, disabled, onClick }: { card: RoyalCard; selected?: boolean; disabled?: boolean; onClick?: () => void }) {
  const index = Number(card.id.replace(/\D/g, '')) - 1;
  return <button type="button" className={`royal-card${selected ? ' selected' : ''}`} title={getCardArt(card.id).title} aria-label={`${getCardArt(card.id).title}，王室，${card.points}分${card.effect ? `，${EFFECT_NAMES[card.effect]}` : ''}`} disabled={disabled} onClick={onClick} data-royal-id={card.id}>
    <Portrait index={index} /><span className="royal-seal" aria-hidden="true"><i /><i /><i /></span>
    <span className="royal-points">{card.points}</span>{card.effect && <span className="royal-effect" title={EFFECT_NAMES[card.effect]}>{EFFECT_ICONS[card.effect]}</span>}
  </button>;
}
