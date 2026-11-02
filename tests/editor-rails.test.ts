import { describe, expect, it } from 'vitest';
import { checkRails, endOnGrid } from '../src/rails/geometry';
import { freeEnds, planRail, railFromPiece, railPiece, railStartAt, railValid, signalDirectionAt, trainStopAt, type PlacedRail } from '../src/editor/rails';
import { canPlace, copyToClipboard, emptyLayout, layoutOccupancy, parseLayout, pasteClipboard, rotateClipboard, rotateGroup, type Clipboard, type Layout } from '../src/editor/model';
import { blueprintToClipboard, layoutToBlueprint } from '../src/blueprint/layout';
import { decodeBlueprintString, encodeBlueprintString } from '../src/blueprint/format';

// The loop from the game's tips-and-tricks blueprints (see tests/rail-blueprint.test.ts).
const LOOP: [PlacedRail['name'], number, number, number][] = [
  ['curved-rail-a', 12, 38, 139], ['curved-rail-a', 6, 64, 139], ['curved-rail-b', 12, 33, 141], ['curved-rail-b', 6, 69, 141],
  ['curved-rail-b', 2, 29, 145], ['curved-rail-b', 0, 73, 145], ['curved-rail-a', 2, 27, 150], ['curved-rail-a', 0, 75, 150],
  ['curved-rail-a', 8, 27, 154], ['curved-rail-a', 10, 75, 154], ['curved-rail-b', 8, 29, 159], ['curved-rail-b', 10, 73, 159],
  ['curved-rail-b', 14, 33, 163], ['curved-rail-b', 4, 69, 163], ['curved-rail-a', 14, 38, 165], ['curved-rail-a', 4, 64, 165],
  ...Array.from({ length: 11 }, (_, i) => ['straight-rail', 4, 41 + 2 * i, 139] as [PlacedRail['name'], number, number, number]),
  ...Array.from({ length: 11 }, (_, i) => ['straight-rail', 4, 41 + 2 * i, 165] as [PlacedRail['name'], number, number, number]),
];
const loopRails = (): PlacedRail[] => LOOP.map(([name, direction, x, y], i) => ({ id: `r${i}`, name, direction, x, y }));

const closed = (rails: readonly Omit<PlacedRail, 'id'>[]) => {
  const pieces = rails.map((r, i) => railPiece({ ...r, id: `p${i}` }));
  return pieces.every((p) => endOnGrid(p.a) && endOnGrid(p.b)) && checkRails(pieces).deadEnds.length === 0;
};
const key = (r: Omit<PlacedRail, 'id'>) => `${r.name}|${r.x}|${r.y}|${r.direction}`;

describe('rails in the layout editor', () => {
  it('the game loop is valid and has no free ends', () => {
    const rails = loopRails();
    expect(rails.every(railValid)).toBe(true);
    expect(freeEnds(rails)).toEqual([]);
  });

  it('a copied loop rotates and stays a closed loop, four turns give it back', () => {
    const clip = copyToClipboard([], loopRails())!;
    expect(clip.w % 2).toBe(0);
    expect(clip.h % 2).toBe(0);
    let c: Clipboard = clip;
    for (let i = 0; i < 4; i++) {
      c = rotateClipboard(c);
      expect(closed(c.rails!)).toBe(true);
    }
    expect(c.rails!.map(key).sort()).toEqual(clip.rails!.map(key).sort());
  });

  it('pasting keeps the loop on the rail grid wherever the cursor is', () => {
    const clip = copyToClipboard([], loopRails())!;
    for (const [cx, cy] of [[0, 0], [7, 3], [-5, 12]] as const) {
      const res = pasteClipboard(emptyLayout(), clip, cx, cy);
      expect(res.layout.rails).toHaveLength(LOOP.length);
      expect(closed(res.layout.rails!)).toBe(true);
    }
  });

  it('rotating placed rails as a group keeps them connected', () => {
    const layout: Layout = { ...emptyLayout(), rails: loopRails() };
    const next = rotateGroup(layout, layout.rails!.map((r) => r.id));
    expect(next).not.toBe(layout);
    expect(closed(next.rails!)).toBe(true);
  });

  it('buildings cannot be placed on track', () => {
    const layout: Layout = { ...emptyLayout(), rails: loopRails() };
    const occ = layoutOccupancy(layout);
    expect(canPlace(occ, new Set(), 'wooden-chest', 45, 139, 0).ok).toBe(false);
    expect(canPlace(occ, new Set(), 'wooden-chest', 45, 150, 0).ok).toBe(true);
  });

  it('saved layouts keep valid rails and drop broken ones', () => {
    const layout = parseLayout(
      JSON.stringify({
        version: 1,
        entities: [],
        water: [],
        rails: [
          { id: 'a', name: 'straight-rail', x: 1, y: 1, direction: 0 },
          { id: 'b', name: 'straight-rail', x: 2, y: 1, direction: 0 },
        ],
      }),
    );
    expect(layout.rails!.map((r) => r.id)).toEqual(['a']);
  });

  it('plans straight track and a 90° turn like the rail planner', () => {
    const straight = planRail({ x: 1, y: 0, dir: 0 }, 1, -20);
    expect(straight.every((p) => p.type === 'straight-rail')).toBe(true);
    expect(straight.at(-1)!.b).toMatchObject({ x: 1, y: -20 });
    const turn = planRail({ x: 1, y: 0, dir: 0 }, 14, -13);
    expect(turn.at(-1)!.b).toMatchObject({ x: 14, y: -13, dir: 4 });
    expect(checkRails(turn).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('new track starts from a free rail end near the cursor', () => {
    const rails = [railFromPiece(planRail({ x: 1, y: 0, dir: 0 }, 1, -2)[0]!, 'a')];
    expect(railStartAt(rails, 0, -3, 4)).toMatchObject({ x: 1, y: -2, dir: 0 });
    expect(railStartAt(rails, 20, 20, 4)).toMatchObject({ dir: 4 });
  });

  it('signals and train stops snap beside straight track', () => {
    const rails = planRail({ x: 1, y: 0, dir: 0 }, 1, -20).map((p, i) => railFromPiece(p, `r${i}`));
    // East of north-south track (x 0..2): guards northbound trains, faces south.
    expect(signalDirectionAt(rails, 2, -3, 0)).toBe(2);
    // West side: southbound trains, faces north.
    expect(signalDirectionAt(rails, -1, -4, 0)).toBe(0);
    expect(signalDirectionAt(rails, 5, -3, 0)).toBeNull();
    const stop = trainStopAt(rails, 3, -6, 0)!;
    expect(stop.direction).toBe(0);
    expect(stop.x).toBe(2);
  });

  it('blueprint export and import keep rails exactly, with even shifts', () => {
    const rails = loopRails();
    const { blueprint } = layoutToBlueprint([], { rails });
    const bp = decodeBlueprintString(encodeBlueprintString(blueprint));
    expect(bp.entities!.every((e) => e.position.x % 2 === 41 % 2 || e.name !== 'straight-rail')).toBe(true);
    const back = blueprintToClipboard(bp).clipboard!;
    expect(back.rails).toHaveLength(LOOP.length);
    expect(closed(back.rails!)).toBe(true);
    // Same shapes, same relative placement.
    const norm = (list: readonly Omit<PlacedRail, 'id'>[]) => {
      const x0 = Math.min(...list.map((r) => r.x)), y0 = Math.min(...list.map((r) => r.y));
      return list.map((r) => key({ ...r, x: r.x - x0, y: r.y - y0 })).sort();
    };
    expect(norm(back.rails!)).toEqual(norm(rails));
  });
});
