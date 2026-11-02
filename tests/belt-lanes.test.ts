// Belt lanes in the steady-state model: each belt carries two lanes of half
// the belt's throughput. Lanes are named as seen facing the way the belt moves.
import { describe, expect, it } from 'vitest';
import { gameData as data } from '../src/data';
import { simulateLayout, type Flow, type PlacedEntity } from '../src/calc';

type Dir = 0 | 1 | 2 | 3;
const N = 0, E = 1, S = 2, W = 3;
let n = 0;
const e = (name: string, x: number, y: number, direction: Dir = 0, extra: Partial<PlacedEntity> = {}): PlacedEntity => ({
  id: extra.id ?? `${name}#${n++}`,
  name,
  x,
  y,
  direction,
  ...extra,
});
const total = (fs: Flow[]) => fs.reduce((a, f) => a + f.perSecond, 0);
const names = (fs: Flow[]) => fs.filter((f) => f.perSecond > 1e-6).map((f) => f.name).sort();
const lanes = (r: ReturnType<typeof simulateLayout>, id: string) => r.transport[id]!.lanes!;

/** An east-going belt row y=0, x in [x0, x1), with fast inserters from supply chests on the north (and south) side. */
function eastLine(x0: number, x1: number, north: string | undefined, south: string | undefined): PlacedEntity[] {
  const out: PlacedEntity[] = [];
  for (let x = x0; x < x1; x++) {
    out.push(e('transport-belt', x, 0, E, { id: `m${x}` }));
    if (north) out.push(e('wooden-chest', x, -2, N, { recipe: north }), e('fast-inserter', x, -1, S));
    if (south) out.push(e('wooden-chest', x, 2, N, { recipe: south }), e('fast-inserter', x, 1, N));
  }
  return out;
}

describe('inserters and lanes', () => {
  it('an inserter drops on the far lane, so one side of inserters fills one lane (7.5/s on yellow)', () => {
    const r = simulateLayout({ entities: eastLine(0, 6, 'iron-plate', undefined) }, data);
    // North of an east-going belt is its left side, so the far lane is the right one.
    expect(total(lanes(r, 'm5').right)).toBeCloseTo(7.5);
    expect(total(lanes(r, 'm5').left)).toBeCloseTo(0);
    expect(r.transport.m5!.utilization).toBeCloseTo(1);
  });

  it('inserters on both sides fill both lanes (15/s), one item per lane', () => {
    const r = simulateLayout({ entities: eastLine(0, 6, 'iron-plate', 'copper-plate') }, data);
    expect(names(lanes(r, 'm5').right)).toEqual(['iron-plate']);
    expect(names(lanes(r, 'm5').left)).toEqual(['copper-plate']);
    expect(r.transport.m5!.perSecond).toBeCloseTo(15);
  });

  it("onto a belt running away from it, an inserter drops on the belt's right lane", () => {
    const r = simulateLayout(
      { entities: [e('wooden-chest', 0, 0, N, { recipe: 'iron-plate' }), e('fast-inserter', 1, 0, E), e('transport-belt', 2, 0, E, { id: 'b' }), e('transport-belt', 3, 0, E)] },
      data,
    );
    expect(total(lanes(r, 'b').right)).toBeGreaterThan(0);
    expect(total(lanes(r, 'b').left)).toBe(0);
  });
});

describe('belt joins', () => {
  // A south-going feeder at x=5, full on both lanes, joining an east-going belt at y=0.
  const feeder = (yTop: number): PlacedEntity[] => {
    const out: PlacedEntity[] = [];
    for (let y = yTop; y < 0; y++) {
      out.push(e('transport-belt', 5, y, S, { id: `f${y}` }));
      out.push(e('wooden-chest', 3, y, N, { recipe: 'iron-plate' }), e('fast-inserter', 4, y, E));
      out.push(e('wooden-chest', 7, y, N, { recipe: 'copper-plate' }), e('fast-inserter', 6, y, W));
    }
    return out;
  };

  it('a curve keeps each lane', () => {
    const ents = [...feeder(-8), ...[5, 6, 7, 8].map((x) => e('transport-belt', x, 0, E, { id: `m${x}` }))];
    const r = simulateLayout({ entities: ents }, data);
    // Going south, iron (dropped from the west) is on the far, east side: the left lane.
    expect(names(lanes(r, 'f-1').left)).toEqual(['iron-plate']);
    // Turning left (to the east) it stays on the left lane.
    expect(names(lanes(r, 'm8').left)).toEqual(['iron-plate']);
    expect(names(lanes(r, 'm8').right)).toEqual(['copper-plate']);
    expect(r.transport.m8!.perSecond).toBeCloseTo(15);
  });

  it('side-loading puts both feeder lanes onto the near lane of the main belt', () => {
    const ents = [...feeder(-8), ...[4, 5, 6, 7, 8].map((x) => e('transport-belt', x, 0, E, { id: `m${x}` }))];
    const r = simulateLayout({ entities: ents }, data);
    // The feeder comes from the north: the main belt's left side.
    expect(names(lanes(r, 'm8').left)).toEqual(['copper-plate', 'iron-plate']);
    expect(total(lanes(r, 'm8').left)).toBeCloseTo(7.5);
    expect(total(lanes(r, 'm8').right)).toBeCloseTo(0);
  });

  it('side-loading an underground entrance lets only the lane over its open half through', () => {
    const ents = [
      ...feeder(-8),
      e('underground-belt', 5, 0, E, { id: 'in' }),
      e('underground-belt', 8, 0, E, { id: 'out' }),
      e('transport-belt', 9, 0, E, { id: 'after' }),
    ];
    const r = simulateLayout({ entities: ents }, data);
    // The entrance's open half is its west (upstream) half. The feeder goes
    // south, so its west lane is its right lane: copper.
    expect(names(r.transport.after!.items)).toEqual(['copper-plate']);
    expect(names(lanes(r, 'after').left)).toEqual(['copper-plate']);
    expect(r.transport.after!.perSecond).toBeCloseTo(7.5);
  });

  it('splitters keep lanes', () => {
    const ents = [
      ...eastLine(0, 4, 'iron-plate', 'copper-plate'),
      e('splitter', 4, 0, E, { id: 'split' }),
      e('transport-belt', 5, 0, E, { id: 'a' }),
      e('transport-belt', 6, 0, E),
      e('transport-belt', 5, 1, E, { id: 'b' }),
      e('transport-belt', 6, 1, E),
    ];
    const r = simulateLayout({ entities: ents }, data);
    for (const id of ['a', 'b']) {
      expect(names(lanes(r, id).right)).toEqual(['iron-plate']);
      expect(names(lanes(r, id).left)).toEqual(['copper-plate']);
    }
  });
});

describe('drills and lanes', () => {
  it('a drill drops on the near lane of a belt across its front', () => {
    // Drill facing south above an east-going belt: the near side is north, the belt's left.
    const ents = [
      e('electric-mining-drill', 0, -3, S, { recipe: 'iron-ore', id: 'drill' }),
      ...[0, 1, 2, 3].map((x) => e('transport-belt', x, 0, E, { id: `m${x}` })),
    ];
    const r = simulateLayout({ entities: ents }, data);
    expect(total(lanes(r, 'm3').left)).toBeCloseTo(0.5);
    expect(total(lanes(r, 'm3').right)).toBe(0);
  });
});
