import { describe, expect, it } from 'vitest';
import { gameData as d, machinesFor, recipesProducing, techUnlocking } from '../src/data';

// Reference values from the Factorio wiki / game, used to catch extraction regressions.
describe('extracted game data', () => {
  it('has the core recipes with correct times and amounts', () => {
    const gc = d.recipes['electronic-circuit'];
    expect(gc.time).toBe(0.5);
    expect(gc.ingredients).toEqual([
      { name: 'iron-plate', type: 'item', amount: 1 },
      { name: 'copper-cable', type: 'item', amount: 3 },
    ]);
    expect(d.recipes['copper-cable'].results[0].amount).toBe(2);
    expect(d.recipes['iron-plate'].time).toBe(3.2);
    expect(d.recipes['iron-plate'].category).toBe('smelting');
    expect(d.recipes['advanced-oil-processing'].category).toBe('oil-processing');
  });

  it('has building stats', () => {
    expect(d.entities['assembling-machine-2']).toMatchObject({ craftingSpeed: 0.75, moduleSlots: 2, energyUsage: 150_000, width: 3, height: 3 });
    expect(d.entities['electric-mining-drill']).toMatchObject({ miningSpeed: 0.5, miningArea: 5, kind: 'mining-drill' });
    expect(d.entities['stone-furnace']).toMatchObject({ craftingSpeed: 1, energySource: 'burner', width: 2, height: 2 });
    expect(d.entities['transport-belt'].beltThroughput).toBe(15);
    expect(d.entities['express-transport-belt'].beltThroughput).toBe(45);
    expect(d.entities['beacon']).toMatchObject({ distributionEffectivity: 1.5, moduleSlots: 2 });
  });

  it('has water and steam power', () => {
    expect(d.entities['offshore-pump']).toMatchObject({ pumpingSpeed: 1200, fluid: 'water' });
    expect(d.entities['boiler']).toMatchObject({ energyUsage: 1_800_000, temperature: 165 });
    expect(d.entities['steam-engine']).toMatchObject({ fluidUsage: 30, powerOutput: 900_000 });
    expect(d.items['water'].type).toBe('fluid');
  });

  it('has modules and rate-changing research', () => {
    expect(d.modules['productivity-module-3'].effect).toMatchObject({ productivity: 0.1, speed: -0.15 });
    expect(d.technologies['mining-productivity-1'].effects).toEqual([{ type: 'mining-drill-productivity-bonus', modifier: 0.1 }]);
    expect(d.technologies['mining-productivity-1'].affectsRates).toBe(true);
    expect(techUnlocking(d, 'assembling-machine-1')?.name).toBe('automation');
  });

  it('has ores and crude oil', () => {
    expect(d.resources['iron-ore']).toMatchObject({ miningTime: 1, category: 'basic-solid' });
    expect(d.resources['crude-oil']).toMatchObject({ infinite: true, category: 'basic-fluid' });
  });

  it('links recipes to items and machines', () => {
    expect(recipesProducing(d, 'electronic-circuit').map((r) => r.name)).toContain('electronic-circuit');
    expect(machinesFor(d, d.recipes['iron-plate']).map((e) => e.name)).toEqual(
      expect.arrayContaining(['stone-furnace', 'steel-furnace', 'electric-furnace']));
    for (const r of Object.values(d.recipes)) {
      for (const x of [...r.ingredients, ...r.results]) expect(d.items[x.name], `${r.name} -> ${x.name}`).toBeDefined();
    }
  });
});
