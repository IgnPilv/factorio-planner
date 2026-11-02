import { describe, expect, it } from 'vitest';
import { computeLayoutRates } from '../src/calc';
import { gameData } from '../src/data';
import { emptyLayout, placeEntity, type Layout } from '../src/editor/model';
import { analysePower } from '../src/editor/power';
import { quickSearch } from '../src/editor/search';
import { buildBadges } from '../src/editor/views';

const place = (l: Layout, name: string, x: number, y: number, extra: { recipe?: string } = {}) => {
  const r = placeEntity(l, { name, x, y, direction: 0, ...extra });
  expect(r.result.ok).toBe(true);
  return r.layout;
};

describe('power networks', () => {
  it('connects poles in wire reach and powers covered machines', () => {
    let l = emptyLayout();
    l = place(l, 'steam-engine', 0, 0); // 3x5 at 0..2, 0..4
    l = place(l, 'small-electric-pole', 3, 2); // covers 1..5
    l = place(l, 'small-electric-pole', 10, 2); // 7 tiles away: within 7.5 reach
    l = place(l, 'assembling-machine-2', 11, 0, { recipe: 'iron-gear-wheel' }); // covered by second pole
    l = place(l, 'assembling-machine-2', 30, 0, { recipe: 'iron-gear-wheel' }); // nowhere near a pole
    const rates = computeLayoutRates(l, gameData);
    const p = analysePower(l.entities, rates);
    expect(p.wires).toHaveLength(1);
    expect(p.networks).toHaveLength(1);
    const [near, far] = l.entities.filter((e) => e.name === 'assembling-machine-2');
    expect(p.status[near.id]).toBe('powered');
    expect(p.status[far.id]).toBe('unconnected');
    expect(p.totalSupplyW).toBeCloseTo(900e3);
    expect(p.unconnectedDemandW).toBeGreaterThan(0);
  });

  it('marks machines on a network without generators as having no power', () => {
    let l = place(emptyLayout(), 'small-electric-pole', 0, 0);
    l = place(l, 'assembling-machine-1', 1, 1, { recipe: 'iron-gear-wheel' });
    const p = analysePower(l.entities, computeLayoutRates(l, gameData));
    expect(Object.values(p.status)).toEqual(['no-power']);
  });

  it('splits poles out of reach into separate networks', () => {
    let l = place(emptyLayout(), 'small-electric-pole', 0, 0);
    l = place(l, 'small-electric-pole', 20, 0);
    const p = analysePower(l.entities, {});
    expect(p.networks).toHaveLength(2);
    expect(p.wires).toHaveLength(0);
  });
});

describe('quick search', () => {
  it('finds buildings first, then recipes with a machine to make them', () => {
    const hits = quickSearch('assembling machine 2');
    expect(hits[0]).toMatchObject({ kind: 'building', building: 'assembling-machine-2' });
    const circuit = quickSearch('electronic circ')[0];
    expect(circuit).toMatchObject({ kind: 'recipe', recipe: 'electronic-circuit', building: 'assembling-machine-2' });
    expect(quickSearch('iron plate')[0]).toMatchObject({ recipe: 'iron-plate', building: 'stone-furnace' });
    expect(quickSearch('iron ore')[0]).toMatchObject({ kind: 'resource', building: 'electric-mining-drill' });
    expect(quickSearch('zzzz')).toEqual([]);
  });
});

describe('badges', () => {
  it('shows output per minute in the normal view', () => {
    const l = place(emptyLayout(), 'assembling-machine-1', 0, 0, { recipe: 'iron-gear-wheel' });
    const b = buildBadges('normal', l.entities, computeLayoutRates(l, gameData));
    // speed 0.5, 1 gear per 0.5 s => 1 gear/s = 60/min
    expect(Object.values(b)).toEqual(['60/min']);
  });
});
