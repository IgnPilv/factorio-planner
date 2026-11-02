import { describe, expect, it } from 'vitest';
import { gameData as data } from '../src/data';
import { availableRecipes, researchBonuses } from '../src/calc';
import { bonusFamilies, DEFAULT_SETTINGS, toResearchState } from '../src/ui/research';

describe('research settings', () => {
  it('defaults to everything unlocked with no rate bonuses', () => {
    const b = researchBonuses(data, toResearchState(data, DEFAULT_SETTINGS));
    expect(b.miningProductivity).toBe(0);
    expect(b.unlockedRecipes.has('steel-plate')).toBe(true);
  });

  it('groups bonus techs into families with level pickers', () => {
    const ids = bonusFamilies(data).map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['mining-productivity', 'inserter-capacity-bonus', 'research-speed']));
    const mining = bonusFamilies(data).find((f) => f.id === 'mining-productivity')!;
    expect(mining.max).toBe(Infinity);
  });

  it('mining productivity level 5 = +50% (three finite techs then two infinite levels)', () => {
    const s = toResearchState(data, { ...DEFAULT_SETTINGS, levels: { 'mining-productivity': 5 } });
    expect(researchBonuses(data, s).miningProductivity).toBeCloseTo(0.5);
  });

  it('full inserter capacity research gives hand 3, bulk hand 12', () => {
    const fam = bonusFamilies(data).find((f) => f.id === 'inserter-capacity-bonus')!;
    const s = toResearchState(data, { ...DEFAULT_SETTINGS, levels: { 'inserter-capacity-bonus': fam.max } });
    const b = researchBonuses(data, s);
    expect(1 + b.inserterStackBonus).toBe(3);
    expect(1 + b.bulkInserterBonus).toBe(12);
    expect(fam.describe(fam.max)).toBe('hand size 3 (bulk 12)');
  });

  it('greenfield mode only unlocks picked techs and their prerequisites', () => {
    const s = toResearchState(data, { lockUnlocks: true, unlocked: ['automation-2'], levels: {} });
    const recipes = availableRecipes(data, s).map((r) => r.name);
    expect(recipes).toContain('assembling-machine-2');
    expect(recipes).toContain('assembling-machine-1'); // prerequisite "automation"
    expect(recipes).not.toContain('basic-oil-processing');
  });
});
