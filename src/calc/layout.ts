import type { Entity, GameData } from '../data/types';
import type { BeaconInfluence } from './effects';
import { sumFlows, type Flow } from './flow';
import { machineRate, type EntityRate } from './machine';
import { researchBonuses, type ResearchState } from './research';

/**
 * Structural copy of the editor's placed entity (src/editor/model.ts), so the
 * engine doesn't depend on the editor.
 */
export interface PlacedEntity {
  id: string;
  /** Entity prototype name. */
  name: string;
  /** Top-left tile. */
  x: number;
  y: number;
  /** 0 N, 1 E, 2 S, 3 W. */
  direction: 0 | 1 | 2 | 3;
  /** Crafting recipe, or for a mining drill the resource it mines. */
  recipe?: string;
  modules?: string[];
  /** Inserters: item filters. Splitters: the first entry is the filter item. */
  filters?: string[];
  /** Inserters: filters exclude instead of allow. */
  filterMode?: 'blacklist';
  /** Splitters: preferred input and output side, seen facing the way items travel. */
  inputPriority?: 'left' | 'right';
  outputPriority?: 'left' | 'right';
}

export interface LayoutLike {
  entities: readonly PlacedEntity[];
}

export interface LayoutTotals {
  /** Sum of all machine outputs minus inputs, per item (positive = made). */
  net: Flow[];
  /** Electric demand in W (machines only, generators not subtracted). */
  powerDemandW: number;
  /** Electric supply in W from generators and solar. */
  powerSupplyW: number;
  fuelW: number;
}

/** Default supply reach when the data has no value (base 2.0 beacon reaches 3 tiles). */
const DEFAULT_BEACON_REACH = 3;

interface Rect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

function footprint(p: PlacedEntity, e: Entity): Rect {
  const rotated = p.direction === 1 || p.direction === 3;
  const w = rotated ? e.height : e.width;
  const h = rotated ? e.width : e.height;
  return { x0: p.x, y0: p.y, x1: p.x + w, y1: p.y + h };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Kinds a beacon can affect. */
const BEACON_TARGETS = new Set(['assembler', 'furnace', 'chemical-plant', 'refinery', 'centrifuge', 'rocket-silo', 'lab', 'mining-drill']);

/** Beacons whose supply area overlaps each machine, keyed by entity id. */
export function beaconsByEntity(data: GameData, layout: LayoutLike): Map<string, BeaconInfluence[]> {
  const beacons: { area: Rect; influence: BeaconInfluence }[] = [];
  for (const p of layout.entities) {
    const e = data.entities[p.name];
    if (e?.kind !== 'beacon') continue;
    const r = footprint(p, e);
    const d = e.supplyAreaDistance ?? DEFAULT_BEACON_REACH;
    beacons.push({
      area: { x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d },
      influence: { beacon: p.name, modules: p.modules ?? [] },
    });
  }
  const result = new Map<string, BeaconInfluence[]>();
  if (beacons.length === 0) return result;
  for (const p of layout.entities) {
    const e = data.entities[p.name];
    if (!e || !BEACON_TARGETS.has(e.kind)) continue;
    const r = footprint(p, e);
    const hits = beacons.filter((b) => overlaps(b.area, r)).map((b) => b.influence);
    if (hits.length > 0) result.set(p.id, hits);
  }
  return result;
}

/**
 * Rate of every placed entity at full speed, keyed by entity id. Beacons are
 * found from positions. Doesn't model starvation; that's the flow graph's job.
 */
export function computeLayoutRates(
  layout: LayoutLike,
  data: GameData,
  research: ResearchState = {},
): Record<string, EntityRate> {
  const bonuses = researchBonuses(data, research);
  const beacons = beaconsByEntity(data, layout);
  const out: Record<string, EntityRate> = {};
  for (const p of layout.entities) {
    out[p.id] = machineRate(
      data,
      { entity: p.name, recipe: p.recipe, modules: p.modules, beacons: beacons.get(p.id) ?? [] },
      bonuses,
    );
  }
  return out;
}

/** Whole-layout totals from per-entity rates. */
export function layoutTotals(rates: Record<string, EntityRate>): LayoutTotals {
  const flows: Flow[] = [];
  let powerDemandW = 0;
  let powerSupplyW = 0;
  let fuelW = 0;
  for (const r of Object.values(rates)) {
    for (const o of r.outputs) if (o.name !== 'electricity') flows.push(o);
    for (const i of r.inputs) flows.push({ name: i.name, perSecond: -i.perSecond });
    if (r.powerW > 0) powerDemandW += r.powerW;
    else powerSupplyW -= r.powerW;
    fuelW += r.fuelW;
  }
  return { net: sumFlows(flows), powerDemandW, powerSupplyW, fuelW };
}
