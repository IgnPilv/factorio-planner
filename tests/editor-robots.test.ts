import { describe, expect, it } from 'vitest';
import { analyseRobots, nodeOf, robotOverlay } from '../src/editor/robots';
import type { PlacedEntity } from '../src/editor/model';

const rp = (id: string, x: number, y: number): PlacedEntity => ({ id, name: 'roboport', x, y, direction: 0 });

describe('roboport overlay', () => {
  it('centres a 4x4 roboport on its middle tile corner', () => {
    expect(nodeOf(rp('a', 0, 0))).toMatchObject({ x: 2, y: 2 });
  });

  it('joins roboports up to 50 tiles apart on each axis, not 51', () => {
    const r = analyseRobots([rp('a', 0, 0), rp('b', 50, 0), rp('c', 101, 0)]);
    expect(r.links.map(([a, b]) => a.id + b.id)).toEqual(['ab']);
    expect(r.networks.map((n) => n.length)).toEqual([2, 1]);
  });

  it('draws a 50x50 logistics and a 110x110 construction zone per roboport', () => {
    const o = robotOverlay(analyseRobots([rp('a', 0, 0)]));
    const sizes = o.areas!.map((a) => `${a.x1 - a.x0}x${a.y1 - a.y0}`).sort();
    expect(sizes).toEqual(['110x110', '50x50']);
    expect(o.areas!.find((a) => a.x1 - a.x0 === 50)).toMatchObject({ x0: -23, y0: -23 });
  });

  it('previews links from a roboport in hand', () => {
    const report = analyseRobots([rp('a', 0, 0)]);
    const o = robotOverlay(report, nodeOf(rp('__ghost', 40, 10)));
    expect(o.lines).toHaveLength(1);
    expect(o.areas).toHaveLength(4);
  });

  it('ignores non-roboports', () => {
    expect(analyseRobots([{ id: 'p', name: 'small-electric-pole', x: 0, y: 0, direction: 0 }]).roboports).toEqual([]);
  });
});
