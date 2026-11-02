import { describe, expect, it } from 'vitest';
import { allResearched } from '../src/calc';
import { gameData } from '../src/data';
import { quickSearch } from '../src/editor/search';
import { computeUnlocks, entityUnlocked, itemUnlocked, recipeUnlocked } from '../src/editor/unlocks';

describe('greenfield unlocks', () => {
  const none = computeUnlocks({});
  it('treats full research as everything unlocked', () => {
    expect(computeUnlocks(allResearched(gameData)).all).toBe(true);
  });
  it('locks buildings and recipes that need research at the start', () => {
    expect(none.all).toBe(false);
    expect(entityUnlocked(none, 'transport-belt')).toBe(true);
    expect(entityUnlocked(none, 'assembling-machine-2')).toBe(false);
    expect(recipeUnlocked(none, 'iron-gear-wheel')).toBe(true);
    expect(recipeUnlocked(none, 'fast-transport-belt')).toBe(false);
    expect(itemUnlocked(none, 'iron-ore')).toBe(true);
    expect(itemUnlocked(none, 'speed-module')).toBe(false);
  });
  it('marks locked search hits and ranks them last', () => {
    const hits = quickSearch('assembling machine', 12, none);
    expect(hits.find((h) => h.building === 'assembling-machine-2')?.locked).toBe(true);
    expect(hits.findIndex((h) => h.locked)).toBeGreaterThan(hits.findIndex((h) => !h.locked));
    expect(quickSearch('assembling machine 2')[0].locked).toBeUndefined();
  });
});
