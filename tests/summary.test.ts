// Selection flows and the bottleneck list built from a steady-state result.
import { describe, expect, it } from 'vitest';
import { gameData as data } from '../src/data';
import { bottlenecks, groupFlows, simulateLayout, type PlacedEntity } from '../src/calc';

const e = (id: string, name: string, x: number, y: number, direction: 0 | 1 | 2 | 3 = 0, recipe?: string): PlacedEntity => ({ id, name, x, y, direction, recipe });
const E = 1;

// Chest of plates -> basic inserter -> gear assembler -> inserter -> chest.
const starvedLine = [
  e('src', 'wooden-chest', 0, 1, 0, 'iron-plate'),
  e('in', 'inserter', 1, 1, E),
  e('asm', 'assembling-machine-2', 2, 0, 0, 'iron-gear-wheel'),
  e('out', 'inserter', 5, 1, E),
  e('dst', 'wooden-chest', 6, 1),
];

describe('groupFlows', () => {
  it('nets a starved assembler at the speed it actually runs', () => {
    const sim = simulateLayout({ entities: starvedLine }, data);
    const g = groupFlows(sim, ['asm']);
    const per = (n: string) => g.net.find((f) => f.name === n)?.perSecond ?? 0;
    // One basic inserter: 60/70 plates/s in, half that in gears out.
    expect(per('iron-plate')).toBeCloseTo(-60 / 70, 3);
    expect(per('iron-gear-wheel')).toBeCloseTo(60 / 70 / 2, 3);
    expect(g.machines).toBe(1);
    expect(g.slowed).toBe(1);
    expect(g.powerW).toBeGreaterThan(0);
  });
});

describe('bottlenecks', () => {
  it('names the starved assembler and the full inserter feeding it', () => {
    const sim = simulateLayout({ entities: starvedLine }, data);
    const list = bottlenecks(sim, starvedLine);
    expect(list[0]).toMatchObject({ kind: 'starved', entity: 'assembling-machine-2', recipe: 'iron-gear-wheel', ids: ['asm'] });
    expect(list[0]!.lost).toBeCloseTo(1 - 60 / 70 / 3, 3);
    const full = list.find((b) => b.kind === 'transport');
    expect(full).toMatchObject({ entity: 'inserter', items: ['iron-plate'], ids: ['in'] });
  });

  it('lists missing inputs first and groups identical machines', () => {
    const ents = [
      e('a1', 'assembling-machine-2', 0, 0, 0, 'electronic-circuit'),
      e('a2', 'assembling-machine-2', 0, 4, 0, 'electronic-circuit'),
      e('b', 'assembling-machine-2', 10, 0, 0, 'iron-gear-wheel'),
      e('src', 'wooden-chest', 9, 1, 0, 'iron-plate'),
      e('ins', 'inserter', 9, 2, 2),
    ];
    const sim = simulateLayout({ entities: ents }, data);
    const list = bottlenecks(sim, ents);
    expect(list[0]!.kind).toBe('missing');
    expect(list[0]!.ids.sort()).toEqual(['a1', 'a2']);
    expect(list[0]!.items.sort()).toEqual(['copper-cable', 'iron-plate']);
  });

  it('is empty for a layout that runs flat out', () => {
    const ents = [
      e('src', 'wooden-chest', 0, 1, 0, 'iron-plate'),
      e('in', 'fast-inserter', 1, 1, E),
      e('asm', 'assembling-machine-1', 2, 0, 0, 'iron-gear-wheel'),
      e('out', 'fast-inserter', 5, 1, E),
      e('dst', 'wooden-chest', 6, 1),
    ];
    const sim = simulateLayout({ entities: ents }, data);
    expect(sim.entities.asm!.status).toBe('working');
    expect(bottlenecks(sim, ents)).toEqual([]);
  });
});
