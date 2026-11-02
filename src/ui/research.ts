// Research settings the user picks in the research panel, and how they turn
// into the engine's ResearchState ({ techName: levelsResearched }).

import { useCallback, useEffect, useState } from 'react';
import type { GameData, Technology } from '../data/types';
import type { ResearchState } from '../calc';

export interface ResearchSettings {
  /**
   * When false, every recipe and building is available (no rate bonuses
   * implied). When true, only techs in `unlocked` (and their prerequisites)
   * are researched: a real greenfield start.
   */
  lockUnlocks: boolean;
  /** Researched non-bonus techs, used when lockUnlocks is on. */
  unlocked: string[];
  /** Level per bonus family (see bonusFamilies), e.g. { 'mining-productivity': 5 }. */
  levels: Record<string, number>;
}

export const DEFAULT_SETTINGS: ResearchSettings = { lockUnlocks: false, unlocked: [], levels: {} };

/** A chain of rate-changing techs, e.g. mining productivity 1, 2, 3, 4 (infinite). */
export interface BonusFamily {
  id: string;
  label: string;
  /** Finite techs in level order. */
  steps: Technology[];
  /** Infinite tech that continues the chain, if any. */
  infinite?: Technology;
  /** Highest level selectable (Infinity when there's an infinite tech). */
  max: number;
  /** What one level does, for the panel. */
  describe: (level: number) => string;
}

const familyId = (name: string) => name.replace(/-\d+$/, '');
const numberOf = (name: string) => Number(/-(\d+)$/.exec(name)?.[1] ?? 0);

export function bonusFamilies(data: GameData): BonusFamily[] {
  const groups = new Map<string, Technology[]>();
  for (const t of Object.values(data.technologies)) {
    if (!t.affectsRates) continue;
    // The bulk inserter tech belongs with the capacity bonuses.
    const id = t.name === 'bulk-inserter' ? 'inserter-capacity-bonus' : familyId(t.name);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = []));
    g.push(t);
  }
  const families: BonusFamily[] = [];
  for (const [id, techs] of groups) {
    techs.sort((a, b) => (a.name === 'bulk-inserter' ? -1 : b.name === 'bulk-inserter' ? 1 : numberOf(a.name) - numberOf(b.name)));
    const infinite = techs.find((t) => t.maxLevel === 'infinite');
    const steps = techs.filter((t) => t !== infinite);
    const label = (steps[0] ?? infinite)!.displayName.replace(/\s*\d+$/, '');
    families.push({
      id,
      label: id === 'inserter-capacity-bonus' ? 'Inserter capacity bonus (incl. bulk inserter)' : label,
      steps,
      infinite,
      max: infinite ? Infinity : steps.length,
      describe: (level) => describeFamily(data, id, steps, infinite, level),
    });
  }
  return families.sort((a, b) => a.label.localeCompare(b.label));
}

function describeFamily(data: GameData, id: string, steps: Technology[], infinite: Technology | undefined, level: number): string {
  const state = familyState(steps, infinite, level);
  let mining = 0;
  let lab = 0;
  let stack = 0;
  let bulk = 0;
  for (const [name, l] of Object.entries(state)) {
    for (const e of data.technologies[name]?.effects ?? []) {
      if (e.type === 'mining-drill-productivity-bonus') mining += e.modifier * l;
      if (e.type === 'laboratory-speed') lab += e.modifier * l;
      if (e.type === 'inserter-stack-size-bonus') stack += e.modifier * l;
      if (e.type === 'bulk-inserter-capacity-bonus') bulk += e.modifier * l;
    }
  }
  const pct = (v: number) => `+${Math.round(v * 100)}%`;
  if (id.startsWith('mining-productivity')) return `${pct(mining)} drill output`;
  if (id.startsWith('research-speed')) return `${pct(lab)} lab speed`;
  if (id.startsWith('inserter-capacity')) return `hand size ${1 + stack} (bulk ${1 + bulk})`;
  return '';
}

/** Techs and levels for one family at a chosen level. */
function familyState(steps: Technology[], infinite: Technology | undefined, level: number): ResearchState {
  const state: ResearchState = {};
  steps.slice(0, Math.max(0, level)).forEach((t) => (state[t.name] = 1));
  if (infinite && level > steps.length) state[infinite.name] = level - steps.length;
  return state;
}

/** Every prerequisite of these techs, the techs included. */
export function withPrerequisites(data: GameData, names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...names];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n) || !data.technologies[n]) continue;
    out.add(n);
    stack.push(...data.technologies[n]!.prerequisites);
  }
  return out;
}

/** Techs that (directly or not) need this one. */
export function dependents(data: GameData, name: string): Set<string> {
  const out = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of Object.values(data.technologies)) {
      if (out.has(t.name)) continue;
      if (t.prerequisites.some((p) => p === name || out.has(p))) {
        out.add(t.name);
        changed = true;
      }
    }
  }
  return out;
}

export function toResearchState(data: GameData, s: ResearchSettings): ResearchState {
  const state: ResearchState = {};
  if (!s.lockUnlocks) {
    for (const t of Object.values(data.technologies)) if (!t.affectsRates) state[t.name] = 1;
  } else {
    for (const name of withPrerequisites(data, s.unlocked)) if (!data.technologies[name]!.affectsRates) state[name] = 1;
  }
  for (const f of bonusFamilies(data)) Object.assign(state, familyState(f.steps, f.infinite, s.levels[f.id] ?? 0));
  return state;
}

const STORAGE_KEY = 'factorio-planner.research.v1';

function load(): ResearchSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const v = JSON.parse(raw) as Partial<ResearchSettings>;
    return {
      lockUnlocks: !!v.lockUnlocks,
      unlocked: Array.isArray(v.unlocked) ? v.unlocked.filter((x) => typeof x === 'string') : [],
      levels: v.levels && typeof v.levels === 'object' ? v.levels : {},
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Research settings, remembered in this browser. */
export function useResearchSettings(): [ResearchSettings, (s: ResearchSettings) => void] {
  const [settings, setSettings] = useState<ResearchSettings>(load);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* private mode etc. */
    }
  }, [settings]);
  const set = useCallback((s: ResearchSettings) => setSettings(s), []);
  return [settings, set];
}
