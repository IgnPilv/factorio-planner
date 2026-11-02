// Steady-state layout rates against in-game reference figures, using the real
// extracted data (data/nauvis.json).
import { describe, expect, it } from 'vitest';
import { gameData as data } from '../src/data';
import {
  allResearched,
  inserterCapacity,
  inserterThroughput,
  inserterTicksPerTurn,
  researchBonuses,
  simulateLayout,
  type Flow,
  type PlacedEntity,
} from '../src/calc';

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
const flow = (flows: Flow[], name: string) => flows.find((f) => f.name === name)?.perSecond ?? 0;
const N = 0, E = 1, S = 2;

describe('inserter throughput (wiki chest-to-chest figures)', () => {
  const t = (name: string, research = {}) => inserterThroughput(data.entities[name]!, researchBonuses(data, research));
  it('2.0 turn times: burner 76, inserter 70, long-handed 48, fast and bulk 24 ticks', () => {
    expect(inserterTicksPerTurn(data.entities['burner-inserter']!)).toBe(76);
    expect(inserterTicksPerTurn(data.entities['inserter']!)).toBe(70);
    expect(inserterTicksPerTurn(data.entities['long-handed-inserter']!)).toBe(48);
    expect(inserterTicksPerTurn(data.entities['fast-inserter']!)).toBe(24);
    expect(inserterTicksPerTurn(data.entities['bulk-inserter']!)).toBe(24);
  });
  it('burner 0.79/s, inserter 0.86/s, long-handed 1.25/s, fast 2.5/s', () => {
    expect(t('burner-inserter')).toBeCloseTo(60 / 76, 3);
    expect(t('inserter')).toBeCloseTo(60 / 70, 3);
    expect(t('long-handed-inserter')).toBeCloseTo(1.25, 3);
    expect(t('fast-inserter')).toBeCloseTo(2.5, 3);
  });
  it('bulk inserter hand grows with capacity research', () => {
    // All capacity research: bulk hand 1 + 1 (bulk-inserter) + 1+1+1+1+2+2+2 = 12.
    expect(t('bulk-inserter', allResearched(data))).toBeCloseTo(12 * 2.5, 2);
    // Ordinary inserters get +2 from capacity bonus 2 and 7.
    expect(t('fast-inserter', allResearched(data))).toBeCloseTo(3 * 2.5, 2);
  });
});

describe('inserters and belts (wiki measurements)', () => {
  const ent = (n: string) => data.entities[n]!;
  const bonus = (research = {}) => researchBonuses(data, research);
  it('dropping on a belt uses the 2.0 chest-to-belt figures', () => {
    expect(inserterCapacity(ent('fast-inserter'), bonus(), { e: ent('wooden-chest') }, { e: ent('transport-belt') })).toBeCloseTo(2.5);
    // Bulk inserter, all capacity research (hand 12): 6.93 on yellow, 14.4 on blue.
    const all = bonus(allResearched(data));
    expect(inserterCapacity(ent('bulk-inserter'), all, { e: ent('wooden-chest') }, { e: ent('transport-belt') })).toBeCloseTo(6.93);
    expect(inserterCapacity(ent('bulk-inserter'), all, { e: ent('wooden-chest') }, { e: ent('express-transport-belt') })).toBeCloseTo(14.4);
  });
  it('taking from a belt scales the 1.1 measurements to 2.0 arm speed (derived)', () => {
    const c = inserterCapacity(ent('inserter'), bonus(), { e: ent('transport-belt') }, { e: ent('wooden-chest') });
    expect(c).toBeCloseTo((0.94 * 60) / 70 / 0.83, 3);
    // Bulk inserter with hand 12 on a yellow belt is held to about one lane's worth.
    const b = inserterCapacity(ent('bulk-inserter'), bonus(allResearched(data)), { e: ent('transport-belt') }, { e: ent('wooden-chest') });
    expect(b).toBeCloseTo((7.5 * 2.5) / 2.31, 2);
  });
  it('chest to chest is untouched', () => {
    expect(inserterCapacity(ent('fast-inserter'), bonus(), { e: ent('wooden-chest') }, { e: ent('assembling-machine-2') })).toBeCloseTo(2.5);
  });
});

describe('simulateLayout', () => {
  it('a drill on a belt: 0.5 ore/s leaves the open belt end', () => {
    const drill = e('electric-mining-drill', 0, 0, S, { recipe: 'iron-ore', id: 'drill' });
    const belts = [3, 4, 5].map((y) => e('transport-belt', 1, y, S, { id: `b${y}` }));
    const r = simulateLayout({ entities: [drill, ...belts] }, data);
    expect(r.ok).toBe(true);
    expect(r.entities.drill!.status).toBe('working');
    expect(flow(r.outputs, 'iron-ore')).toBeCloseTo(0.5);
    expect(r.transport.b5!.perSecond).toBeCloseTo(0.5);
    expect(r.transport.b5!.utilization).toBeCloseTo(0.5 / 15);
    expect(r.power.modelled).toBe(false);
  });

  it('caps a yellow belt at 15 items/s', () => {
    const ents: PlacedEntity[] = [];
    for (let x = 0; x < 12; x++) {
      ents.push(e('transport-belt', x, 0, E, { id: `belt${x}` }));
      ents.push(e('wooden-chest', x, -2, N, { recipe: 'iron-plate' }));
      ents.push(e('fast-inserter', x, -1, S));
    }
    const r = simulateLayout({ entities: ents }, data);
    expect(flow(r.outputs, 'iron-plate')).toBeCloseTo(15);
    expect(r.transport.belt11!.utilization).toBeCloseTo(1);
  });

  it('side-loading fills only one lane (7.5/s on yellow)', () => {
    const ents: PlacedEntity[] = [];
    // A side belt running south into a west-east main belt, fed by 8 fast inserters (18.5/s offered).
    for (let y = -8; y < 0; y++) {
      ents.push(e('transport-belt', 5, y, S));
      ents.push(e('wooden-chest', 3, y, N, { recipe: 'copper-plate' }));
      ents.push(e('fast-inserter', 4, y, E));
    }
    // The main belt starts one tile earlier, so the join is a side-load, not a curve.
    for (let x = 4; x < 10; x++) ents.push(e('transport-belt', x, 0, E));
    const r = simulateLayout({ entities: ents }, data);
    expect(flow(r.outputs, 'copper-plate')).toBeCloseTo(7.5);
  });

  it('a belt turning a corner keeps both lanes (15/s)', () => {
    const ents: PlacedEntity[] = [];
    for (let y = -10; y < 0; y++) {
      ents.push(e('transport-belt', 5, y, S));
      ents.push(e('wooden-chest', 3, y, N, { recipe: 'copper-plate' }));
      ents.push(e('fast-inserter', 4, y, E));
    }
    for (let x = 5; x < 10; x++) ents.push(e('transport-belt', x, 0, E));
    const r = simulateLayout({ entities: ents }, data);
    expect(flow(r.outputs, 'copper-plate')).toBeCloseTo(15);
  });

  it('an assembler fed by one basic inserter is starved to 0.86/3 of full speed', () => {
    const ents = [
      e('wooden-chest', 0, 1, N, { recipe: 'iron-plate' }),
      e('inserter', 1, 1, E),
      e('assembling-machine-2', 2, 0, N, { recipe: 'iron-gear-wheel', id: 'asm' }),
      e('inserter', 5, 1, E),
      e('wooden-chest', 6, 1, N),
    ];
    const r = simulateLayout({ entities: ents }, data);
    const asm = r.entities.asm!;
    expect(asm.status).toBe('starved');
    expect(asm.activity).toBeCloseTo(60 / 70 / 3, 3);
    expect(flow(r.outputs, 'iron-gear-wheel')).toBeCloseTo(60 / 70 / 2, 3);
  });

  it('an assembler with no way out is output-blocked', () => {
    const ents = [
      e('wooden-chest', 0, 1, N, { recipe: 'iron-plate' }),
      e('fast-inserter', 1, 1, E),
      e('assembling-machine-2', 2, 0, N, { recipe: 'iron-gear-wheel', id: 'asm' }),
    ];
    const r = simulateLayout({ entities: ents }, data);
    expect(r.entities.asm!.status).toBe('output-blocked');
    expect(r.entities.asm!.activity).toBe(0);
  });

  it('reports missing inputs and machines without a recipe', () => {
    const ents = [
      e('assembling-machine-2', 0, 0, N, { recipe: 'electronic-circuit', id: 'asm' }),
      e('inserter', 3, 1, E),
      e('wooden-chest', 4, 1, N),
      e('assembling-machine-2', 10, 0, N, { id: 'empty' }),
    ];
    const r = simulateLayout({ entities: ents }, data);
    expect(r.entities.asm!.status).toBe('starved');
    expect(r.entities.asm!.missing?.sort()).toEqual(['copper-cable', 'iron-plate']);
    expect(r.entities.empty!.status).toBe('no-recipe');
  });

  it('a drill feeding a stone furnace directly: the furnace sets the pace', () => {
    const ents = [
      e('electric-mining-drill', 0, 0, S, { recipe: 'iron-ore', id: 'drill' }),
      // Drill drops on (1,3): the furnace's top-left tile.
      e('stone-furnace', 1, 3, N, { recipe: 'iron-plate', id: 'furnace' }),
      e('wooden-chest', 4, 3, N, { recipe: 'coal' }),
      e('burner-inserter', 3, 3, 3),
      e('inserter', 1, 5, S),
      e('wooden-chest', 1, 6, N),
    ];
    const r = simulateLayout({ entities: ents }, data);
    expect(r.entities.furnace!.status).toBe('working');
    expect(flow(r.outputs, 'iron-plate')).toBeCloseTo(1 / 3.2);
    expect(r.entities.drill!.status).toBe('output-blocked');
    expect(r.entities.drill!.activity).toBeCloseTo(0.3125 / 0.5);
    // 90 kW of coal at 4 MJ.
    expect(flow(r.inputs, 'coal')).toBeCloseTo(90e3 / 4e6);
  });

  it('carries items through underground belts and splits them evenly enough', () => {
    const ents = [
      e('electric-mining-drill', 0, 0, S, { recipe: 'copper-ore' }),
      e('transport-belt', 1, 3, S),
      e('underground-belt', 1, 4, S, { id: 'in' }),
      e('underground-belt', 1, 9, S, { id: 'out' }),
      e('transport-belt', 1, 10, S),
      e('splitter', 1, 11, S, { id: 'split' }),
      e('transport-belt', 1, 12, S),
      e('transport-belt', 2, 12, S),
    ];
    const r = simulateLayout({ entities: ents }, data);
    expect(r.transport.in!.perSecond).toBeCloseTo(0.5);
    expect(r.transport.split!.perSecond).toBeCloseTo(0.5);
    expect(flow(r.outputs, 'copper-ore')).toBeCloseTo(0.5);
  });

  it('runs a steam plant only as hard as demand needs', () => {
    // Water: offshore pump facing a lake to the north, boiler, steam engine in a row.
    const ents = [
      e('offshore-pump', 0, 0, N, { id: 'pump' }),
      e('pipe', 0, 1),
      e('boiler', 0, 2, S, { id: 'boiler' }), // 3x2 rotated south stays 3x2
      e('wooden-chest', 4, 2, N, { recipe: 'coal' }),
      e('inserter', 3, 2, 3),
      e('steam-engine', 0, 4, N, { id: 'engine' }),
      e('small-electric-pole', 3, 5),
      e('small-electric-pole', 8, 3),
      ...Array.from({ length: 2 }, (_, i) => e('assembling-machine-2', 6 + i * 3, 4, N, { recipe: 'iron-gear-wheel', id: `asm${i}` })),
      e('wooden-chest', 20, 0, N, { recipe: 'iron-plate' }),
    ];
    // Feed both assemblers generously from supply chests and empty them into chests.
    for (let i = 0; i < 2; i++) {
      const x = 6 + i * 3;
      ents.push(e('wooden-chest', x, 2, N, { recipe: 'iron-plate' }), e('bulk-inserter', x, 3, S), e('wooden-chest', x + 1, 2, N, { recipe: 'iron-plate' }), e('bulk-inserter', x + 1, 3, S));
      ents.push(e('fast-inserter', x + 1, 7, S), e('wooden-chest', x + 1, 8, N));
    }
    const r = simulateLayout({ entities: ents, water: ['0,-1'] }, data, allResearched(data));
    expect(r.ok).toBe(true);
    expect(r.power.modelled).toBe(true);
    for (const id of ['asm0', 'asm1']) expect(r.entities[id]!.status).toBe('working');
    const demand = 2 * 155e3;
    expect(r.power.demandW).toBeCloseTo(demand, -2);
    expect(r.entities.engine!.activity).toBeCloseTo(demand / 900e3, 3);
    expect(r.entities.boiler!.activity).toBeCloseTo(demand / 1.8e6, 3);
    expect(r.entities.pump!.activity).toBeCloseTo((demand / 900e3) * 30 / 10 / 1200, 5);
  });

  it('splitters split evenly, and send everything one way when the other side is blocked', () => {
    const build = (blockRight: boolean) => {
      const ents: PlacedEntity[] = [];
      // 4 fast inserters from supply chests: 10/s into the belt.
      for (let y = -4; y < 0; y++) {
        ents.push(e('transport-belt', 1, y, S), e('wooden-chest', -1, y, N, { recipe: 'iron-plate' }), e('fast-inserter', 0, y, E));
      }
      ents.push(e('splitter', 1, 0, S, { id: 'split' }));
      ents.push(e('transport-belt', 1, 1, S, { id: 'left' }), e('transport-belt', 1, 2, S));
      ents.push(e('transport-belt', 2, 1, S, { id: 'right' }));
      // A belt pointing back up stops the right side.
      if (blockRight) ents.push(e('transport-belt', 2, 2, N));
      else ents.push(e('transport-belt', 2, 2, S));
      return simulateLayout({ entities: ents }, data);
    };
    const even = build(false);
    expect(even.transport.left!.perSecond).toBeCloseTo(5);
    expect(even.transport.right!.perSecond).toBeCloseTo(5);
    const blocked = build(true);
    expect(blocked.transport.left!.perSecond).toBeCloseTo(10);
    expect(blocked.transport.right!.perSecond).toBeCloseTo(0);
  });

  it('pumps move fluid one way between pipelines', () => {
    const build = (pumpDir: Dir) =>
      simulateLayout(
        {
          entities: [
            e('offshore-pump', 0, 0, N),
            e('pipe', 0, 1),
            // 1x2 pump between two pipes; its arrow is the flow direction.
            e('pump', 0, 2, pumpDir, { id: 'pump' }),
            e('pipe', 0, 4),
            e('boiler', 0, 5, S, { id: 'boiler' }),
            e('wooden-chest', 4, 5, N, { recipe: 'coal' }),
            e('inserter', 3, 5, 3),
            e('steam-engine', 0, 7, N),
            e('wooden-chest', 10, 1, N, { recipe: 'iron-plate' }),
            e('fast-inserter', 11, 1, E),
            e('assembling-machine-1', 12, 0, N, { recipe: 'iron-gear-wheel', id: 'asm' }),
            e('fast-inserter', 15, 1, E),
            e('wooden-chest', 16, 1, N),
          ],
          water: ['0,-1'],
        },
        data,
      );
    expect(build(S).entities.boiler!.activity).toBeGreaterThan(0);
    expect(build(S).entities.asm!.status).toBe('working');
    const reversed = build(N);
    expect(reversed.entities.boiler!.activity).toBe(0);
    expect(reversed.entities.asm!.activity).toBe(0);
  });

  it('slows machines down when generation is short', () => {
    // One solar panel (60 kW peak, 42 kW average) for an assembler 2 drawing 155 kW.
    const ents = [
      e('solar-panel', 0, 0, N),
      e('wooden-chest', 4, 1, N, { recipe: 'iron-plate' }),
      e('fast-inserter', 5, 1, E),
      e('assembling-machine-2', 6, 0, N, { recipe: 'iron-gear-wheel', id: 'asm' }),
      e('fast-inserter', 9, 1, E),
      e('wooden-chest', 10, 1, N),
    ];
    const r = simulateLayout({ entities: ents }, data);
    expect(r.entities.asm!.status).toBe('low-power');
    expect(r.entities.asm!.activity).toBeCloseTo(42e3 / 155e3, 3);
  });

  it('machines outside every pole are unpowered', () => {
    const ents = [
      e('solar-panel', 0, 0, N),
      e('small-electric-pole', 3, 0),
      e('wooden-chest', 20, 1, N, { recipe: 'iron-plate' }),
      e('fast-inserter', 21, 1, E),
      e('assembling-machine-1', 22, 0, N, { recipe: 'iron-gear-wheel', id: 'far' }),
      e('inserter', 25, 1, E),
      e('wooden-chest', 26, 1, N),
    ];
    const r = simulateLayout({ entities: ents }, data);
    expect(r.entities.far!.status).toBe('no-power');
  });
});
