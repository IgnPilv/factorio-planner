import { describe, expect, it } from 'vitest';
import {
  SHAPES, buildPiece, checkRails, endOnGrid, path, straightRun, TURN_90, LENGTH, RADIUS, trainLength, mod16,
} from '../src/rails/geometry';

describe('2.0 rail shapes', () => {
  it('a 90° turn from curve pieces moves exactly radius 13 on both axes', () => {
    const turn = path({ x: 1, y: 0, dir: 0 }, TURN_90);
    expect(turn.map((p) => p.type)).toEqual(['curved-rail-a', 'curved-rail-b', 'curved-rail-b', 'curved-rail-a']);
    const end = turn[3].b;
    expect([end.x - 1, end.y, end.dir]).toEqual([RADIUS, -RADIUS, 4]);
  });

  it('every piece built from an on-grid end lands on the grid', () => {
    const starts = [
      { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 3, y: 2 }, { x: 2, y: 3 },
    ];
    let checked = 0;
    for (const s of SHAPES) {
      for (const st of starts) {
        const start = { ...st, dir: s.from };
        if (!endOnGrid(start)) continue;
        for (const turn of [-1, 0, 1] as const) {
          const p = buildPiece(start, turn);
          if (!p) continue;
          expect(endOnGrid(p.b)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('has left, straight and right options from every heading', () => {
    for (let d = 0; d < 16; d++) {
      const st = d % 4 === 0 ? (d % 8 === 0 ? { x: 1, y: 0 } : { x: 0, y: 1 }) : d % 2 === 0 ? { x: 1, y: 1 } : [1, 7, 9, 15].includes(d) ? { x: 0, y: 1 } : { x: 1, y: 0 };
      for (const t of [-1, 0, 1] as const) expect(buildPiece({ ...st, dir: d }, t), `dir ${d} turn ${t}`).toBeDefined();
    }
  });

  it('eight A and eight B curves make a full radius-13 circle', () => {
    expect(8 * LENGTH['curved-rail-a'] + 8 * LENGTH['curved-rail-b']).toBeCloseTo(2 * Math.PI * 13, 6);
    const loop = path({ x: 1, y: 0, dir: 0 }, Array(16).fill(1));
    expect(loop[15].b).toEqual({ x: 1, y: 0, dir: 0 });
  });

  it('a closed loop has no dead ends; an open line has two', () => {
    const loop = [
      ...path({ x: 1, y: 0, dir: 0 }, [...TURN_90, 0, 0, ...TURN_90, 0, 0, ...TURN_90, 0, 0, ...TURN_90, 0, 0]),
    ];
    const last = loop[loop.length - 1].b;
    expect([last.x, last.y, mod16(last.dir)]).toEqual([1, 0, 0]);
    expect(checkRails(loop).deadEnds).toHaveLength(0);
    expect(checkRails(straightRun({ x: 1, y: 0, dir: 0 }, 5)).deadEnds).toHaveLength(2);
  });

  it('flags rails off the 2x2 grid', () => {
    const p = straightRun({ x: 2, y: 0, dir: 0 }, 1);
    expect(checkRails(p).issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('train length: 7 tiles per car, 1-4 train is 34 tiles', () => {
    expect(trainLength(5)).toBe(34);
  });
});
