// The engine against the extracted Factorio data (data/nauvis.json).
import { describe, expect, it } from 'vitest';
import { gameData as data } from '../src/data';
import { allResearched, ELECTRICITY, machineRate, solveFactory, type Flow } from '../src/calc';

const flow = (flows: Flow[], name: string) => flows.find((f) => f.name === name)?.perSecond ?? 0;
const all = allResearched(data);

describe('rate engine on real game data', () => {
  it('3 cable : 2 green circuit assemblers', () => {
    const cable = machineRate(data, { entity: 'assembling-machine-2', recipe: 'copper-cable' }, all);
    const circuit = machineRate(data, { entity: 'assembling-machine-2', recipe: 'electronic-circuit' }, all);
    expect(3 * flow(cable.outputs, 'copper-cable')).toBeCloseTo(2 * flow(circuit.inputs, 'copper-cable'));
  });

  it('1 offshore pump : 200 boilers : 400 steam engines (2.0: 1 water -> 10 steam)', () => {
    const pump = machineRate(data, { entity: 'offshore-pump' });
    const boiler = machineRate(data, { entity: 'boiler' });
    const engine = machineRate(data, { entity: 'steam-engine' });
    expect(flow(pump.outputs, 'water') / flow(boiler.inputs, 'water')).toBeCloseTo(200);
    expect(flow(boiler.outputs, 'steam') / flow(engine.inputs, 'steam')).toBeCloseTo(2);
    expect(-engine.powerW).toBe(900e3);
  });

  it('uranium mining needs 1 sulfuric acid per ore', () => {
    const r = machineRate(data, { entity: 'electric-mining-drill', recipe: 'uranium-ore' });
    expect(flow(r.outputs, 'uranium-ore')).toBeCloseTo(0.25);
    expect(flow(r.inputs, 'sulfuric-acid')).toBeCloseTo(0.25);
  });

  it('plans red science on a greenfield with first-tier buildings', () => {
    const r = solveFactory(data, { targets: [{ name: 'automation-science-pack', perSecond: 1 }] });
    expect(r.ok).toBe(true);
    const red = r.processes.find((p) => p.name === 'automation-science-pack')!;
    expect(red.entity).toBe('assembling-machine-1');
    expect(red.machines).toBeCloseTo(10);
    expect(flow(r.resources, 'iron-ore')).toBeCloseTo(2);
    expect(flow(r.resources, 'copper-ore')).toBeCloseTo(1);
    expect(r.imports).toEqual([]);
  });

  it('solves utility science end to end with oil cracking and no leftovers', () => {
    const r = solveFactory(data, { targets: [{ name: 'utility-science-pack', perSecond: 1 }], research: all });
    expect(r.ok).toBe(true);
    expect(r.imports).toEqual([]);
    expect(r.surplus).toEqual([]);
    expect(r.processes.some((p) => p.name === 'heavy-oil-cracking')).toBe(true);
    const engines = r.processes.find((p) => p.kind === 'generator')!;
    expect(engines.machines * 900e3).toBeCloseTo(r.powerDemandW, -3);
  });

  it('can leave power out of the plan', () => {
    const r = solveFactory(data, { targets: [{ name: 'electronic-circuit', perSecond: 10 }], research: all, includePower: false });
    expect(r.processes.some((p) => p.kind === 'generator')).toBe(false);
    expect(flow(r.imports, ELECTRICITY)).toBeCloseTo(r.powerDemandW);
  });
});
