// Export one city block as a game blueprint that tiles with absolute grid snapping.
//
// The tiled design is cut into identical cells of pitch x pitch tiles. A cell
// starts `S` tiles before its block's grid corner, so it holds the junction at
// that corner, half the corridor tracks on the top and left, and the block's
// buildings. Pasting the same blueprint into every grid cell rebuilds the network.

import { makeBlueprint, encodeBlueprintString, type Blueprint } from '../blueprint/format';
import { railEntity, signalEntity, trainStopEntity, type BlueprintEntityLike } from '../rails/blueprint';
import type { Design } from './block';

export interface BlockBlueprint {
  entities: (BlueprintEntityLike & { entity_number: number })[];
  /** World position of the cell's top-left corner. */
  origin: { x: number; y: number };
  json: { blueprint: Blueprint };
  string: string;
}

export function blockBlueprint(d: Design, label = 'City block'): BlockBlueprint {
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
  for (const e of all) if (inCell(e.position.x, e.position.y)) out.push(e);

  const rel = ((ox % P) + P) % P;
  const bp = makeBlueprint(
    out.map((e) => ({ ...e, position: { x: e.position.x - ox, y: e.position.y - ox } })),
    {
      label,
      icons: [
        { signal: { name: 'rail' }, index: 1 },
        { signal: { name: 'substation' }, index: 2 },
      ],
      snapToGrid: { x: P, y: P },
      absoluteSnapping: true,
      positionRelativeToGrid: { x: rel, y: rel },
    },
  );
  const entities = (bp.entities ?? []) as BlockBlueprint['entities'];
  return { entities, origin: { x: ox, y: ox }, json: { blueprint: bp }, string: encodeBlueprintString(bp) };
}
