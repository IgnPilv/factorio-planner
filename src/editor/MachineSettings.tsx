// Inspector controls for one placed machine: recipe (or mined resource) and modules.

import { useState } from 'react';
import { gameData } from '../data';
import type { Entity, Module, Recipe } from '../data/types';
import type { PlacedEntity } from './model';
import { ALL_UNLOCKED, itemUnlocked, recipeUnlocked, type Unlocks } from './unlocks';

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

export function MachineSettings({
  entity,
  def,
  onChange,
  unlocks = ALL_UNLOCKED,
}: {
  entity: PlacedEntity;
  def: Entity;
  onChange: (patch: Partial<PlacedEntity>) => void;
  unlocks?: Unlocks;
}) {
  const recipes = recipesFor(def);
  const current = entity.modules ?? [];
  const resources = resourcesFor(def);
  const slots = def.moduleSlots ?? 0;
  const modules = modulesFor(def, entity.recipe).filter((m) => itemUnlocked(unlocks, m.name) || current.includes(m.name));
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const shown = f ? recipes.filter((r) => r.displayName.toLowerCase().includes(f) || r.name === entity.recipe) : recipes;
  const open = shown.filter((r) => recipeUnlocked(unlocks, r.name));
  const locked = shown.filter((r) => !recipeUnlocked(unlocks, r.name));

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
            {open.map((r) => (
              <option key={r.name} value={r.name}>{r.displayName}</option>
            ))}
            {locked.length > 0 && (
              <optgroup label="Not researched yet">
                {locked.map((r) => (
                  <option key={r.name} value={r.name} disabled={r.name !== entity.recipe}>{r.displayName}</option>
                ))}
              </optgroup>
            )}
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
      {def.kind === 'inserter' && <InserterFilters entity={entity} onChange={onChange} />}
      {def.kind === 'splitter' && <SplitterSettings entity={entity} onChange={onChange} />}
      {REQUESTER_CHESTS.has(def.name) && <ChestRequests entity={entity} onChange={onChange} />}
      {def.kind === 'chest' && <ChestSupply value={entity.recipe} onChange={(recipe) => onChange({ recipe })} />}
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

const ITEMS = Object.values(gameData.items)
  .filter((i) => i.type === 'item')
  .sort((a, b) => a.displayName.localeCompare(b.displayName));

/** A chest can stand in for the rest of the factory: it supplies one item without limit. */
function ChestSupply({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const shown = f ? ITEMS.filter((i) => i.displayName.toLowerCase().includes(f) || i.name === value) : ITEMS;
  return (
    <label>
      Supplies (unlimited, for testing)
      <input type="search" className="recipe-filter" placeholder={`Filter ${ITEMS.length} items`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">(nothing: collects what is put in)</option>
        {shown.map((i) => (
          <option key={i.name} value={i.name}>{i.displayName}</option>
        ))}
      </select>
    </label>
  );
}

/** Chests that hold logistic requests. */
export const REQUESTER_CHESTS = new Set(['requester-chest', 'buffer-chest']);
/** Filter slots on an inserter (filter_count in the game's prototypes). */
export const INSERTER_FILTER_SLOTS = 5;

/** A compact item dropdown with its own text filter. */
function ItemPicker({ value, onChange, label, emptyLabel = '(none)' }: { value?: string; onChange: (v: string | undefined) => void; label: string; emptyLabel?: string }) {
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const shown = f ? ITEMS.filter((i) => i.displayName.toLowerCase().includes(f) || i.name === value) : ITEMS;
  return (
    <span className="item-picker">
      <input type="search" className="recipe-filter" placeholder="Filter" aria-label={`Filter items for ${label}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <select value={value ?? ''} aria-label={label} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{emptyLabel}</option>
        {shown.map((i) => (
          <option key={i.name} value={i.name}>{i.displayName}</option>
        ))}
      </select>
    </span>
  );
}

type Patch = (patch: Partial<PlacedEntity>) => void;

function InserterFilters({ entity, onChange }: { entity: PlacedEntity; onChange: Patch }) {
  const filters = entity.filters ?? [];
  const set = (i: number, name?: string) => {
    const next = [...filters];
    if (name) next[i] = name;
    else next.splice(i, 1);
    const clean = next.filter(Boolean);
    onChange({ filters: clean.length ? clean : undefined, filterMode: clean.length ? entity.filterMode : undefined });
  };
  const rows = Math.min(INSERTER_FILTER_SLOTS, filters.length + 1);
  return (
    <div className="filters">
      <span>Filters (blueprint only, rates ignore them)</span>
      {Array.from({ length: rows }, (_, i) => (
        <ItemPicker key={`${i}:${filters[i] ?? ''}`} label={`Filter ${i + 1}`} value={filters[i]} onChange={(v) => set(i, v)} emptyLabel={i < filters.length ? '(none)' : '(add filter)'} />
      ))}
      {filters.length > 0 && (
        <label className="toggle">
          <input type="checkbox" checked={entity.filterMode === 'blacklist'} onChange={(e) => onChange({ filterMode: e.target.checked ? 'blacklist' : undefined })} /> Deny list (move everything else)
        </label>
      )}
    </div>
  );
}

function SplitterSettings({ entity, onChange }: { entity: PlacedEntity; onChange: Patch }) {
  const side = (v: string) => (v === 'left' || v === 'right' ? v : undefined);
  return (
    <div className="filters">
      <label>
        Input priority
        <select value={entity.inputPriority ?? ''} onChange={(e) => onChange({ inputPriority: side(e.target.value) })}>
          <option value="">None</option>
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
      </label>
      <label>
        Output priority
        <select
          value={entity.outputPriority ?? ''}
          onChange={(e) => {
            const v = side(e.target.value);
            onChange(v ? { outputPriority: v } : { outputPriority: undefined, filters: undefined });
          }}
        >
          <option value="">None</option>
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
      </label>
      {entity.outputPriority && (
        <label>
          Filter (sends this item to the {entity.outputPriority} side)
          <ItemPicker label="Splitter filter" value={entity.filters?.[0]} onChange={(v) => onChange({ filters: v ? [v] : undefined })} />
        </label>
      )}
      <span className="muted small">Left and right as seen facing the way items travel. Kept in blueprints; rates assume an even split.</span>
    </div>
  );
}

function ChestRequests({ entity, onChange }: { entity: PlacedEntity; onChange: Patch }) {
  const requests = entity.requests ?? [];
  const update = (next: { name: string; count: number }[]) => onChange({ requests: next.length ? next : undefined });
  return (
    <div className="filters">
      <span>Logistic requests</span>
      {requests.map((r, i) => (
        <span className="request-row" key={`${i}:${r.name}`}>
          <ItemPicker
            label={`Request ${i + 1}`}
            value={r.name}
            onChange={(v) => update(v ? requests.map((x, k) => (k === i ? { ...x, name: v } : x)) : requests.filter((_, k) => k !== i))}
          />
          <input
            type="number"
            min={1}
            className="request-count"
            aria-label={`Amount for request ${i + 1}`}
            value={r.count}
            onChange={(e) => {
              const n = Math.max(1, Math.floor(Number(e.target.value) || 1));
              update(requests.map((x, k) => (k === i ? { ...x, count: n } : x)));
            }}
          />
        </span>
      ))}
      <ItemPicker
        key={requests.length}
        label="Add request"
        emptyLabel="(add request)"
        onChange={(v) => v && update([...requests, { name: v, count: gameData.items[v]?.stackSize ?? 1 }])}
      />
    </div>
  );
}
