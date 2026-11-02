// What the canvas shows in each view: rate badges, and the extra drawing for
// the electric and logistics views.

import type { EntityRate, EntityStatus, SteadyStateResult } from '../calc';
import type { EntityKind } from '../data/types';
import { gameData } from '../data';
import { ENTITIES } from './catalog';
import type { PlacedEntity } from './model';
import { formatWatts, isElectricConsumer, isGenerator, type PowerReport } from './power';
import type { PoleInfo } from './power';
import type { ViewOverlay } from './renderer';

export type ViewMode = 'normal' | 'electric' | 'logistics';

const LOGISTIC_KINDS = new Set<EntityKind>([
  'belt', 'underground-belt', 'splitter', 'inserter', 'chest', 'pipe', 'pipe-to-ground', 'pump', 'storage-tank', 'offshore-pump',
]);
export const isLogistic = (kind?: EntityKind) => !!kind && LOGISTIC_KINDS.has(kind);

const DIRS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Network colours for pole supply areas. */
const NETWORK_COLORS = [0x4fa3ff, 0xffb347, 0xb48cff, 0x5fd38d, 0xff7aa8, 0x7ad7e6];
const STATUS_COLOR = { powered: 0x4cd964, low: 0xffcc00, 'no-power': 0xff4d4d, unconnected: 0xff4d4d } as const;

export function fmtRate(perMinute: number): string {
  const a = Math.abs(perMinute);
  if (a >= 1000) return `${+(perMinute / 1000).toFixed(1)}k`;
  if (a >= 100) return String(Math.round(perMinute));
  if (a >= 10) return String(+perMinute.toFixed(1));
  return String(+perMinute.toFixed(2));
}

export const displayNameOf = (name: string) =>
  name === 'electricity' ? 'Electricity' : (gameData.items[name]?.displayName ?? gameData.resources[name]?.displayName ?? name);

export function buildBadges(
  mode: ViewMode,
  entities: readonly PlacedEntity[],
  rates: Record<string, EntityRate>,
  sim?: SteadyStateResult | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entities) {
    const def = ENTITIES[e.name];
    const state = mode === 'logistics' ? sim?.entities[e.id] : undefined;
    const r = state?.rate ?? rates[e.id];
    if (!def || !r) continue;
    if (mode === 'electric') {
      if (isGenerator(def) && r.powerW < 0) out[e.id] = `+${formatWatts(-r.powerW)}`;
      else if (isElectricConsumer(def) && r.powerW > 0 && def.width * def.height > 1) out[e.id] = formatWatts(r.powerW);
      continue;
    }
    if (isGenerator(def)) {
      if (mode === 'normal' && r.powerW < 0) out[e.id] = formatWatts(-r.powerW);
      continue;
    }
    const outputs = r.outputs.filter((o) => o.name !== 'electricity');
    if (!outputs.length || def.width * def.height <= 1) continue;
    if (mode === 'logistics') {
      const inSum = r.inputs.reduce((s, f) => s + f.perSecond, 0) * 60;
      const outSum = outputs.reduce((s, f) => s + f.perSecond, 0) * 60;
      const pct = state ? ` · ${Math.round(state.activity * 100)}%` : '';
      out[e.id] = (inSum > 0 ? `in ${fmtRate(inSum)} · out ${fmtRate(outSum)}/min` : `out ${fmtRate(outSum)}/min`) + pct;
    } else {
      out[e.id] = `${fmtRate(outputs[0].perSecond * 60)}/min`;
    }
  }
  return out;
}

export interface OverlayOptions {
  /** A pole being placed (or selected): show its area and the wires it would make. */
  polePreview?: PoleInfo | null;
  /** Show every pole's supply area even in the normal view. */
  showPoleAreas?: boolean;
  /** Draw wires between poles (user toggle). */
  showWires?: boolean;
  /** Steady-state simulation, for the logistics view. */
  sim?: SteadyStateResult | null;
}

export const STATUS_COLORS: Record<EntityStatus, number> = {
  working: 0x4cd964,
  starved: 0xffcc00,
  'output-blocked': 0xff9a3c,
  'low-power': 0xffcc00,
  'no-power': 0xff4d4d,
  'no-recipe': 0x888888,
  idle: 0x6f8fa8,
};

export const STATUS_LABELS: Record<EntityStatus, string> = {
  working: 'Working',
  starved: 'Starved: an input arrives too slowly',
  'output-blocked': 'Output blocked: products are not taken away fast enough',
  'low-power': 'Low power',
  'no-power': 'No power',
  'no-recipe': 'No recipe set',
  idle: 'Idle: nothing uses its output',
};

/** Green below 70% load, yellow up to 99%, red when full. */
export function loadColor(utilization: number): number {
  if (utilization >= 0.99) return 0xff4d4d;
  if (utilization >= 0.7) return 0xffcc00;
  if (utilization > 0) return 0x4cd964;
  return 0x555555;
}

const WIRE_COLOR = 0xff9a3c;
const poleDots = (power: PowerReport) => power.poles.map((p) => ({ x: p.cx, y: p.cy, color: WIRE_COLOR, r: 3 }));

/** Red/yellow lightning markers on machines that lack power, shown in every view. */
function powerMarkers(power: PowerReport) {
  return Object.entries(power.status)
    .filter(([, s]) => s !== 'powered')
    .map(([id, s]) => ({ id, color: s === 'low' ? 0xffcc00 : 0xff4d4d }));
}

/** Wires as lines between pole centres. */
function wireLines(power: PowerReport, width: number) {
  const byId = new Map(power.poles.map((p) => [p.id, p]));
  return power.wires.map(([a, b]) => {
    const pa = byId.get(a)!;
    const pb = byId.get(b)!;
    return { x1: pa.cx, y1: pa.cy, x2: pb.cx, y2: pb.cy, color: WIRE_COLOR, width };
  });
}

/** Ghost wires from a pole preview to every existing pole in reach. */
function previewLines(power: PowerReport, pole: PoleInfo) {
  return power.poles
    .filter((p) => p.id !== pole.id && (p.cx - pole.cx) ** 2 + (p.cy - pole.cy) ** 2 <= Math.min(p.reach, pole.reach) ** 2 + 1e-9)
    .map((p) => ({ x1: pole.cx, y1: pole.cy, x2: p.cx, y2: p.cy, color: 0x9be37a, width: 3 }));
}

export function buildViewOverlay(mode: ViewMode, entities: readonly PlacedEntity[], power: PowerReport, opts: OverlayOptions = {}): ViewOverlay {
  const preview = opts.polePreview;
  const wires = opts.showWires !== false;
  const markers = powerMarkers(power);
  if (mode === 'normal') {
    const lines = wires ? wireLines(power, 2) : [];
    const areas = opts.showPoleAreas ? power.poles.map((p) => ({ ...p.area, color: 0x4fa3ff, alpha: 0.14 })) : [];
    if (preview) {
      areas.push({ ...preview.area, color: 0x9be37a, alpha: 0.22 });
      lines.push(...previewLines(power, preview));
    }
    return { areas, lines, dots: wires ? poleDots(power) : [], markers };
  }
  const dim = new Set<string>();
  if (mode === 'electric') {
    const poleNet = new Map<string, number>();
    power.networks.forEach((n) => n.poles.forEach((p) => poleNet.set(p, n.id)));
    const areas = power.poles.map((p) => ({ ...p.area, color: NETWORK_COLORS[(poleNet.get(p.id) ?? 0) % NETWORK_COLORS.length], alpha: 0.13 }));
    const lines = wires ? wireLines(power, 2.5) : [];
    if (preview) {
      areas.push({ ...preview.area, color: 0x9be37a, alpha: 0.2 });
      lines.push(...previewLines(power, preview));
    }
    const tints: ViewOverlay['tints'] = [];
    for (const e of entities) {
      const def = ENTITIES[e.name];
      const status = power.status[e.id];
      if (status) tints.push({ id: e.id, color: STATUS_COLOR[status], alpha: status === 'powered' ? 0.3 : 0.45 });
      else if (isGenerator(def)) tints.push({ id: e.id, color: 0x4fa3ff, alpha: 0.35 });
      else if (def?.kind !== 'pole' && def?.kind !== 'accumulator') dim.add(e.id);
    }
    return { areas, lines, tints, dim, dots: wires ? poleDots(power) : [], markers };
  }
  // logistics: fade power gear, colour machines by simulated status and
  // belts/inserters by how full they run, and draw inserter hand paths.
  const lines: NonNullable<ViewOverlay['lines']> = [];
  const tints: NonNullable<ViewOverlay['tints']> = [];
  const sim = opts.sim;
  for (const e of entities) {
    const def = ENTITIES[e.name];
    const k = def?.kind;
    if (k === 'pole' || k === 'solar-panel' || k === 'accumulator' || k === 'generator' || k === 'steam-turbine' || k === 'beacon') {
      dim.add(e.id);
      continue;
    }
    const t = sim?.transport[e.id];
    const st = sim?.entities[e.id];
    if (t) tints.push({ id: e.id, color: loadColor(t.utilization), alpha: 0.55 });
    else if (st && st.status !== 'no-recipe') tints.push({ id: e.id, color: STATUS_COLORS[st.status], alpha: 0.35 });
    if (k === 'inserter') {
      const reach = e.name.includes('long-handed') ? 2 : 1;
      const [dx, dy] = DIRS[e.direction];
      const cx = e.x + 0.5;
      const cy = e.y + 0.5;
      lines.push({ x1: cx - dx * reach, y1: cy - dy * reach, x2: cx + dx * reach, y2: cy + dy * reach, color: 0x7dff9a, width: 2 });
    }
  }
  return { dim, lines, tints, markers };
}
