// Labs research a technology: they use its packs at its speed, chained labs pass packs on.
import { describe, expect, it } from 'vitest';
import { gameData as data } from '../src/data';
import { researchBonuses, researchChoices, simulateLayout, type PlacedEntity } from '../src/calc';

const e = (id: string, name: string, x: number, y: number, direction: 0 | 1 | 2 | 3 = 0, recipe?: string): PlacedEntity => ({ id, name, x, y, direction, recipe });
const E = 1;

// Red packs from a supply chest into lab A, and from lab A on to lab B.
const chain = [
  e('red', 'wooden-chest', 0, 1, 0, 'automation-science-pack'),
  e('i1', 'inserter', 1, 1, E),
  e('labA', 'lab', 2, 0),
  e('i2', 'inserter', 5, 1, E),
  e('labB', 'lab', 6, 0),
];

describe('labs', () => {
  it('research the most advanced tech the packs allow, at lab speed / unit time', () => {
    const r = simulateLayout({ entities: chain }, data);
    const tech = data.technologies[r.research!.tech]!;
    expect(tech.cost!.ingredients.map((i) => i.name)).toEqual(['automation-science-pack']);
    expect(r.research!.choices[0]).toBe(r.research!.tech);
    for (const id of ['labA', 'labB']) {
      expect(r.entities[id]!.status).toBe('working');
      expect(r.entities[id]!.activity).toBeCloseTo(1);
    }
    // Two labs at speed 1: 2 / time units per second, one pack each.
    expect(r.research!.unitsPerSecond).toBeCloseTo(2 / tech.cost!.time);
    expect(r.research!.packs).toEqual([{ name: 'automation-science-pack', perSecond: expect.closeTo(2 / tech.cost!.time, 6) }]);
    // Labs are not layout outputs any more.
    expect(r.outputs.find((f) => f.name === 'automation-science-pack')).toBeUndefined();
  });

  it('a chosen tech whose packs do not all arrive leaves the labs starved', () => {
    const r = simulateLayout({ entities: chain }, data, {}, { labResearch: 'logistics-2' });
    expect(r.research!.tech).toBe('logistics-2');
    expect(r.entities.labA!.activity).toBe(0);
    expect(r.entities.labA!.missing).toEqual(['logistic-science-pack']);
    expect(r.research!.unitsPerSecond).toBe(0);
  });

  it('lab speed research makes labs use packs faster', () => {
    const research = { 'research-speed-1': 1, 'research-speed-2': 1 };
    const bonus = researchBonuses(data, research).labSpeed;
    expect(bonus).toBeGreaterThan(0);
    const r = simulateLayout({ entities: chain }, data, research);
    const time = data.technologies[r.research!.tech]!.cost!.time;
    expect(r.research!.unitsPerSecond).toBeCloseTo((2 * (1 + bonus)) / time);
  });

  it('labs with no packs stand idle', () => {
    const r = simulateLayout({ entities: [e('labA', 'lab', 2, 0)] }, data);
    expect(r.entities.labA!.status).toBe('idle');
    expect(r.research).toBeUndefined();
  });

  it('lists what red and green packs can research, most advanced first', () => {
    const choices = researchChoices(data, ['automation-science-pack', 'logistic-science-pack']);
    expect(choices.length).toBeGreaterThan(10);
    expect(choices[0]!.cost!.ingredients).toHaveLength(2);
    expect(choices.some((t) => t.name === 'automation')).toBe(true);
  });
});
