// Turn a city-block design into a layout for the editor, at world coordinates:
// grid lines stay at k * pitch + offset, so what you build in the editor lines
// up with the absolute-snapping cell blueprints in the game.

import { gameData } from '../data';
import { signalEntity, trainStopEntity } from '../rails/blueprint';
import { newId, type Direction, type Layout, type PlacedEntity } from '../editor/model';
import { railFromPiece } from '../editor/rails';
import type { Design } from './block';

export function designToLayout(d: Design): Layout {
  const entities: PlacedEntity[] = [];
  for (const s of d.signals) {
    const e = signalEntity(s);
    const facing = e.direction ?? 0;
    const pe: PlacedEntity = { id: newId(), name: e.name, x: Math.floor(e.position.x), y: Math.floor(e.position.y), direction: (Math.floor(facing / 4) % 4) as Direction };
    if (facing % 4 === 2) pe.diagonal = true;
    entities.push(pe);
  }
  for (const st of d.stops) {
    const e = trainStopEntity(st, st.dir);
    entities.push({ id: newId(), name: 'train-stop', x: e.position.x - 1, y: e.position.y - 1, direction: (st.dir / 4) as Direction });
  }
  for (const n of d.nodes) {
    const def = gameData.entities[n.name];
    if (!def) continue;
    entities.push({ id: newId(), name: n.name, x: Math.round(n.x - def.width / 2), y: Math.round(n.y - def.height / 2), direction: 0 });
  }
  return {
    version: 1,
    entities,
    water: [],
    rails: d.pieces.map((p) => railFromPiece(p, newId())),
    blockGrid: { pitch: d.spec.pitch, offset: d.spec.offset, corridor: d.spec.corridor },
  };
}
