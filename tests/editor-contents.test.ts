import { describe, expect, it } from 'vitest';
import { gameData } from '../src/data';
import { simulateLayout } from '../src/calc';
import { entityContents } from '../src/editor/contents';
import type { PlacedEntity } from '../src/editor/model';

// Supply chest -> inserter -> chest, and supply chest -> inserter -> two belts (open end).
const ents: PlacedEntity[] = [
  { id: 'src', name: 'iron-chest', x: 0, y: 0, direction: 0, recipe: 'iron-plate' },
  { id: 'i1', name: 'inserter', x: 0, y: 1, direction: 2 },
  { id: 'dst', name: 'iron-chest', x: 0, y: 2, direction: 0 },
  { id: 'src2', name: 'iron-chest', x: 5, y: 0, direction: 0, recipe: 'copper-plate' },
  { id: 'i2', name: 'inserter', x: 5, y: 1, direction: 2 },
  { id: 'b1', name: 'transport-belt', x: 5, y: 2, direction: 1 },
  { id: 'b2', name: 'transport-belt', x: 6, y: 2, direction: 1 },
];

describe('alt-mode contents', () => {
  it('shows what flows through belts, inserters and chests', () => {
    const sim = simulateLayout({ entities: ents }, gameData);
    expect(sim.chests?.dst.stored.map((f) => f.name)).toEqual(['iron-plate']);
    expect(sim.chests?.src.supplied.map((f) => f.name)).toEqual(['iron-plate']);
    const c = entityContents(ents, sim);
    for (const id of ['src', 'i1', 'dst']) expect(c[id], id).toEqual(['iron-plate']);
    for (const id of ['src2', 'i2', 'b1', 'b2']) expect(c[id], id).toEqual(['copper-plate']);
  });

  it('falls back to settings without a simulation', () => {
    const c = entityContents([...ents, { id: 'f', name: 'fast-inserter', x: 5, y: 5, direction: 0, filters: ['copper-plate'] }], null);
    expect(c).toEqual({ src: ['iron-plate'], src2: ['copper-plate'], f: ['copper-plate'] });
  });
});
