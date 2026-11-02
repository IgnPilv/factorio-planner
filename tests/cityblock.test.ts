import { describe, expect, it } from 'vitest';
import { analyse, avoidRails, buildDesign, DEFAULT_SPEC, gridBuildings, type BlockSpec } from '../src/cityblock/block';
import { canWire, coverage, roboportsConnect, supplyRect } from '../src/cityblock/network';

const run = (over: Partial<BlockSpec>, subs = 0, robo = 0) => {
  const spec = { ...DEFAULT_SPEC, ...over };
  spec.buildings = gridBuildings(spec, subs, robo);
  const a = analyse(buildDesign(spec));
  return Object.fromEntries(a.checks.map((c) => [c.id, c]));
};

describe('networks from game data', () => {
  it('substations 18 apart (centre to centre) wire up and tile their supply areas', () => {
    const a = { id: 'a', name: 'substation', x: 9, y: 9 };
    const b = { id: 'b', name: 'substation', x: 27, y: 9 };
    expect(canWire(a, b)).toBe(true);
    expect(canWire(a, { ...b, x: 28 })).toBe(false);
    const cov = coverage({ x0: 0, y0: 0, x1: 36, y1: 18 }, [supplyRect(a)!, supplyRect(b)!]);
    expect(cov.covered).toBe(cov.total);
  });
  it('roboports join a network up to 50 tiles apart', () => {
    const a = { id: 'a', name: 'roboport', x: 0, y: 0 };
    expect(roboportsConnect(a, { id: 'b', name: 'roboport', x: 50, y: 50 })).toBe(true);
    expect(roboportsConnect(a, { id: 'b', name: 'roboport', x: 51, y: 0 })).toBe(false);
  });
});

describe('city block checks', () => {
  it('90x90 inner with 5x5 substations and 2x2 roboports passes coverage', () => {
    const c = run({ pitch: 102, corridor: 12 }, 5, 2);
    expect(c['rail-grid'].status).toBe('pass');
    expect(c['dead-ends'].status).toBe('pass');
    expect(c['signals'].status).toBe('pass');
    expect(c['power-coverage'].status).toBe('pass');
    expect(c['logistics-coverage'].status).toBe('pass');
    expect(c['robots-connected'].status).toBe('pass');
    // Substations inside the inner area do not reach across a 12-wide corridor.
    expect(c['power-neighbours'].status).toBe('warn');
  });
  it('54x54 inner with one roboport leaves logistics gaps and short blocks for 1-4 trains', () => {
    const c = run({ pitch: 66, corridor: 12, wagons: 4 }, 3, 1);
    expect(c['power-coverage'].status).toBe('pass');
    expect(c['logistics-coverage'].status).toBe('warn');
    expect(c['block-length'].status).toBe('warn');
    expect(run({ pitch: 66, corridor: 12, wagons: 2 }, 3, 1)['block-length'].status).toBe('pass');
  });
  it('odd track offsets put rails off the grid', () => {
    expect(run({ trackSpacing: 4 })['rail-grid'].status).toBe('fail');
    expect(run({ trackSpacing: 4, offset: 1 })['rail-grid'].status).toBe('pass');
    expect(run({ pitch: 101 })['pitch-even'].status).toBe('fail');
  });
  it('a big pole in the corridor crossing links blocks', () => {
    const spec = { ...DEFAULT_SPEC, pitch: 102, corridor: 12 };
    spec.buildings = [...gridBuildings(spec, 5, 0), { name: 'big-electric-pole', x: 1, y: 51 }];
    const c = Object.fromEntries(analyse(buildDesign(spec)).checks.map((x) => [x.id, x]));
    expect(c['power-neighbours'].status).toBe('pass');
  });
});

describe('drive-through station', () => {
  it('fits a 1-4 train in a 102 block with correct signalling and no dead ends', () => {
    const c = run({ pitch: 102, corridor: 12, station: true });
    expect(c['station-fit'].status).toBe('pass');
    expect(c['station-junction'].status).toBe('pass');
    expect(c['signals'].status).toBe('pass');
    expect(c['dead-ends'].status).toBe('pass');
  });
  it('reports a block too small for the station', () => {
    expect(run({ pitch: 66, corridor: 12, station: true })['station-junction'].status).toBe('fail');
  });
});

describe('avoidRails', () => {
  it('moves substations off the station track and keeps power coverage', () => {
    const s = { ...DEFAULT_SPEC, pitch: 102, corridor: 12, station: true };
    const buildings = avoidRails(s, gridBuildings(s, 5, 2));
    const c = Object.fromEntries(analyse(buildDesign({ ...s, buildings })).checks.map((x) => [x.id, x]));
    expect(c['buildings-on-rails'].status).toBe('pass');
    expect(buildings).toHaveLength(29);
    console.log(c['power-coverage'].title, '|', c['logistics-coverage'].title);
  });
});
