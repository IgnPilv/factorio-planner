import { describe, expect, it } from 'vitest';
import {
  anchorForCursor,
  buildOccupancy,
  canPlace,
  emptyLayout,
  entityRect,
  lineTiles,
  parseLayout,
  placeEntity,
  removeEntities,
  rotateEntity,
  setWater,
  tileKey,
  type Layout,
} from '../src/editor/model';

const place = (l: Layout, name: string, x: number, y: number, direction: 0 | 1 | 2 | 3 = 0) => placeEntity(l, { name, x, y, direction });

describe('editor model', () => {
  it('places a building on its full footprint and blocks overlaps', () => {
    let l = emptyLayout();
    const a = place(l, 'assembling-machine-2', 0, 0);
    expect(a.result.ok).toBe(true);
    l = a.layout;
    const occ = buildOccupancy(l.entities);
    expect(occ.size).toBe(9);
    expect(place(l, 'transport-belt', 2, 2).result.ok).toBe(false);
    expect(place(l, 'transport-belt', 3, 2).result.ok).toBe(true);
  });

  it('swaps width and height when a non-square building is rotated', () => {
    let l = place(emptyLayout(), 'steam-engine', 0, 0).layout; // 3x5
    const id = l.entities[0].id;
    expect(entityRect(l.entities[0])).toMatchObject({ w: 3, h: 5 });
    l = rotateEntity(l, id);
    const e = l.entities[0];
    expect(e.direction).toBe(1);
    expect(entityRect(e)).toMatchObject({ w: 5, h: 3, x: -1, y: 1 }); // centre kept
  });

  it('refuses a rotation that would collide', () => {
    let l = place(emptyLayout(), 'steam-engine', 0, 0).layout;
    l = place(l, 'pipe', -1, 2).layout;
    const before = l;
    expect(rotateEntity(l, l.entities[0].id)).toBe(before);
  });

  it('centres the ghost on the cursor tile', () => {
    expect(anchorForCursor('assembling-machine-1', 0, 10, 10)).toEqual({ x: 9, y: 9 });
    expect(anchorForCursor('transport-belt', 0, 10, 10)).toEqual({ x: 10, y: 10 });
  });

  it('keeps buildings off water and needs water in front of an offshore pump', () => {
    const l = setWater(emptyLayout(), [[0, 0], [1, 0], [0, -1], [1, -1]], true);
    expect(place(l, 'transport-belt', 0, 0).result.ok).toBe(false);
    expect(place(l, 'offshore-pump', 0, 0).result.ok).toBe(false); // standing in water
    expect(place(l, 'offshore-pump', 0, 1, 2).result.ok).toBe(false); // facing away from water
    expect(place(l, 'offshore-pump', 0, 1, 0).result).toEqual({ ok: true }); // on the shore, facing north into the lake
  });

  it('does not paint water under buildings', () => {
    let l = place(emptyLayout(), 'stone-furnace', 0, 0).layout;
    l = setWater(l, [[0, 0], [5, 5]], true);
    expect(l.water).toEqual([tileKey(5, 5)]);
    l = setWater(l, [[5, 5]], false);
    expect(l.water).toEqual([]);
  });

  it('lays belt lines along the dominant drag axis', () => {
    expect(lineTiles(0, 0, 3, 1)).toEqual({ tiles: [[0, 0], [1, 0], [2, 0], [3, 0]], direction: 1 });
    expect(lineTiles(0, 0, 0, -2)).toEqual({ tiles: [[0, 0], [0, -1], [0, -2]], direction: 0 });
  });

  it('round-trips through JSON and drops unknown buildings', () => {
    let l = place(emptyLayout(), 'lab', 4, 4).layout;
    l = setWater(l, [[0, 0]], true);
    const json = JSON.stringify({ ...l, entities: [...l.entities, { id: 'x', name: 'not-a-thing', x: 0, y: 0, direction: 0 }] });
    const back = parseLayout(json);
    expect(back.entities.map((e) => e.name)).toEqual(['lab']);
    expect(back.water).toEqual(['0,0']);
    expect(removeEntities(back, [back.entities[0].id]).entities).toHaveLength(0);
  });

  it('reports why placement failed', () => {
    const l = place(emptyLayout(), 'pipe', 0, 0).layout;
    const r = canPlace(buildOccupancy(l.entities), new Set(), 'pipe', 0, 0, 0);
    expect(r).toEqual({ ok: false, reason: 'Blocked by another building' });
  });
});

describe('offshore pump snapping', () => {
  it('turns the pump to face the water next to the cursor', async () => {
    const { autoOrientOffshore } = await import('../src/editor/model');
    // water column to the east at x = 1
    const l = setWater(emptyLayout(), [[1, -1], [1, 0], [1, 1]], true);
    const r = autoOrientOffshore(buildOccupancy(l.entities), new Set(l.water), 0, 0, 0);
    expect(r?.direction).toBe(1);
    expect(r && place(l, 'offshore-pump', r.x, r.y, r.direction).result.ok).toBe(true);
  });
});

describe('machine settings', () => {
  it('lists recipes, resources and allowed modules', async () => {
    const { recipesFor, resourcesFor, modulesFor } = await import('../src/editor/MachineSettings');
    const { ENTITIES } = await import('../src/editor/catalog');
    expect(recipesFor(ENTITIES['stone-furnace']).map((r) => r.name)).toContain('iron-plate');
    expect(recipesFor(ENTITIES['assembling-machine-2']).map((r) => r.name)).toContain('electronic-circuit');
    expect(resourcesFor(ENTITIES['electric-mining-drill']).map((r) => r.name)).toContain('iron-ore');
    expect(resourcesFor(ENTITIES['pumpjack']).map((r) => r.name)).toEqual(['crude-oil']);
    // productivity modules are not allowed on a recipe without productivity (e.g. a building item)
    const mods = modulesFor(ENTITIES['assembling-machine-3'], 'assembling-machine-1').map((m) => m.name);
    expect(mods).toContain('speed-module');
    expect(mods).not.toContain('productivity-module');
  });
});

describe('copy, paste and group rotation', () => {
  it('copies relative to the bounding box and pastes centred on the cursor', async () => {
    const { copyToClipboard, pasteClipboard } = await import('../src/editor/model');
    let l = place(emptyLayout(), 'assembling-machine-1', 0, 0).layout;
    l = place(l, 'inserter', 3, 1, 1).layout;
    const clip = copyToClipboard(l.entities)!;
    expect(clip).toMatchObject({ w: 4, h: 3 });
    const pasted = pasteClipboard(l, clip, 11, 11);
    expect(pasted.blocked).toBe(0);
    expect(pasted.layout.entities).toHaveLength(4);
    const again = pasteClipboard(pasted.layout, clip, 11, 11);
    expect(again.blocked).toBe(2);
  });

  it('rotates a clipboard: a 3x5 engine becomes 5x3 and positions turn clockwise', async () => {
    const { copyToClipboard, rotateClipboard } = await import('../src/editor/model');
    let l = place(emptyLayout(), 'steam-engine', 0, 0).layout; // 3x5
    l = place(l, 'pipe', 3, 0).layout; // to the right of the engine's top
    const r = rotateClipboard(copyToClipboard(l.entities)!);
    expect(r).toMatchObject({ w: 5, h: 4 });
    const engine = r.entities.find((e) => e.name === 'steam-engine')!;
    const pipe = r.entities.find((e) => e.name === 'pipe')!;
    expect(engine).toMatchObject({ x: 0, y: 0, direction: 1 });
    expect(pipe).toMatchObject({ x: 4, y: 3 }); // top-right goes to bottom-right
  });

  it('rotates a selection in place and refuses when blocked', async () => {
    const { rotateGroup } = await import('../src/editor/model');
    let l = place(emptyLayout(), 'transport-belt', 0, 0).layout;
    l = place(l, 'transport-belt', 1, 0).layout;
    l = place(l, 'transport-belt', 2, 0).layout;
    const ids = l.entities.map((e) => e.id);
    const r = rotateGroup(l, ids);
    expect(r.entities.map((e) => [e.x, e.y, e.direction])).toEqual([[1, -1, 1], [1, 0, 1], [1, 1, 1]]);
    const blocked = place(l, 'pipe', 1, 1).layout;
    expect(rotateGroup(blocked, ids)).toBe(blocked);
  });
});
