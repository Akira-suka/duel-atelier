import type { TokenColor } from '../game/types';
import { RESOURCE_NAMES } from '../theme';
import { Gem } from './TablePieces';

export function ResourceCount({ color, tokens, assets }: { color: TokenColor; tokens: number; assets?: number }) {
  return <span className="resource-count" data-motion-token={color} title={`${RESOURCE_NAMES[color]}：${tokens} 筹码${assets === undefined ? '' : `，${assets} 资产`}`}>
    {assets !== undefined && <span className="resource-assets">+{assets}</span>}
    <Gem color={color} small /><b>{tokens}</b>
  </span>;
}
