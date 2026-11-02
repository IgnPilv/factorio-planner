import { describe, expect, it } from 'vitest';
import {
  allResearched,
  availableEntities,
  availableRecipes,
  computeLayoutRates,
  ELECTRICITY,
  layoutTotals,
  machineRate,
  solveFactory,
  type Flow,
  type PlacedEntity,
} from '../src/calc';
import { miniData as data } from './fixtures/mini-data';

const flow = (flows: Flow[], name: string) => flows.find((f) => f.name === name)?.perSecond ?? 0;
const count = (r: ReturnType<typeof solveFactory>, id: string) => r.processes.find((p) => p.id === id)?.machines ?? 0;
const all = allResearched(data);

describe('machineRate', () => {
  it('assembler 2 on green circuits: 1.5/s, 155 kW', () => {
    const r = machineRate(data, { entity: 'assembling-machine-2', recipe: 'electronic-circuit' }, all);
    expect(r.craftsPerSecond).toBeCloseTo(1.5);
    expect(flow(r.outputs, 'electronic-circuit')).toBeCloseTo(1.5);
    expect(flow(r.inputs, 'copper-cable')).toBeCloseTo(4.5);
    expect(r.powerW).toBeCloseTo(155e3);
  });

  it('gives the classic 3 cable : 2 circuit assembler ratio', () => {
    const cable = machineRate(data, { entity: 'assembling-machine-2', recipe: 'copper-cable' }, all);
    const circuit = machineRate(data, { entity: 'assembling-machine-2', recipe: 'electronic-circuit' }, all);
    expect(3 * flow(cable.outputs, 'copper-cable')).toBeCloseTo(2 * flow(circuit.inputs, 'copper-cable'));
  });

  it('applies productivity modules to outputs only, and their speed and power penalties', () => {
    const r = machineRate(
      data,
      { entity: 'assembling-machine-3', recipe: 'electronic-circuit', modules: Array(4).fill('productivity-module-3') },
      all,
    );
    expect(r.speedBonus).toBeCloseTo(-0.6);
    expect(r.productivityBonus).toBeCloseTo(0.4);
    const crafts = (1.25 * 0.4) / 0.5;
    expect(flow(r.inputs, 'iron-plate')).toBeCloseTo(crafts);
    expect(flow(r.outputs, 'electronic-circuit')).toBeCloseTo(crafts * 1.4);
    expect(r.powerW).toBeCloseTo(375e3 * (1 + 3.2) + 12.5e3);
  });

  it('floors consumption at -80% (2 efficiency 3 in an assembler 2)', () => {
    const r = machineRate(
      data,
      { entity: 'assembling-machine-2', recipe: 'iron-gear-wheel', modules: ['efficiency-module-3', 'efficiency-module-3'] },
      all,
    );
    expect(r.consumptionBonus).toBeCloseTo(-0.8);
    expect(r.powerW).toBeCloseTo(150e3 * 0.2 + 5e3);
  });

  it('rejects productivity modules on recipes that disallow them', () => {
    const r = machineRate(
      data,
      { entity: 'assembling-machine-2', recipe: 'assembling-machine-1', modules: ['productivity-module'] },
      all,
    );
    expect(r.productivityBonus).toBe(0);
    expect(r.warnings.join()).toMatch(/does not allow productivity/);
  });

  it('warns about too many modules', () => {
    const r = machineRate(data, { entity: 'assembling-machine-2', recipe: 'iron-gear-wheel', modules: Array(3).fill('speed-module') }, all);
    expect(r.speedBonus).toBeCloseTo(0.4);
    expect(r.warnings.join()).toMatch(/2 module slots/);
  });

  it('uses the 2.0 beacon rule: 1.5 × √n × module effect', () => {
    const beacons = Array.from({ length: 8 }, () => ({ beacon: 'beacon', modules: ['speed-module-3', 'speed-module-3'] }));
    const r = machineRate(data, { entity: 'assembling-machine-3', recipe: 'iron-gear-wheel', beacons }, all);
    expect(r.speedBonus).toBeCloseTo(1.5 * Math.sqrt(8) * 1.0);
    expect(r.consumptionBonus).toBeCloseTo(1.5 * Math.sqrt(8) * 1.4);
    expect(r.beacons).toBe(8);
  });

  it('beacons refuse productivity modules', () => {
    const r = machineRate(
      data,
      { entity: 'assembling-machine-3', recipe: 'iron-gear-wheel', beacons: [{ beacon: 'beacon', modules: ['productivity-module-3'] }] },
      all,
    );
    expect(r.productivityBonus).toBe(0);
  });

  it('mines 0.5 ore/s with an electric drill, more with mining productivity research', () => {
    expect(flow(machineRate(data, { entity: 'electric-mining-drill', recipe: 'iron-ore' }).outputs, 'iron-ore')).toBeCloseTo(0.5);
    const researched = { 'mining-productivity-1': 1, 'mining-productivity-3': 2 };
    const r = machineRate(data, { entity: 'electric-mining-drill', recipe: 'iron-ore' }, researched);
    expect(r.productivityBonus).toBeCloseTo(0.3);
    expect(flow(r.outputs, 'iron-ore')).toBeCloseTo(0.65);
  });

  it('applies recipe productivity research', () => {
    const r = machineRate(data, { entity: 'electric-furnace', recipe: 'steel-plate' }, { 'steel-processing': 1, 'steel-plate-productivity': 3 });
    expect(r.productivityBonus).toBeCloseTo(0.3);
  });

  it('caps productivity at +300%', () => {
    const r = machineRate(data, { entity: 'electric-furnace', recipe: 'steel-plate' }, { 'steel-processing': 1, 'steel-plate-productivity': 50 });
    expect(r.productivityBonus).toBeCloseTo(3);
  });

  it('models water and steam: 1 pump : 20 boilers : 40 engines', () => {
    const pump = machineRate(data, { entity: 'offshore-pump' });
    const boiler = machineRate(data, { entity: 'boiler' });
    const engine = machineRate(data, { entity: 'steam-engine' });
    expect(flow(pump.outputs, 'water')).toBe(1200);
    expect(flow(boiler.outputs, 'steam')).toBeCloseTo(60);
    expect(boiler.fuelW).toBeCloseTo(1.8e6);
    expect(flow(engine.inputs, 'steam')).toBe(30);
    expect(engine.powerW).toBe(-900e3);
    expect(flow(pump.outputs, 'water') / flow(boiler.inputs, 'water')).toBeCloseTo(20);
    expect(flow(boiler.outputs, 'steam') / flow(engine.inputs, 'steam')).toBeCloseTo(2);
  });

  it('burner furnaces burn fuel instead of electricity', () => {
    const r = machineRate(data, { entity: 'stone-furnace', recipe: 'iron-plate' });
    expect(r.fuelW).toBeCloseTo(90e3);
    expect(r.powerW).toBe(0);
    expect(flow(r.outputs, 'iron-plate')).toBeCloseTo(1 / 3.2);
  });

  it('warns when the recipe is not researched', () => {
    const r = machineRate(data, { entity: 'electric-furnace', recipe: 'steel-plate' }, {});
    expect(r.warnings.join()).toMatch(/not researched/);
  });
});

describe('research toggles', () => {
  it('hides locked recipes and buildings on a greenfield start', () => {
    const recipes = availableRecipes(data, {}).map((r) => r.name);
    expect(recipes).toContain('iron-plate');
    expect(recipes).not.toContain('steel-plate');
    const entities = availableEntities(data, {}).map((e) => e.name);
    expect(entities).toContain('assembling-machine-1');
    expect(entities).not.toContain('assembling-machine-2');
    expect(availableEntities(data, { 'automation-2': 1 }).map((e) => e.name)).toContain('assembling-machine-2');
  });
});

describe('solveFactory', () => {
  it('plans 1 red science/s on a greenfield with assembler 1s and stone furnaces', () => {
    const r = solveFactory(data, { targets: [{ name: 'automation-science-pack', perSecond: 1 }], includePower: false });
    expect(r.ok).toBe(true);
    expect(count(r, 'recipe:automation-science-pack')).toBeCloseTo(10);
    expect(r.processes.find((p) => p.id === 'recipe:automation-science-pack')?.entity).toBe('assembling-machine-1');
    expect(count(r, 'recipe:iron-gear-wheel')).toBeCloseTo(1);
    expect(count(r, 'recipe:iron-plate')).toBeCloseTo(6.4);
    expect(count(r, 'recipe:copper-plate')).toBeCloseTo(3.2);
    expect(count(r, 'mine:iron-ore')).toBeCloseTo(4);
    expect(count(r, 'mine:copper-ore')).toBeCloseTo(2);
    // Stone furnaces burn coal: 9.6 furnaces × 90 kW / 4 MJ.
    expect(flow(r.resources, 'coal')).toBeCloseTo((9.6 * 90e3) / 4e6);
    expect(flow(r.imports, ELECTRICITY)).toBeCloseTo(r.powerDemandW);
  });

  it('uses better machines once researched', () => {
    const r = solveFactory(data, { targets: [{ name: 'automation-science-pack', perSecond: 1 }], research: all, includePower: false });
    expect(r.processes.find((p) => p.id === 'recipe:automation-science-pack')?.entity).toBe('assembling-machine-3');
    expect(count(r, 'recipe:automation-science-pack')).toBeCloseTo(4);
    expect(r.processes.find((p) => p.id === 'recipe:iron-plate')?.entity).toBe('electric-furnace');
  });

  it('honours machine, module and recipe choices', () => {
    const r = solveFactory(data, {
      targets: [{ name: 'electronic-circuit', perSecond: 3 }],
      research: all,
      machineFor: { crafting: 'assembling-machine-2' },
      modules: { 'electronic-circuit': ['productivity-module', 'productivity-module'] },
      imports: ['iron-plate', 'copper-plate'],
      includePower: false,
    });
    const circ = r.processes.find((p) => p.id === 'recipe:electronic-circuit')!;
    expect(circ.entity).toBe('assembling-machine-2');
    // 0.75 × 0.9 / 0.5 = 1.35 crafts/s, × 1.08 output.
    expect(circ.machines).toBeCloseTo(3 / (1.35 * 1.08));
    expect(flow(r.imports, 'iron-plate')).toBeCloseTo(3 / 1.08);
  });

  it('builds a steam power plant with 1 : 20 : 40 ratios and coal mining', () => {
    const r = solveFactory(data, { targets: [{ name: ELECTRICITY, perSecond: 36e6 }], research: all });
    const engines = count(r, 'generator:steam-engine');
    const boilers = count(r, 'boiler:boiler');
    const pumps = count(r, 'pump:water');
    expect(engines).toBeGreaterThan(40); // coal drills need power too
    expect(boilers * 2).toBeCloseTo(engines);
    expect(pumps * 20).toBeCloseTo(boilers);
    expect(flow(r.resources, 'coal')).toBeCloseTo(boilers * 0.45);
  });

  it('adds power to the plan when asked', () => {
    const r = solveFactory(data, { targets: [{ name: 'iron-gear-wheel', perSecond: 1 }], research: all });
    expect(r.imports).toHaveLength(0);
    expect(count(r, 'generator:steam-engine')).toBeCloseTo(r.powerDemandW / 900e3);
  });

  it('balances oil with cracking and leaves no surplus', () => {
    const r = solveFactory(data, {
      targets: [{ name: 'petroleum-gas', perSecond: 100 }],
      research: all,
      extraRecipes: ['heavy-oil-cracking', 'light-oil-cracking'],
      includePower: false,
    });
    expect(r.ok).toBe(true);
    expect(count(r, 'recipe:heavy-oil-cracking')).toBeGreaterThan(0);
    expect(count(r, 'recipe:light-oil-cracking')).toBeGreaterThan(0);
    expect(r.surplus.filter((s) => s.name !== 'water')).toEqual([]);
  });

  it('defaults petroleum to the cracking chain', () => {
    const r = solveFactory(data, { targets: [{ name: 'petroleum-gas', perSecond: 100 }], research: all, includePower: false });
    expect(count(r, 'recipe:light-oil-cracking')).toBeGreaterThan(0);
    expect(r.surplus.filter((s) => s.name !== 'water')).toEqual([]);
  });

  it('reports by-products as surplus without cracking', () => {
    const r = solveFactory(data, {
      targets: [{ name: 'petroleum-gas', perSecond: 55 }],
      research: all,
      recipeFor: { 'petroleum-gas': 'advanced-oil-processing' },
      includePower: false,
    });
    expect(count(r, 'recipe:advanced-oil-processing')).toBeCloseTo(5);
    expect(flow(r.surplus, 'heavy-oil')).toBeCloseTo(25);
    expect(flow(r.surplus, 'light-oil')).toBeCloseTo(45);
  });

  it('warns and still answers when the needed tech is off', () => {
    const r = solveFactory(data, { targets: [{ name: 'steel-plate', perSecond: 1 }], includePower: false });
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/steel-plate is not researched/);
  });
});

describe('computeLayoutRates', () => {
  const e = (id: string, name: string, x: number, y: number, extra: Partial<PlacedEntity> = {}): PlacedEntity => ({
    id,
    name,
    x,
    y,
    direction: 0,
    ...extra,
  });

  it('finds beacons by position and returns rates per entity id', () => {
    const layout = {
      entities: [
        e('a', 'assembling-machine-3', 0, 0, { recipe: 'iron-gear-wheel' }),
        // Touching on the right: in range.
        e('b1', 'beacon', 3, 0, { modules: ['speed-module-3', 'speed-module-3'] }),
        // 2-tile gap below: in range (a 3x3 beacon reaches a 9x9 area).
        e('b2', 'beacon', 0, 5, { modules: ['speed-module-3', 'speed-module-3'] }),
        // 3-tile gap: out of range.
        e('b3', 'beacon', 6, 0, { modules: ['speed-module-3', 'speed-module-3'] }),
        e('pump', 'offshore-pump', 20, 20, { direction: 1 }),
      ],
    };
    const rates = computeLayoutRates(layout, data, all);
    expect(rates.a!.beacons).toBe(2);
    expect(rates.a!.speedBonus).toBeCloseTo(1.5 * Math.sqrt(2));
    expect(flow(rates.pump!.outputs, 'water')).toBe(1200);
    expect(rates.b1!.powerW).toBe(480e3);
    const totals = layoutTotals(rates);
    expect(totals.powerDemandW).toBeCloseTo(rates.a!.powerW + 3 * 480e3);
    expect(flow(totals.net, 'water')).toBe(1200);
  });
});
