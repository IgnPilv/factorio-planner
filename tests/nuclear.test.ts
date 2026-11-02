// Nuclear power: reactors burn fuel cells and heat a heat network; heat
// exchangers turn that heat into 500 °C steam for turbines.
import { describe, expect, it } from 'vitest';
import { gameData as data } from '../src/data';
import { machineRate, simulateLayout, type PlacedEntity } from '../src/calc';

type Dir = 0 | 1 | 2 | 3;
const e = (id: string, name: string, x: number, y: number, direction: Dir = 0, recipe?: string): PlacedEntity => ({ id, name, x, y, direction, recipe });
const N = 0, E = 1, S = 2, W = 3;

describe('heat exchanger and reactor rates', () => {
  it('a heat exchanger makes 103.09 steam/s from 10 MW, a reactor gives 40 MW for 1 cell per 200 s', () => {
    const hx = machineRate(data, { entity: 'heat-exchanger' });
    expect(hx.outputs[0]!.perSecond).toBeCloseTo(10e6 / (485 * 200), 3);
    expect(hx.heatW).toBe(10e6);
    const r = machineRate(data, { entity: 'nuclear-reactor' });
    expect(r.heatW).toBe(-40e6);
    expect(r.fuelW).toBe(40e6);
  });
});

/** Reactor at (0,0) fed and emptied by inserters on its east side, heat pipe to a heat exchanger below, turbine below that, and `beacons` beacons as load. */
function plant(beacons: number) {
  const ents: PlacedEntity[] = [
    e('reactor', 'nuclear-reactor', 0, 0),
    e('cells', 'wooden-chest', 6, 1, N, 'uranium-fuel-cell'),
    e('fuel-in', 'inserter', 5, 1, W),
    e('fuel-out', 'inserter', 5, 3, E),
    e('spent', 'wooden-chest', 6, 3),
    e('pipe', 'heat-pipe', 2, 5),
    e('hx', 'heat-exchanger', 1, 6, S),
    e('water-pipe', 'pipe', 4, 7),
    e('pump', 'offshore-pump', 5, 7, N),
    e('turbine', 'steam-turbine', 1, 8, N),
  ];
  for (let i = 0; i < beacons; i++) ents.push(e(`b${i}`, 'beacon', i * 3, 20));
  return simulateLayout({ entities: ents, water: ['5,6'] }, data);
}

describe('nuclear plant', () => {
  it('a fuelled reactor burns a cell every 200 s even with nothing to power', () => {
    const r = plant(0);
    expect(r.entities.reactor!.activity).toBeCloseTo(1, 6);
    expect(r.transport['fuel-in']!.perSecond).toBeCloseTo(40e6 / 8e9, 6);
    expect(r.transport['fuel-out']!.perSecond).toBeCloseTo(40e6 / 8e9, 6);
    // Only the two inserters draw power: the exchanger barely runs.
    expect(r.entities.hx!.activity).toBeLessThan(1e-3);
  });

  it('heat reaches the exchanger through the heat pipe and runs the turbine as hard as demand needs', () => {
    const r = plant(10);
    expect(r.ok).toBe(true);
    // Ten beacons draw 4.8 MW, plus the inserters.
    expect(r.power.demandW).toBeGreaterThan(4.8e6);
    const turbine = r.entities.turbine!;
    expect(turbine.activity).toBeCloseTo(r.power.demandW / 5.82e6, 4);
    const steam = turbine.activity * 60;
    expect(r.entities.hx!.activity).toBeCloseTo(steam / (10e6 / (485 * 200)), 4);
    expect(r.entities.reactor!.activity).toBeCloseTo(1, 6);
  });

  it('a reactor whose spent cells are not taken out stops', () => {
    const ents = [
      e('reactor', 'nuclear-reactor', 0, 0),
      e('cells', 'wooden-chest', 6, 1, N, 'uranium-fuel-cell'),
      e('fuel-in', 'burner-inserter', 5, 1, W),
    ];
    const r = simulateLayout({ entities: ents }, data);
    expect(r.entities.reactor!.activity).toBeCloseTo(0, 6);
    expect(r.entities.reactor!.status).toBe('output-blocked');
  });

  it('reactors side by side get the neighbour bonus: 80 MW each', () => {
    const ents: PlacedEntity[] = [e('a', 'nuclear-reactor', 0, 0), e('b', 'nuclear-reactor', 5, 0)];
    for (const [x, id] of [[1, 'a'], [6, 'b']] as const) {
      ents.push(
        e(`${id}-cells`, 'wooden-chest', x + 1, 6, N, 'uranium-fuel-cell'),
        e(`${id}-in`, 'burner-inserter', x + 1, 5, N),
        e(`${id}-out`, 'burner-inserter', x, 5, S),
        e(`${id}-spent`, 'wooden-chest', x, 6),
      );
    }
    const r = simulateLayout({ entities: ents }, data);
    expect(r.entities.a!.activity).toBeCloseTo(1, 6);
    expect(r.entities.a!.rate.heatW).toBeCloseTo(-80e6, 0);
    expect(r.entities.b!.rate.heatW).toBeCloseTo(-80e6, 0);
    // One tile off line: the side midpoints don't meet, so no bonus.
    const shifted = ents.map((p) => (p.id.startsWith('b') ? { ...p, y: p.y + 1 } : p));
    const r2 = simulateLayout({ entities: shifted }, data);
    expect(r2.entities.a!.rate.heatW).toBeCloseTo(-40e6, 0);
  });
});
