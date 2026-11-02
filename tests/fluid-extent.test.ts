// 2.0 pipeline extent: a segment spreading outside 320×320 tiles carries nothing.
import { describe, expect, it } from 'vitest';
import { gameData as data } from '../src/data';
import { PIPELINE_MAX_EXTENT, allResearched, simulateLayout, type PlacedEntity } from '../src/calc';

const e = (id: string, name: string, x: number, y: number, direction: 0 | 1 | 2 | 3 = 0, recipe?: string): PlacedEntity => ({ id, name, x, y, direction, recipe });

/** Offshore pump, boiler and steam engine; the water pipe also runs `length` tiles east. */
function plant(length: number) {
  const ents: PlacedEntity[] = [
    e('pump', 'offshore-pump', 0, 0),
    e('p0', 'pipe', 0, 1),
    e('boiler', 'boiler', 0, 2, 2),
    e('coal', 'wooden-chest', 4, 2, 0, 'coal'),
    e('ins', 'inserter', 3, 2, 3),
    e('engine', 'steam-engine', 0, 4),
    e('pole', 'small-electric-pole', 3, 5),
    e('asm', 'assembling-machine-1', 4, 6, 0, 'iron-gear-wheel'),
    e('src', 'wooden-chest', 4, 9, 0, 'iron-plate'),
    e('in', 'fast-inserter', 4, 9 - 1, 0),
    e('out', 'fast-inserter', 7, 7, 1),
    e('dst', 'wooden-chest', 8, 7),
  ];
  for (let x = 1; x < length; x++) ents.push(e(`p${x}`, 'pipe', x, 1));
  return simulateLayout({ entities: ents, water: ['0,-1'] }, data, allResearched(data));
}

describe('pipeline extent', () => {
  it('is 320 tiles in 2.0', () => {
    expect(PIPELINE_MAX_EXTENT).toBe(320);
  });

  it('a pipeline within 320 tiles feeds the boiler', () => {
    const r = plant(PIPELINE_MAX_EXTENT);
    expect(r.entities.boiler!.activity).toBeGreaterThan(0);
    expect(r.entities.asm!.status).toBe('working');
    expect(r.warnings.some((w) => w.includes('spreads outside'))).toBe(false);
  });

  it('one tile wider and nothing flows', () => {
    const r = plant(PIPELINE_MAX_EXTENT + 1);
    expect(r.entities.boiler!.activity).toBe(0);
    expect(r.entities.asm!.activity).toBe(0);
    expect(r.warnings.some((w) => w.includes('spreads outside 320×320'))).toBe(true);
  });
});
