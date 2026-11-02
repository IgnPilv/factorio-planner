import { describe, expect, it } from 'vitest';
import { unzlibSync, strFromU8 } from 'fflate';
import { buildDesign, DEFAULT_SPEC, gridBuildings } from '../src/cityblock/block';
import { blockBlueprint } from '../src/cityblock/export';
import { pieceFromEntity } from '../src/rails/blueprint';
import { checkRails } from '../src/rails/geometry';

const spec = (() => {
  const s = { ...DEFAULT_SPEC, pitch: 102, corridor: 12 };
  return { ...s, buildings: gridBuildings(s, 5, 2) };
})();

const key = (e: { name: string; position: { x: number; y: number }; direction?: number }) =>
  `${e.name}@${e.position.x},${e.position.y}/${e.direction ?? 0}`;

describe('city block blueprint', () => {
  it('encodes a decodable 2.0 blueprint with snap-to-grid', () => {
    const bp = blockBlueprint(buildDesign(spec));
    const json = JSON.parse(strFromU8(unzlibSync(Uint8Array.from(atob(bp.string.slice(1)), (c) => c.charCodeAt(0)))));
    expect(json.blueprint['snap-to-grid']).toEqual({ x: 102, y: 102 });
    expect(json.blueprint['absolute-snapping']).toBe(true);
    const names = new Set(json.blueprint.entities.map((e: { name: string }) => e.name));
    for (const n of ['straight-rail', 'curved-rail-a', 'curved-rail-b', 'rail-signal', 'rail-chain-signal', 'substation', 'roboport'])
      expect(names.has(n), n).toBe(true);
    for (const e of json.blueprint.entities) {
      expect(e.position.x).toBeGreaterThanOrEqual(0);
      expect(e.position.x).toBeLessThan(102);
    }
  });

  it('is the same cell whichever block it is cut from, so it tiles', () => {
    const a = blockBlueprint(buildDesign({ ...spec, tiles: 3 })).entities.map(key).sort();
    const b = blockBlueprint(buildDesign({ ...spec, tiles: 5 })).entities.map(key).sort();
    expect(b).toEqual(a);
  });

  it('pasting the cell 3x3 gives rails with no dead ends inside', () => {
    const bp = blockBlueprint(buildDesign(spec));
    const pieces = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      for (const e of bp.entities)
        if (e.name.includes('rail') && !e.name.includes('signal'))
          pieces.push(pieceFromEntity({ ...e, position: { x: e.position.x + i * 102, y: e.position.y + j * 102 } }));
    const dead = checkRails(pieces).deadEnds.filter((e) => e.x > 30 && e.x < 276 && e.y > 30 && e.y < 276);
    expect(dead).toEqual([]);
  });
});
