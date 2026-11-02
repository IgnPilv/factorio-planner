// What each belt, inserter and chest carries, for the game-style "alt-mode" item
// icons on the grid. Pure, so it can be tested without a canvas.

import type { SteadyStateResult } from '../calc';
import type { Flow } from '../calc/flow';
import { ENTITIES } from './catalog';
import type { PlacedEntity } from './model';

const TRANSPORT = new Set(['belt', 'underground-belt', 'splitter', 'inserter', 'chest']);

const top = (flows: readonly Flow[], n: number) =>
  [...flows].filter((f) => f.perSecond > 1e-7).sort((a, b) => b.perSecond - a.perSecond || a.name.localeCompare(b.name)).slice(0, n).map((f) => f.name);

const LANED = new Set(['belt', 'underground-belt', 'splitter']);

export interface Contents {
  /** Item names, busiest first. */
  items: string[];
  /** Belts, undergrounds and splitters: the busiest item on each lane, seen facing the way the belt moves. */
  lanes?: { left?: string; right?: string };
}

/**
 * Items to show on each transport building: per lane on belts, undergrounds and
 * splitters (the busiest item on each), one per inserter and chest. Uses the
 * steady-state flows when there are any; otherwise what the settings say
 * (supply chest item, inserter filter).
 */
export function entityContents(entities: readonly PlacedEntity[], sim: SteadyStateResult | null | undefined): Record<string, Contents> {
  const out: Record<string, Contents> = {};
  for (const e of entities) {
    const kind = ENTITIES[e.name]?.kind;
    if (!kind || !TRANSPORT.has(kind)) continue;
    let items: string[] = [];
    if (kind === 'chest') {
      const c = sim?.chests?.[e.id];
      items = c ? top([...c.supplied, ...c.stored], 1) : [];
      if (!items.length && e.recipe) items = [e.recipe];
    } else {
      const t = sim?.transport[e.id];
      if (t?.lanes && LANED.has(kind)) {
        const left = top(t.lanes.left, 1)[0];
        const right = top(t.lanes.right, 1)[0];
        if (left || right) out[e.id] = { items: top(t.items, 2), lanes: { left, right } };
        continue;
      }
      items = t ? top(t.items, kind === 'inserter' ? 1 : 2) : [];
      if (!items.length && kind === 'inserter' && e.filters?.length && e.filterMode !== 'blacklist') items = [e.filters[0]];
    }
    if (items.length) out[e.id] = { items };
  }
  return out;
}
