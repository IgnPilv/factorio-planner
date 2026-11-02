// Export one city block as a game blueprint that tiles with absolute grid snapping.
//
// The tiled design is cut into identical cells of pitch x pitch tiles. A cell
// starts `S` tiles before its block's grid corner, so it holds the junction at
// that corner, half the corridor tracks on the top and left, and the block's
// buildings. Pasting the same blueprint into every grid cell rebuilds the network.

import { makeBlueprint, encodeBlueprintString, encodeJsonString, type Blueprint } from '../blueprint/format';
import { railEntity, signalEntity, trainStopEntity, type BlueprintEntityLike } from '../rails/blueprint';
import type { Design } from './block';

export interface BlockBlueprint {
  entities: (BlueprintEntityLike & { entity_number: number })[];
  /** World position of the cell's top-left corner. */
  origin: { x: number; y: number };
  json: { blueprint: Blueprint };
  string: string;
}

/** Which entities of the cell go into the blueprint. */
export type CellPart = 'all' | 'rails' | 'power';

const RAIL_NAMES = new Set(['straight-rail', 'half-diagonal-rail', 'curved-rail-a', 'curved-rail-b', 'rail-signal', 'rail-chain-signal', 'train-stop']);
const inPart = (name: string, part: CellPart) => part === 'all' || (part === 'rails') === RAIL_NAMES.has(name);

export function blockBlueprint(d: Design, label = 'City block', part: CellPart = 'all'): BlockBlueprint {
  const { pitch: P, offset: o, tiles: n } = d.spec;
  const k = Math.floor(n / 2);
  const corner = k * P + o; // grid corner of the middle block (same on both axes)
  // Reach of the junction before the corner; keep the cell origin even so rails keep their parity.
  let S = d.spec.junctions ? d.junctionReach : d.spec.trackSpacing / 2 + 2;
  if ((corner - S) % 2 !== 0) S++;
  const ox = corner - S;
  const inCell = (x: number, y: number) => x >= ox && x < ox + P && y >= ox && y < ox + P;

  const out: BlueprintEntityLike[] = [];
  // Each entity goes to the cell holding its position, so every cell is the same.
  const all: BlueprintEntityLike[] = [
    ...d.pieces.map(railEntity),
    ...d.signals.map(signalEntity),
    ...d.stops.map((s) => trainStopEntity(s, s.dir)),
    ...d.nodes.map((nd) => ({ name: nd.name, position: { x: nd.x, y: nd.y } })),
  ];
  for (const e of all) if (inCell(e.position.x, e.position.y) && inPart(e.name, part)) out.push(e);

  const rel = ((ox % P) + P) % P;
  const bp = makeBlueprint(
    out.map((e) => ({ ...e, position: { x: e.position.x - ox, y: e.position.y - ox } })),
    {
      label,
      icons: part === 'power'
        ? [{ signal: { name: 'substation' }, index: 1 }, { signal: { name: 'roboport' }, index: 2 }]
        : part === 'rails'
          ? [{ signal: { name: 'rail' }, index: 1 }, { signal: { name: 'rail-signal' }, index: 2 }]
          : [{ signal: { name: 'rail' }, index: 1 }, { signal: { name: 'substation' }, index: 2 }],
      snapToGrid: { x: P, y: P },
      absoluteSnapping: true,
      positionRelativeToGrid: { x: rel, y: rel },
    },
  );
  const entities = (bp.entities ?? []) as BlockBlueprint['entities'];
  return { entities, origin: { x: ox, y: ox }, json: { blueprint: bp }, string: encodeBlueprintString(bp) };
}

/**
 * A blueprint book with the whole cell, then the rails and signals alone, then the
 * substations and roboports alone. All three snap to the same absolute grid, so the
 * parts can be pasted at different times and still line up.
 */
export function blockBook(d: Design, label = 'City block'): string {
  const parts: [CellPart, string][] = [['all', label], ['rails', `${label}: rails`], ['power', `${label}: power and robots`]];
  const blueprints = parts
    .map(([part, name]) => blockBlueprint(d, name, part).json.blueprint)
    .filter((bp) => bp.entities?.length)
    .map((bp, index) => ({ index, blueprint: bp }));
  return encodeJsonString({
    blueprint_book: {
      item: 'blueprint-book',
      label,
      icons: [{ signal: { name: 'rail' }, index: 1 }],
      blueprints,
      active_index: 0,
      version: blueprints[0]?.blueprint.version,
    },
  });
}
