// Electric networks for the layout: which poles are wired together, what each
// pole's supply area covers, and whether every machine gets enough power.
// Pure functions so they can be tested without a canvas.

import type { EntityRate } from '../calc';
import type { Entity } from '../data/types';
import { ENTITIES } from './catalog';
import { entityRect, type PlacedEntity } from './model';

export interface Area {
  x0: number;
  y0: number;
  x1: number; // exclusive, may be fractional for poles with x.5 reach
  y1: number;
}

export interface PoleInfo {
  id: string;
  cx: number;
  cy: number;
  area: Area;
  reach: number;
}

export interface PowerNetwork {
  id: number;
  poles: string[];
  /** Electric production capacity in W (generators, solar averaged). */
  supplyW: number;
  /** Electric demand in W at full speed. */
  demandW: number;
  /** Fraction of demand that can be met, 0..1 (1 when nothing draws power). */
  satisfaction: number;
  generators: string[];
  consumers: string[];
}

export type PowerStatus = 'powered' | 'low' | 'no-power' | 'unconnected';

export interface PowerReport {
  poles: PoleInfo[];
  wires: [string, string][];
  networks: PowerNetwork[];
  /** Status of every electric consumer, keyed by entity id. */
  status: Record<string, PowerStatus>;
  /** Network each covered electric entity belongs to. */
  networkOf: Record<string, number>;
  /** Totals over all networks plus unconnected machines. */
  totalSupplyW: number;
  totalDemandW: number;
  unconnectedDemandW: number;
}

const isPole = (e?: Entity) => e?.kind === 'pole';

/** Generators feed the grid; accumulators are buffers and are counted as neither. */
export const isGenerator = (e?: Entity) => !!e && (e.kind === 'generator' || e.kind === 'steam-turbine' || e.kind === 'solar-panel');

/** Anything that takes electricity from the grid. */
export const isElectricConsumer = (e?: Entity) =>
  !!e && e.energySource === 'electric' && !isGenerator(e) && e.kind !== 'accumulator' && e.kind !== 'pole';

function overlaps(a: Area, b: Area) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

export function poleInfo(p: PlacedEntity): PoleInfo | null {
  const def = ENTITIES[p.name];
  if (!isPole(def)) return null;
  const r = entityRect(p);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const d = def.supplyAreaDistance ?? 2.5;
  return { id: p.id, cx, cy, reach: def.wireReach ?? 7.5, area: { x0: cx - d, y0: cy - d, x1: cx + d, y1: cy + d } };
}

export function analysePower(entities: readonly PlacedEntity[], rates: Record<string, EntityRate>): PowerReport {
  const poles = entities.map(poleInfo).filter((p): p is PoleInfo => p !== null);

  // Wire poles that are within reach of each other (the game auto-connects
  // to nearby poles; we connect to all in reach, which gives the same networks).
  const parent = new Map(poles.map((p) => [p.id, p.id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  const wires: [string, string][] = [];
  for (let i = 0; i < poles.length; i++)
    for (let j = i + 1; j < poles.length; j++) {
      const a = poles[i];
      const b = poles[j];
      const reach = Math.min(a.reach, b.reach);
      if ((a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2 <= reach * reach + 1e-9) {
        wires.push([a.id, b.id]);
        parent.set(find(a.id), find(b.id));
      }
    }

  const netIndex = new Map<string, number>();
  const networks: PowerNetwork[] = [];
  for (const p of poles) {
    const root = find(p.id);
    if (!netIndex.has(root)) {
      netIndex.set(root, networks.length);
      networks.push({ id: networks.length, poles: [], supplyW: 0, demandW: 0, satisfaction: 1, generators: [], consumers: [] });
    }
    networks[netIndex.get(root)!].poles.push(p.id);
  }

  const networkOf: Record<string, number> = {};
  const status: Record<string, PowerStatus> = {};
  let unconnectedDemandW = 0;

  for (const e of entities) {
    const def = ENTITIES[e.name];
    const gen = isGenerator(def);
    const consumer = isElectricConsumer(def);
    if (!gen && !consumer && def?.kind !== 'accumulator') continue;
    const r = entityRect(e);
    const box = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
    // A machine belongs to the first network whose pole covers any of its tiles.
    const pole = poles.find((p) => overlaps(p.area, box));
    const power = rates[e.id]?.powerW ?? 0;
    if (!pole) {
      if (consumer) {
        status[e.id] = 'unconnected';
        unconnectedDemandW += Math.max(0, power);
      }
      continue;
    }
    const net = networks[netIndex.get(find(pole.id))!];
    networkOf[e.id] = net.id;
    if (gen) {
      net.supplyW += Math.max(0, -power);
      net.generators.push(e.id);
    } else if (consumer) {
      net.demandW += Math.max(0, power);
      net.consumers.push(e.id);
    }
  }

  for (const n of networks) n.satisfaction = n.demandW <= 0 ? 1 : Math.min(1, n.supplyW / n.demandW);
  for (const n of networks)
    for (const id of n.consumers) status[id] = n.supplyW <= 0 ? 'no-power' : n.satisfaction < 0.999 ? 'low' : 'powered';

  return {
    poles,
    wires,
    networks,
    status,
    networkOf,
    totalSupplyW: networks.reduce((s, n) => s + n.supplyW, 0),
    totalDemandW: networks.reduce((s, n) => s + n.demandW, 0) + unconnectedDemandW,
    unconnectedDemandW,
  };
}

export function formatWatts(w: number): string {
  const a = Math.abs(w);
  if (a >= 1e9) return `${+(w / 1e9).toFixed(2)} GW`;
  if (a >= 1e6) return `${+(w / 1e6).toFixed(2)} MW`;
  if (a >= 1e3) return `${+(w / 1e3).toFixed(1)} kW`;
  return `${Math.round(w)} W`;
}
