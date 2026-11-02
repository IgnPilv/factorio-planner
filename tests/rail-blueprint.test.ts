import { describe, expect, it } from 'vitest';
import { path, straightRun, TURN_90, SHAPES, buildPiece, endOnGrid } from '../src/rails/geometry';
import { pieceFromEntity, railEntity, signalEntity } from '../src/rails/blueprint';

// A loop from the game's tips-and-tricks blueprints (base/prototypes/tips-and-tricks-simulations.lua).
const LOOP: [string, number, number, number][] = [
  ['curved-rail-a', 12, 38, 139], ['curved-rail-a', 6, 64, 139], ['curved-rail-b', 12, 33, 141], ['curved-rail-b', 6, 69, 141],
  ['curved-rail-b', 2, 29, 145], ['curved-rail-b', 0, 73, 145], ['curved-rail-a', 2, 27, 150], ['curved-rail-a', 0, 75, 150],
  ['curved-rail-a', 8, 27, 154], ['curved-rail-a', 10, 75, 154], ['curved-rail-b', 8, 29, 159], ['curved-rail-b', 10, 73, 159],
  ['curved-rail-b', 14, 33, 163], ['curved-rail-b', 4, 69, 163], ['curved-rail-a', 14, 38, 165], ['curved-rail-a', 4, 64, 165],
  ...Array.from({ length: 11 }, (_, i) => ['straight-rail', 4, 41 + 2 * i, 139] as [string, number, number, number]),
  ...Array.from({ length: 11 }, (_, i) => ['straight-rail', 4, 41 + 2 * i, 165] as [string, number, number, number]),
];

describe('2.0 rail blueprint format', () => {
  it('the game\'s own loop closes with no open ends', () => {
    const pieces = LOOP.map(([name, direction, x, y], i) => pieceFromEntity({ name, direction, position: { x, y } }, `p${i}`));
    const ends = new Map<string, number>();
    for (const p of pieces) for (const e of [p.a, p.b]) {
      expect(endOnGrid(e)).toBe(true);
      const k = `${e.x},${e.y}`;
      ends.set(k, (ends.get(k) ?? 0) + 1);
    }
    expect([...ends.values()].every((n) => n === 2)).toBe(true);
  });

  it('our 180° turn produces the same entities as the game', () => {
    // East along y=139 to x=62, then a right-hand 180° turn: A B B A A B B A.
    const turn = path({ x: 62, y: 139, dir: 4 }, [...TURN_90, ...TURN_90]);
    const got = turn.map(railEntity).map((e) => [e.name, e.direction ?? 0, e.position.x, e.position.y]);
    expect(got).toEqual([
      ['curved-rail-a', 6, 64, 139], ['curved-rail-b', 6, 69, 141], ['curved-rail-b', 0, 73, 145], ['curved-rail-a', 0, 75, 150],
      ['curved-rail-a', 10, 75, 154], ['curved-rail-b', 10, 73, 159], ['curved-rail-b', 4, 69, 163], ['curved-rail-a', 4, 64, 165],
    ]);
  });

  it('every piece we can build has a blueprint form that round-trips', () => {
    const starts = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 3, y: 2 }, { x: 2, y: 3 }];
    for (const s of SHAPES) for (const st of starts) {
      const start = { ...st, dir: s.from };
      if (!endOnGrid(start)) continue;
      for (const t of [-1, 0, 1] as const) {
        const p = buildPiece(start, t);
        if (!p) continue;
        const back = pieceFromEntity(railEntity(p));
        const key = (q: typeof p) => [q.a, q.b].map((e) => `${e.x},${e.y},${e.dir}`).sort().join('|');
        expect(key(back)).toBe(key(p));
      }
    }
  });

  it('places signals like the game: right of the track, direction against travel', () => {
    // From the same blueprint: southbound joint (75,152) has a signal at (73.5,152.5) direction 0.
    expect(signalEntity({ id: 's', kind: 'rail', x: 75, y: 152, dir: 8 })).toEqual({ name: 'rail-signal', position: { x: 73.5, y: 152.5 } });
    expect(signalEntity({ id: 's', kind: 'rail', x: 27, y: 152, dir: 0 })).toEqual({ name: 'rail-signal', position: { x: 28.5, y: 151.5 }, direction: 8 });
    expect(straightRun({ x: 1, y: 0, dir: 0 }, 1).map(railEntity)).toEqual([{ name: 'straight-rail', position: { x: 1, y: -1 } }]);
  });
});
