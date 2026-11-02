import type { Entity, GameData, Recipe } from '../data/types';

/**
 * Which technologies are researched. Value = number of levels researched for
 * that technology prototype (1 for an ordinary tech, 0 or missing for not
 * researched). Leveled/infinite techs (e.g. "mining-productivity-3") count
 * their levels from 1.
 */
export type ResearchState = Record<string, number>;

export interface ResearchBonuses {
  /** Added to drill productivity (0.1 = +10%). */
  miningProductivity: number;
  /** Lab research speed bonus. */
  labSpeed: number;
  /** Lab productivity bonus. */
  labProductivity: number;
  /** Per-recipe productivity bonus from recipe productivity research. */
  recipeProductivity: Record<string, number>;
  /** Recipes usable with this research state. */
  unlockedRecipes: Set<string>;
}

export function researchLevel(research: ResearchState, tech: string): number {
  const level = research[tech] ?? 0;
  return level > 0 ? level : 0;
}

export function researchBonuses(data: GameData, research: ResearchState): ResearchBonuses {
  const bonuses: ResearchBonuses = {
    miningProductivity: 0,
    labSpeed: 0,
    labProductivity: 0,
    recipeProductivity: {},
    unlockedRecipes: new Set(),
  };
  for (const recipe of Object.values(data.recipes)) {
    if (recipe.enabledByDefault) bonuses.unlockedRecipes.add(recipe.name);
  }
  for (const tech of Object.values(data.technologies)) {
    const level = researchLevel(research, tech.name);
    if (level === 0) continue;
    for (const r of tech.unlocksRecipes) bonuses.unlockedRecipes.add(r);
    for (const effect of tech.effects) {
      switch (effect.type) {
        case 'unlock-recipe':
          bonuses.unlockedRecipes.add(effect.recipe);
          break;
        case 'mining-drill-productivity-bonus':
          bonuses.miningProductivity += effect.modifier * level;
          break;
        case 'laboratory-speed':
          bonuses.labSpeed += effect.modifier * level;
          break;
        case 'laboratory-productivity':
          bonuses.labProductivity += effect.modifier * level;
          break;
        case 'change-recipe-productivity':
          bonuses.recipeProductivity[effect.recipe] =
            (bonuses.recipeProductivity[effect.recipe] ?? 0) + effect.modifier * level;
          break;
        default:
          break;
      }
    }
  }
  return bonuses;
}

/** Every tech researched once (infinite/leveled techs at their first level). */
export function allResearched(data: GameData): ResearchState {
  const state: ResearchState = {};
  for (const name of Object.keys(data.technologies)) state[name] = 1;
  return state;
}

/** Recipes the player can use with this research. */
export function availableRecipes(data: GameData, research: ResearchState): Recipe[] {
  const { unlockedRecipes } = researchBonuses(data, research);
  return Object.values(data.recipes).filter((r) => unlockedRecipes.has(r.name));
}

/**
 * Buildings the player can build: an entity is available when some unlocked
 * recipe makes the item that places it. Entities with no item (or whose item
 * no recipe produces) are treated as always available.
 */
export function availableEntities(data: GameData, research: ResearchState): Entity[] {
  const { unlockedRecipes } = researchBonuses(data, research);
  const producible = new Set<string>();
  const anyRecipe = new Set<string>();
  for (const recipe of Object.values(data.recipes)) {
    for (const p of recipe.results) {
      anyRecipe.add(p.name);
      if (unlockedRecipes.has(recipe.name)) producible.add(p.name);
    }
  }
  return Object.values(data.entities).filter((e) => {
    const item = e.item ?? e.name;
    return !anyRecipe.has(item) || producible.has(item);
  });
}
