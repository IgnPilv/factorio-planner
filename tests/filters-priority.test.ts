// Splitter priorities and filters, and filter inserters, in the steady-state model.
import { describe, expect, it } from 'vitest';
import { gameData as data } from '../src/data';
import { simulateLayout, type PlacedEntity } from '../src/calc';

type Dir = 0 | 1 | 2 | 3;
let n = 0;
const e = (name: string, x: number, y: number, direction: Dir = 0, extra: Partial<PlacedEntity> = {}): PlacedEntity => ({
  id: extra.id ?? `${name}#${n++}`,
  name,
  x,
  y,
  direction,
  ...extra,
});
const N = 0, E = 1, S = 2;

/** A south-going belt at column x fed 2.5/s per row from supply chests on its west side. */
function feed(x: number, rows: number[], item: string): PlacedEntity[] {
  return rows.flatMap((y) => [e('transport-belt', x, y, S), e('wooden-chest', x - 2, y, N, { recipe: item }), e('fast-inserter', x - 1, y, E)]);
}

// A south-facing splitter on tiles x=1 and x=2. Facing south, x=2 is its left side.
function splitterRig(split: Partial<PlacedEntity>, items: [string, string] = ['iron-plate', 'iron-plate'], blockLeft = false) {
  const ents: PlacedEntity[] = [
    ...feed(1, [-4, -3], items[0]),
    ...feed(1, [-2, -1], items[1]),
    e('splitter', 1, 0, S, { id: 'split', ...split }),
    e('transport-belt', 1, 1, S, { id: 'right' }),
    e('transport-belt', 1, 2, S),
    e('transport-belt', 2, 1, S, { id: 'left' }),
    e('transport-belt', 2, 2, blockLeft ? N : S),
  ];
  return simulateLayout({ entities: ents }, data);
}
const items = (r: ReturnType<typeof simulateLayout>, id: string) =>
  Object.fromEntries(r.transport[id]!.items.map((f) => [f.name, Math.round(f.perSecond * 1000) / 1000]));

describe('splitter output priority', () => {
  it('sends everything to the priority side while it can take it', () => {
    const r = splitterRig({ outputPriority: 'right' });
    expect(r.transport.right!.perSecond).toBeCloseTo(10);
    expect(r.transport.left!.perSecond).toBeCloseTo(0);
    const l = splitterRig({ outputPriority: 'left' });
    expect(l.transport.left!.perSecond).toBeCloseTo(10);
    expect(l.transport.right!.perSecond).toBeCloseTo(0);
  });

  it('overflows to the other side when the priority side is blocked', () => {
    const r = splitterRig({ outputPriority: 'left' }, undefined, true);
    expect(r.transport.left!.perSecond).toBeCloseTo(0);
    expect(r.transport.right!.perSecond).toBeCloseTo(10);
  });

  it('without a priority it still splits evenly', () => {
    const r = splitterRig({});
    expect(r.transport.left!.perSecond).toBeCloseTo(5);
    expect(r.transport.right!.perSecond).toBeCloseTo(5);
  });
});

describe('splitter filter', () => {
  it('sends the filter item to the priority side and everything else to the other', () => {
    const r = splitterRig({ outputPriority: 'left', filters: ['copper-plate'] }, ['iron-plate', 'copper-plate']);
    expect(items(r, 'left')).toEqual({ 'copper-plate': 5 });
    expect(items(r, 'right')).toEqual({ 'iron-plate': 5 });
  });

  it('holds the filter item back rather than overflowing when its side is blocked', () => {
    const r = splitterRig({ outputPriority: 'left', filters: ['copper-plate'] }, ['iron-plate', 'copper-plate'], true);
    expect(items(r, 'left')).toEqual({});
    expect(items(r, 'right')).toEqual({ 'iron-plate': 5 });
  });
});

describe('splitter input priority', () => {
  // Two input belts of 10/s each into a south-facing splitter; only one output
  // is open, so 15/s gets through.
  const rig = (inputPriority?: 'left' | 'right') => {
    const ents: PlacedEntity[] = [
      ...feed(1, [-4, -3, -2, -1], 'iron-plate').map((p) => (p.name === 'transport-belt' && p.y === -1 ? { ...p, id: 'inRight' } : p)),
      ...feed(4, [-8, -7, -6, -5], 'iron-plate'),
      // Bring the second line across to x=2, entering the splitter's left tile.
      e('transport-belt', 4, -4, S),
      e('transport-belt', 4, -3, S),
      e('transport-belt', 4, -2, W),
      e('transport-belt', 3, -2, W),
      e('transport-belt', 2, -2, S),
      e('transport-belt', 2, -1, S, { id: 'inLeft' }),
      e('splitter', 1, 0, S, { id: 'split', inputPriority }),
      e('transport-belt', 1, 1, S, { id: 'out' }),
      e('transport-belt', 1, 2, S),
      e('transport-belt', 2, 1, N),
    ];
    return simulateLayout({ entities: ents }, data);
  };
  const W = 3 as Dir;

  it('draws evenly by default', () => {
    const r = rig();
    expect(r.transport.out!.perSecond).toBeCloseTo(15);
    expect(r.transport.inLeft!.perSecond).toBeCloseTo(7.5);
    expect(r.transport.inRight!.perSecond).toBeCloseTo(7.5);
  });

  it('empties the priority input first', () => {
    const r = rig('right');
    expect(r.transport.out!.perSecond).toBeCloseTo(15);
    expect(r.transport.inRight!.perSecond).toBeCloseTo(10);
    expect(r.transport.inLeft!.perSecond).toBeCloseTo(5);
    const l = rig('left');
    expect(l.transport.inLeft!.perSecond).toBeCloseTo(10);
    expect(l.transport.inRight!.perSecond).toBeCloseTo(5);
  });
});

describe('filter inserters', () => {
  // Iron and copper on one belt, a fast inserter takes from it into a chest.
  const rig = (extra: Partial<PlacedEntity>) => {
    const ents: PlacedEntity[] = [
      ...feed(1, [0], 'iron-plate'),
      ...feed(1, [1], 'copper-plate'),
      e('transport-belt', 1, 2, S),
      // Dead end: items only leave through the inserter.
      e('transport-belt', 1, 3, N),
      e('fast-inserter', 2, 2, E, { id: 'pick', ...extra }),
      e('wooden-chest', 3, 2, N, { id: 'box' }),
    ];
    return simulateLayout({ entities: ents }, data);
  };

  it('an allow list only moves the listed items', () => {
    const r = rig({ filters: ['copper-plate'] });
    expect(Object.keys(items(r, 'pick'))).toEqual(['copper-plate']);
    expect(r.outputs.find((f) => f.name === 'iron-plate')).toBeUndefined();
  });

  it('a deny list moves everything else', () => {
    const r = rig({ filters: ['copper-plate'], filterMode: 'blacklist' });
    expect(Object.keys(items(r, 'pick'))).toEqual(['iron-plate']);
  });

  it('no filter moves both', () => {
    const r = rig({});
    expect(Object.keys(items(r, 'pick')).sort()).toEqual(['copper-plate', 'iron-plate']);
  });
});
