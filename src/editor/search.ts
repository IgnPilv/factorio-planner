// Quick search over buildings, recipes and minable resources. Picking a recipe
// or resource puts a suitable machine in hand with that recipe already set.

import { gameData } from '../data';
import type { Entity } from '../data/types';
import { ENTITIES } from './catalog';

export interface SearchHit {
  kind: 'building' | 'recipe' | 'resource';
  /** Building to place. */
  building: string;
  /** Recipe (or resource for drills) to preset on it. */
  recipe?: string;
  label: string;
  /** Secondary text, e.g. which machine makes the recipe. */
  detail?: string;
}

/** Preferred machine when a recipe can be made in several. Greenfield-friendly tiers first. */
const MACHINE_PREFERENCE = [
  'assembling-machine-2', 'assembling-machine-1', 'assembling-machine-3',
  'stone-furnace', 'steel-furnace', 'electric-furnace',
  'chemical-plant', 'oil-refinery', 'centrifuge', 'rocket-silo',
  'electric-mining-drill', 'burner-mining-drill', 'pumpjack',
];
const rank = (name: string) => {
  const i = MACHINE_PREFERENCE.indexOf(name);
  return i < 0 ? MACHINE_PREFERENCE.length : i;
};

export function machinesForRecipe(recipeName: string): Entity[] {
  const r = gameData.recipes[recipeName];
  if (!r) return [];
  const cats = new Set(r.categories?.length ? r.categories : [r.category]);
  return Object.values(ENTITIES)
    .filter((e) => e.craftingSpeed !== undefined && e.kind !== 'lab' && e.categories?.some((c) => cats.has(c)))
    .sort((a, b) => rank(a.name) - rank(b.name));
}

export function drillsForResource(resourceName: string): Entity[] {
  const res = gameData.resources[resourceName];
  if (!res) return [];
  return Object.values(ENTITIES)
    .filter((e) => e.kind === 'mining-drill' && e.categories?.includes(res.category))
    .sort((a, b) => rank(a.name) - rank(b.name));
}

let index: SearchHit[] | null = null;
function buildIndex(): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const e of Object.values(ENTITIES)) hits.push({ kind: 'building', building: e.name, label: e.displayName });
  for (const r of Object.values(gameData.recipes)) {
    const m = machinesForRecipe(r.name)[0];
    if (m) hits.push({ kind: 'recipe', building: m.name, recipe: r.name, label: r.displayName, detail: m.displayName });
  }
  for (const res of Object.values(gameData.resources)) {
    const d = drillsForResource(res.name)[0];
    if (d) hits.push({ kind: 'resource', building: d.name, recipe: res.name, label: res.displayName, detail: d.displayName });
  }
  return hits;
}

/**
 * Case-insensitive search: every word of the query must appear in the label.
 * Results that start with the query, then words that start with it, rank first;
 * buildings come before recipes of the same name.
 */
export function quickSearch(query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  index ??= buildIndex();
  const words = q.split(/\s+/);
  const scored: { hit: SearchHit; score: number }[] = [];
  for (const hit of index) {
    const label = hit.label.toLowerCase();
    if (!words.every((w) => label.includes(w))) continue;
    let score = label === q ? 0 : label.startsWith(q) ? 1 : label.split(/[\s-]+/).some((w) => w.startsWith(words[0])) ? 2 : 3;
    score = score * 3 + (hit.kind === 'building' ? 0 : hit.kind === 'resource' ? 1 : 2);
    scored.push({ hit, score });
  }
  scored.sort((a, b) => a.score - b.score || a.hit.label.length - b.hit.label.length || a.hit.label.localeCompare(b.hit.label));
  return scored.slice(0, limit).map((s) => s.hit);
}
