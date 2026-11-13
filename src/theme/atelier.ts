import { JEWEL_CARDS, ROYAL_CARDS } from '../game/catalog';
import { COLOR_NAMES, type GemColor } from '../game/types';
import type { Theme } from './types';

// Original geometric illustrations. No external images, franchise characters or logos.
const palettes: Record<GemColor, [string, string, string]> = {
  white: ['#eee7ce', '#716a5b', '#fff8e6'], blue: ['#70bde7', '#23496c', '#c5eaff'],
  green: ['#64bc9b', '#235e50', '#c0f6d4'], red: ['#e67b76', '#6c2e38', '#ffd1bb'],
  black: ['#ac96d0', '#453457', '#e2cff8'],
};
const svg = (body: string, width = 300, height = 400) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`)}`;
function illustration(id: string, color: GemColor, level: number) {
  const [light, dark, edge] = palettes[color];
  const n = [...id].reduce((sum, c) => Math.imul(sum, 31) + c.charCodeAt(0) >>> 0, 7);
  const crystals = Array.from({ length: 3 + level }, (_, i) => {
    const x = 55 + (i * 43 + n % 25) % 190, y = 185 + (i * 29 + n % 43) % 95;
    const h = 48 + (n % 31) + i * 9, w = 16 + i * 3;
    return `<path d="M${x} ${y-h}l${w} ${h*.42}v${h*.66}l-${w} ${h*.27}l-${w} -${h*.27}v-${h*.66}Z" fill="url(#crystal)" stroke="${edge}" stroke-width="1.1"/><path d="M${x} ${y-h}v${h*1.35}m-${w} -${h*.93}l${w} ${h*.18}l${w} -${h*.18}" fill="none" stroke="${edge}" opacity=".55"/>`;
  }).join('');
  return svg(`<defs><linearGradient id="bg" x2=".7" y2="1"><stop stop-color="${dark}"/><stop offset="1" stop-color="#101a27"/></linearGradient><linearGradient id="crystal" x2="1" y2="1"><stop stop-color="${edge}"/><stop offset=".35" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient><radialGradient id="halo"><stop stop-color="${light}" stop-opacity=".35"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></radialGradient></defs><path fill="url(#bg)" d="M0 0h300v400H0Z"/><circle cx="150" cy="170" r="140" fill="url(#halo)"/><g fill="none" stroke="${edge}" opacity=".14"><circle cx="150" cy="170" r="108"/><circle cx="150" cy="170" r="116"/><path d="M20 170h260M150 45v260M30 334h240"/></g><path d="M0 290L68 245L132 280L210 236L300 278v122H0Z" fill="#0b1421" opacity=".65"/><ellipse cx="155" cy="305" rx="102" ry="17" fill="#0a1320" stroke="${light}" stroke-opacity=".35"/>${crystals}<path d="M15 16h270v368H15Z" fill="none" stroke="${edge}" stroke-opacity=".28"/><text x="150" y="361" text-anchor="middle" fill="${edge}" opacity=".65" font-family="monospace" font-size="12" letter-spacing="3">${id.toUpperCase()}</text>`);
}
const colors = Object.keys(palettes) as GemColor[];
const units = Object.fromEntries(colors.map((color, index) => {
  const [shell, shade, trim] = palettes[color];
  return [color, { name: COLOR_NAMES[color], model: String(index), shell, shade, accent: trim, trim }];
})) as Theme['units'];
const cards = JEWEL_CARDS.map((card, i) => ({ id: card.id, title: `工坊 ${card.level} · ${card.id.slice(-2)}`, file: illustration(card.id, card.bonus?.color && card.bonus.color !== 'choice' ? card.bonus.color : colors[i % 5], card.level) }));
cards.push(...ROYAL_CARDS.map((card, i) => ({ id: card.id, title: ['观测者', '领航者', '守望者', '典藏者'][i], file: illustration(card.id, colors[i], 3) })));
const decks = Object.fromEntries(([1, 2, 3] as const).map(level => [level, { name: `${level} 级牌库`, unit: `ATELIER ${['I', 'II', 'III'][level-1]}`, image: svg(`<defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#263749"/><stop offset="1" stop-color="#101721"/></linearGradient></defs><path fill="url(#b)" d="M0 0h300v400H0Z"/><g fill="none" stroke="#d1b47d"><path d="M20 20h260v360H20ZM30 30h240v340H30Z" opacity=".5"/><path d="M150 85L240 200L150 315L60 200Z"/><circle cx="150" cy="200" r="65"/><path d="M150 105v190M75 200h150" opacity=".4"/></g><text x="150" y="216" text-anchor="middle" fill="#e8d7b5" font-family="serif" font-size="47">${['I','II','III'][level-1]}</text>`) }])) as Theme['decks'];
export const atelier: Theme = {
  id: 'atelier', title: 'Duel Atelier · 对决工坊', units, resources: { ...COLOR_NAMES }, decks, cards,
  portraitIds: ['r1', 'r2', 'r3', 'r4', 'j1-11', 'j1-06'],
  table: svg('<defs><radialGradient id="b"><stop stop-color="#27303b"/><stop offset="1" stop-color="#101720"/></radialGradient><pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#d4bf91" stroke-opacity=".045"/></pattern></defs><path d="M0 0h1600v900H0Z" fill="url(#b)"/><path d="M0 0h1600v900H0Z" fill="url(#p)"/><g fill="none" stroke="#bda57b" stroke-opacity=".12"><circle cx="720" cy="410" r="300"/><circle cx="720" cy="410" r="330"/><path d="M50 50h1500v800H50Z"/></g>', 1600, 900),
};
