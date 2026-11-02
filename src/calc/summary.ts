// Summaries of a steady-state result: what a group of buildings takes in and
// gives out as built, and a ranked list of what holds the layout back.

import { sumFlows, type Flow } from './flow';
import type { PlacedEntity } from './layout';
import type { EntityStatus, SteadyStateResult } from './steady-state';
import { ELECTRICITY } from './machine';

export interface GroupFlows {
  /** Net per-second balance of the group's machines: + made, − used. */
  net: Flow[];
  /** Electric demand of the group's machines at the activity found, in W. */
  powerW: number;
  /** Machines in the group, and how many of them run below full speed. */
  machines: number;
  slowed: number;
}

/** Net flows of these buildings (all of them when ids is omitted), as built. */
export function groupFlows(sim: SteadyStateResult, ids?: Iterable<string>): GroupFlows {
  const pick = ids ? [...ids] : Object.keys(sim.entities);
  const flows: Flow[] = [];
  let powerW = 0;
  let machines = 0;
  let slowed = 0;
  for (const id of pick) {
    const s = sim.entities[id];
    if (!s || s.status === 'no-recipe') continue;
    machines++;
    if (s.activity < 0.999) slowed++;
    powerW += s.rate.powerW;
    for (const f of s.rate.outputs) if (f.name !== ELECTRICITY) flows.push(f);
    for (const f of s.rate.inputs) if (f.name !== ELECTRICITY) flows.push({ name: f.name, perSecond: -f.perSecond });
  }
  return { net: sumFlows(flows, 1e-6).sort((a, b) => b.perSecond - a.perSecond), powerW, machines, slowed };
}

export type BottleneckKind = 'missing' | 'starved' | 'output-blocked' | 'power' | 'transport';

export interface Bottleneck {
  kind: BottleneckKind;
  /** Building name (entity) and recipe it runs, or the item a transport carries. */
  entity: string;
  recipe?: string;
  /** Item(s) concerned: missing inputs, or what a full belt/inserter carries. */
  items: string[];
  ids: string[];
  /** Machine-equivalents of speed lost (sum of 1 − activity); 0 for transports. */
  lost: number;
}

const SLOW: Partial<Record<EntityStatus, BottleneckKind>> = {
  starved: 'starved',
  'output-blocked': 'output-blocked',
  'low-power': 'power',
  'no-power': 'power',
};

/**
 * What holds the layout back, worst first. Machines are grouped by building,
 * recipe and reason. Belts and inserters running full are listed when they
 * carry something a starved machine is short of, since those are the likely
 * cause; a full belt feeding an output-blocked line is not a problem.
 */
export function bottlenecks(sim: SteadyStateResult, entities: readonly PlacedEntity[]): Bottleneck[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const groups = new Map<string, Bottleneck>();
  const add = (key: string, b: Omit<Bottleneck, 'ids' | 'lost'>, id: string, lost: number) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ...b, ids: [], lost: 0 }));
    g.ids.push(id);
    g.lost += lost;
  };

  const shortOf = new Set<string>();
  for (const [id, s] of Object.entries(sim.entities)) {
    const e = byId.get(id);
    if (!e) continue;
    if (s.missing?.length) {
      add(`missing|${e.name}|${e.recipe}|${s.missing.join(',')}`, { kind: 'missing', entity: e.name, recipe: e.recipe, items: s.missing }, id, 1 - s.activity);
      continue;
    }
    const kind = SLOW[s.status];
    if (!kind) continue;
    if (kind === 'starved') {
      // Inputs other than power; the full-speed amounts aren't kept, but any of them may be short.
      for (const f of s.rate.inputs) if (f.name !== ELECTRICITY) shortOf.add(f.name);
    }
    add(`${kind}|${e.name}|${e.recipe}`, { kind, entity: e.name, recipe: e.recipe, items: [] }, id, 1 - s.activity);
  }

  for (const [id, t] of Object.entries(sim.transport)) {
    if (t.utilization < 0.99 || t.perSecond <= 0) continue;
    const e = byId.get(id);
    if (!e) continue;
    const items = t.items.map((f) => f.name).filter((n) => shortOf.has(n));
    if (!items.length) continue;
    add(`transport|${e.name}|${items.join(',')}`, { kind: 'transport', entity: e.name, items }, id, 0);
  }

  const order: Record<BottleneckKind, number> = { missing: 0, power: 1, starved: 2, transport: 3, 'output-blocked': 4 };
  return [...groups.values()]
    .filter((g) => g.kind === 'transport' || g.lost > 1e-3)
    .sort((a, b) => order[a.kind] - order[b.kind] || b.lost - a.lost || b.ids.length - a.ids.length);
}
