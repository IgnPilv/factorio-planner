// What the player can build and craft with the current research. In greenfield
// mode the palette, quick search and recipe pickers grey out the rest.

import { availableEntities, researchBonuses, type ResearchState } from '../calc';
import { gameData } from '../data';

export interface Unlocks {
  /** Everything is available, nothing needs greying out. */
  all: boolean;
  entities: ReadonlySet<string>;
  recipes: ReadonlySet<string>;
  /** Items some unlocked recipe produces (for module slots and chest supplies). */
  items: ReadonlySet<string>;
}

export const ALL_UNLOCKED: Unlocks = { all: true, entities: new Set(), recipes: new Set(), items: new Set() };

export function computeUnlocks(research: ResearchState): Unlocks {
  const recipes = researchBonuses(gameData, research).unlockedRecipes;
  if (recipes.size >= Object.keys(gameData.recipes).length) return ALL_UNLOCKED;
  const entities = new Set(availableEntities(gameData, research).map((e) => e.name));
  const items = new Set<string>();
  for (const name of recipes) for (const p of gameData.recipes[name]?.results ?? []) items.add(p.name);
  return { all: false, entities, recipes, items };
}

export const entityUnlocked = (u: Unlocks, name: string) => u.all || u.entities.has(name);
export const recipeUnlocked = (u: Unlocks, name: string) => u.all || u.recipes.has(name);
let craftable: Set<string> | null = null;
/** Items with no recipe at all (e.g. raw ores) count as available. */
export function itemUnlocked(u: Unlocks, name: string): boolean {
  if (u.all || u.items.has(name)) return true;
  craftable ??= new Set(Object.values(gameData.recipes).flatMap((r) => r.results.map((p) => p.name)));
  return !craftable.has(name);
}
