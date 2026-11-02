// Inspector controls for one placed machine: recipe (or mined resource) and modules.

import { useState } from 'react';
import { gameData } from '../data';
import type { Entity, Module, Recipe } from '../data/types';
import type { PlacedEntity } from './model';

/** Recipes a crafting machine can make, sorted by display name. */
export function recipesFor(ent: Entity): Recipe[] {
  if (ent.craftingSpeed === undefined || !ent.categories?.length || ent.kind === 'lab') return [];
  const cats = new Set(ent.categories);
  return Object.values(gameData.recipes)
    .filter((r) => r.categories.some((c) => cats.has(c)))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Resources a mining drill can mine. */
export function resourcesFor(ent: Entity) {
  if (ent.kind !== 'mining-drill' || !ent.categories?.length) return [];
  const cats = new Set(ent.categories);
  return Object.values(gameData.resources).filter((r) => cats.has(r.category));
}

/** Modules that may go into this machine with its current recipe. */
export function modulesFor(ent: Entity, recipe?: string): Module[] {
  if (!ent.moduleSlots) return [];
  const allowed = ent.allowedEffects;
  const r = recipe ? gameData.recipes[recipe] : undefined;
  return Object.values(gameData.modules).filter((m) => {
    const effects = Object.entries(m.effect).filter(([, v]) => v && v > 0).map(([k]) => k);
    if (allowed && !effects.every((e) => allowed.includes(e as never))) return false;
    if (m.effect.productivity && m.effect.productivity > 0) {
      if (r && !r.allowProductivity) return false;
      if (m.limitation?.length && r && !m.limitation.includes(r.name)) return false;
    }
    return true;
  });
}

export function MachineSettings({ entity, def, onChange }: { entity: PlacedEntity; def: Entity; onChange: (patch: Partial<PlacedEntity>) => void }) {
  const recipes = recipesFor(def);
  const resources = resourcesFor(def);
  const slots = def.moduleSlots ?? 0;
  const modules = modulesFor(def, entity.recipe);
  const current = entity.modules ?? [];
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const shown = f ? recipes.filter((r) => r.displayName.toLowerCase().includes(f) || r.name === entity.recipe) : recipes;

  const setModule = (i: number, name: string) => {
    const next = Array.from({ length: slots }, (_, k) => current[k] ?? '');
    next[i] = name;
    onChange({ modules: next.some(Boolean) ? next : undefined });
  };

  return (
    <div className="machine-settings">
      {recipes.length > 0 && (
        <label>
          Recipe
          {recipes.length > 10 && (
            <input type="search" className="recipe-filter" placeholder={`Filter ${recipes.length} recipes`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
          <select value={entity.recipe ?? ''} onChange={(e) => onChange({ recipe: e.target.value || undefined })}>
            <option value="">(none)</option>
            {shown.map((r) => (
              <option key={r.name} value={r.name}>{r.displayName}</option>
            ))}
          </select>
        </label>
      )}
      {resources.length > 0 && (
        <label>
          Mining
          <select value={entity.recipe ?? ''} onChange={(e) => onChange({ recipe: e.target.value || undefined })}>
            <option value="">(none)</option>
            {resources.map((r) => (
              <option key={r.name} value={r.name}>{r.displayName}</option>
            ))}
          </select>
        </label>
      )}
      {slots > 0 && (
        <div className="modules">
          <span>Modules</span>
          {Array.from({ length: slots }, (_, i) => (
            <select key={i} value={current[i] ?? ''} onChange={(e) => setModule(i, e.target.value)} aria-label={`Module slot ${i + 1}`}>
              <option value="">(empty)</option>
              {modules.map((m) => (
                <option key={m.name} value={m.name}>{m.displayName}</option>
              ))}
            </select>
          ))}
        </div>
      )}
    </div>
  );
}
