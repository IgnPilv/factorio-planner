// Export one city block as a game blueprint that tiles with absolute grid snapping.
//
// The tiled design is cut into identical cells of pitch x pitch tiles. A cell
// starts `S` tiles before its block's grid corner, so it holds the junction at
// that corner, half the corridor tracks on the top and left, and the block's
// buildings. Pasting the same blueprint into every grid cell rebuilds the network.

import { zlibSync, strToU8 } from 'fflate';
import { railEntity, signalEntity, type BlueprintEntityLike } from '../rails/blueprint';
import type { Design } from './block';

/** Blueprint version stamp used by Factorio 2.x blueprints in the game files. */
export const BLUEPRINT_VERSION = 562949954076673;

export interface BlockBlueprint {
  entities: (BlueprintEntityLike & { entity_number: number })[];
  /** World position of the cell's top-left corner. */
  origin: { x: number; y: number };
  json: unknown;
  string: string;
}

export function encodeBlueprint(json: unknown): string {
  const bytes = zlibSync(strToU8(JSON.stringify(json)), { level: 9 });
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return '0' + btoa(bin);
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
    ...d.nodes.map((nd) => ({ name: nd.name, position: { x: nd.x, y: nd.y } })),
  ];
  for (const e of all) if (inCell(e.position.x, e.position.y)) out.push(e);

  const entities = out.map((e, i) => ({
    entity_number: i + 1,
    ...e,
    position: { x: e.position.x - ox, y: e.position.y - ox },
  }));
  const rel = ((ox % P) + P) % P;
  const json = {
    blueprint: {
      item: 'blueprint',
      label,
      icons: [
        { signal: { name: 'rail' }, index: 1 },
        { signal: { name: 'substation' }, index: 2 },
      ],
      entities,
      'snap-to-grid': { x: P, y: P },
      'absolute-snapping': true,
      'position-relative-to-grid': { x: rel, y: rel },
      version: BLUEPRINT_VERSION,
    },
  };
  return { entities, origin: { x: ox, y: ox }, json, string: encodeBlueprint(json) };
}
