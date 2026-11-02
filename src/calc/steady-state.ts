// Steady-state rates of a built layout: what every machine, belt and inserter
// actually does per second once the build has settled, taking into account
// how things are connected, belt lane and inserter limits, and power.
//
// Per-second averages, not a tick simulation. The layout becomes a flow
// network and a linear program finds the most production it can sustain:
// each machine runs at some fraction (activity) of full speed, items move
// along belts, inserters and pipes, and every node conserves items. A machine
// whose outputs can't leave backs up; one whose inputs don't arrive starves.

import { solve, type Coefficients, type Constraint } from 'yalps';
import type { Entity, GameData, Technology } from '../data/types';
import { sumFlows, type Flow } from './flow';
import { beaconsByEntity, type PlacedEntity } from './layout';
import { beltToChest, chestToBelt } from './inserter-belt';
import { ELECTRICITY, machineRate, type EntityRate } from './machine';
import { researchBonuses, type ResearchBonuses, type ResearchState } from './research';

export interface SteadyLayout {
  entities: readonly PlacedEntity[];
  water?: readonly string[];
}

export type EntityStatus =
  | 'working'
  /** Running below full speed because an input doesn't arrive fast enough. */
  | 'starved'
  /** Running below full speed because an output can't be taken away. */
  | 'output-blocked'
  /** Electric network has too little generation. */
  | 'low-power'
  /** Not on any powered electric network. */
  | 'no-power'
  /** Machine has no recipe (or a drill no resource). */
  | 'no-recipe'
  /** Power plant parts with nothing asking for their output. */
  | 'idle';

export interface EntityState {
  /** Fraction of full speed, 0..1. */
  activity: number;
  status: EntityStatus;
  /** Actual per-second rates (full-speed rates × activity). */
  rate: EntityRate;
  /** Inputs that nothing delivers to this machine at all. */
  missing?: string[];
}

export interface TransportState {
  kind: 'belt' | 'underground-belt' | 'splitter' | 'inserter';
  /** Items per second passing through. */
  perSecond: number;
  /** Most it can move per second as built. */
  capacity: number;
  /** Busiest lane's share of its capacity for belts (each lane carries half); otherwise perSecond / capacity. */
  utilization: number;
  items: Flow[];
  /** Belts, undergrounds and splitters: what each lane carries, seen facing the way the belt moves. */
  lanes?: { left: Flow[]; right: Flow[] };
  /** Electric inserters: share of full speed their power network gives (0 when no pole reaches them). Absent at full power. */
  powerShare?: number;
  /** Electric inserters: power drawn at the rate found, drain included, in W. */
  powerW?: number;
}

export interface PowerState {
  /** Electric demand at the activity found, in W. */
  demandW: number;
  /** Generation used, in W. */
  supplyW: number;
  /** Most the generators could give, in W. */
  capacityW: number;
  /** False when the layout has no generators: demand is assumed met from outside. */
  modelled: boolean;
}

export interface SteadyStateResult {
  ok: boolean;
  entities: Record<string, EntityState>;
  transport: Record<string, TransportState>;
  /** Items leaving the layout: open belt ends and chests. */
  outputs: Flow[];
  /** Items taken from supply chests. */
  inputs: Flow[];
  /** Per chest: items put in (stored) and items taken out of a supply chest. Absent on a failed solve. */
  chests?: Record<string, { stored: Flow[]; supplied: Flow[] }>;
  power: PowerState;
  /** What the labs research, when the layout has labs fed with science packs. */
  research?: ResearchProgress;
  warnings: string[];
}

export interface SteadyOptions {
  /** Fuel for burner machines and boilers. Default "coal". */
  fuel?: string;
  /**
   * Technology the labs research, which sets which packs they use and how fast.
   * Default: the most advanced research the packs reaching the labs allow (see researchFor).
   */
  labResearch?: string;
}

export interface ResearchProgress {
  /** Technology being researched. */
  tech: string;
  /** Research units completed per second, all labs together (lab productivity included). */
  unitsPerSecond: number;
  /** Science packs used per second. */
  packs: Flow[];
  /** Other technologies the packs reaching the labs could research. */
  choices: string[];
}

// ---------------------------------------------------------------------------
// Game mechanics

/**
 * Ticks for an inserter's full turn (there and back). The game takes
 * 1 / rotation speed in floating point, truncates it, and rounds an odd count
 * down to even. That gives the 2.0 wiki's 76, 70, 48 and 24 ticks for the
 * burner, ordinary, long-handed and fast/bulk inserters.
 */
export function inserterTicksPerTurn(entity: Entity): number {
  const rot = entity.rotationSpeed ?? 0;
  if (rot <= 0) return Infinity;
  // 1/0.02 is exactly 50 in doubles but the game's float math lands just under.
  const ticks = Math.floor(1 / rot - 1e-9);
  return ticks % 2 === 0 ? ticks : ticks - 1;
}

/**
 * Inserter items per second, chest to chest: the whole hand moves once per
 * full turn. 2.0 wiki: burner 0.79/s, inserter 0.86/s, long-handed 1.25/s,
 * fast 2.5/s, times hand size.
 */
export function inserterThroughput(entity: Entity, bonuses?: ResearchBonuses): number {
  const ticks = inserterTicksPerTurn(entity);
  if (!Number.isFinite(ticks) || ticks <= 0) return 0;
  return (inserterHandSize(entity, bonuses) * 60) / ticks;
}

/**
 * 2.0 fluids: each input or output connection moves at most 100 units per tick
 * (6000/s); within a pipeline segment flow is instant, whatever its length.
 */
export const FLUID_FLOW_LIMIT = 6000;
/**
 * The wiki: "in practice, this limit is usually around 4200 fluid per second",
 * because flow in and out depends on how full the segment is. Above this a
 * connection is warned about, not capped.
 */
export const FLUID_FLOW_PRACTICAL = 4200;
/**
 * A pipeline segment spreading outside a 320×320 tile area stops flowing until
 * a pump splits it (utility-constants default_pipeline_extent = 320; no base
 * entity overrides it).
 */
export const PIPELINE_MAX_EXTENT = 320;

export function inserterHandSize(entity: Entity, bonuses?: ResearchBonuses): number {
  const bonus = entity.bulk ? bonuses?.bulkInserterBonus ?? 0 : bonuses?.inserterStackBonus ?? 0;
  return 1 + bonus;
}

/**
 * Items/s for an inserter between these two things. Chest-to-chest uses the
 * arm-cycle formula; with a belt on either side the wiki's measurements are
 * used (see inserter-belt.ts: dropping on a belt is measured 2.0 data, taking
 * from a belt is derived from 1.1 data).
 */
export function inserterCapacity(inserter: Entity, bonuses: ResearchBonuses | undefined, from?: { e: Entity }, to?: { e: Entity }): number {
  const chest = inserterThroughput(inserter, bonuses);
  const hand = inserterHandSize(inserter, bonuses);
  const cycles = chest / hand;
  let cap = chest;
  // Taking from a belt can beat chest-to-chest (the arm homes in on items), so no min here.
  if (from && BELTS.has(from.e.kind)) cap = beltToChest(inserter, hand, from.e, cycles) ?? chest;
  if (to && BELTS.has(to.e.kind)) cap = Math.min(cap, chestToBelt(inserter, hand, to.e) ?? chest);
  return cap;
}

/** Reach in tiles from the inserter to its pickup and drop tiles. */
export function inserterReach(entity: Entity): number {
  return /long-handed/.test(entity.name) ? 2 : 1;
}

/** Per-lane belt speed is half the belt's throughput; side-loading fills one lane only. */
export const laneThroughput = (entity: Entity) => (entity.beltThroughput ?? 0) / 2;

// ---------------------------------------------------------------------------
// Geometry

type Dir = 0 | 1 | 2 | 3;
/** Belt lanes, seen facing the way the belt moves. */
type Lane = 'L' | 'R';
const LANES: readonly Lane[] = ['L', 'R'];
const otherLane = (l: Lane): Lane => (l === 'L' ? 'R' : 'L');
/** The lane on the given side (a direction) of a belt facing d, if that side is left or right. */
const laneOnSide = (beltDir: Dir, side: Dir): Lane | undefined =>
  side === (beltDir + 3) % 4 ? 'L' : side === (beltDir + 1) % 4 ? 'R' : undefined;
const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;
const key = (x: number, y: number) => `${x},${y}`;
const opposite = (d: Dir) => ((d + 2) % 4) as Dir;

interface Placed {
  p: PlacedEntity;
  e: Entity;
  d: Dir;
  x: number;
  y: number;
  w: number;
  h: number;
}

function place(p: PlacedEntity, e: Entity): Placed {
  const rotated = p.direction === 1 || p.direction === 3;
  return { p, e, d: p.direction, x: p.x, y: p.y, w: rotated ? e.height : e.width, h: rotated ? e.width : e.height };
}

function tilesOf(q: Placed): [number, number][] {
  const out: [number, number][] = [];
  for (let dy = 0; dy < q.h; dy++) for (let dx = 0; dx < q.w; dx++) out.push([q.x + dx, q.y + dy]);
  return out;
}

/** Tiles just outside an entity's edges. */
function neighbourTiles(q: Placed): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < q.w; i++) out.push([q.x + i, q.y - 1], [q.x + i, q.y + q.h]);
  for (let j = 0; j < q.h; j++) out.push([q.x - 1, q.y + j], [q.x + q.w, q.y + j]);
  return out;
}

/** Tile a mining drill drops onto: just beyond the middle of its front edge. */
function drillDropTile(q: Placed): [number, number] {
  const mx = q.x + Math.floor((q.w - 1) / 2);
  const my = q.y + Math.floor((q.h - 1) / 2);
  switch (q.d) {
    case 0: return [mx, q.y - 1];
    case 1: return [q.x + q.w, my];
    case 2: return [mx, q.y + q.h];
    case 3: return [q.x - 1, my];
  }
}

const CRAFTERS = new Set(['assembler', 'furnace', 'chemical-plant', 'refinery', 'centrifuge', 'rocket-silo']);
const MACHINES = new Set([...CRAFTERS, 'mining-drill', 'offshore-pump', 'boiler', 'generator', 'steam-turbine', 'solar-panel']);
const BELTS = new Set(['belt', 'underground-belt', 'splitter']);
// Pumps are not connectors: they join two networks one way, at a limited rate.
const FLUID_CONNECTORS = new Set(['pipe', 'pipe-to-ground', 'storage-tank', 'offshore-pump', 'boiler', 'generator', 'steam-turbine']);
const POWER_PLANT = new Set(['offshore-pump', 'boiler', 'generator', 'steam-turbine']);

// ---------------------------------------------------------------------------
// Flow network

/** Where items can sit: a machine's item port, a belt tile, a splitter, a chest, a lab, or outside. */
type NodeId = string;
const EXIT = 'exit';
/** Objective value of one item per second leaving the layout (machine activity counts 1). */
const OUTPUT_WEIGHT = 1e-2;
/**
 * Objective value of one item per second on a splitter's priority side. Below
 * OUTPUT_WEIGHT (priority never costs output) and well above the 1e-6 per edge
 * flow cost, so the priority side is filled first.
 */
const PRIORITY_WEIGHT = 1e-3;

const allows = (e: Edge, item: string) => (!e.accept || e.accept.has(item)) && !e.reject?.has(item);

/** Which side of a splitter (facing d) a tile is on, seen facing the way items travel. */
function splitterSide(q: Placed, x: number, y: number): 'left' | 'right' {
  const lx = DX[(q.d + 3) % 4]!;
  const ly = DY[(q.d + 3) % 4]!;
  const tiles = tilesOf(q).map(([tx, ty]) => tx * lx + ty * ly);
  return x * lx + y * ly === Math.max(...tiles) ? 'left' : 'right';
}

interface Edge {
  id: string;
  from: NodeId;
  to: NodeId;
  /** Capacity row this edge counts against, if any. */
  capRow?: string | string[];
  /** Items allowed through; undefined = anything. */
  accept?: Set<string>;
  /** Items never allowed through (deny-list filters, a splitter's non-filter side). */
  reject?: Set<string>;
  /** Splitter side this edge leaves from or enters by. */
  split?: { splitter: string; dir: 'in' | 'out'; side: 'left' | 'right' };
  /** Report this edge's flow under this transport entity id. */
  report?: string;
  /** Belt lane this edge leaves from (belt-like sources). */
  lane?: Lane;
}

interface MachineInfo {
  q: Placed;
  rate: EntityRate;
  /** Fuel item per second at full speed (burner machines). */
  fuel?: Flow;
  itemIn: Map<string, number>;
  itemOut: Map<string, number>;
  fluidIn: Map<string, number>;
  fluidOut: Map<string, number>;
  powerNet?: string;
  electric: boolean;
  /** Electric consumers: drain in W, drawn even when the machine stands still. */
  drainW: number;
  weight: number;
}

/** Electric draw of a machine at activity u: drain always (times the network's satisfaction), the rest in proportion. */
function machinePowerW(m: MachineInfo, u: number, share = 1): number {
  return m.drainW * share + (m.rate.powerW - m.drainW) * u;
}

export function simulateLayout(
  layout: SteadyLayout,
  data: GameData,
  research: ResearchState = {},
  options: SteadyOptions = {},
): SteadyStateResult {
  const warnings: string[] = [];
  const bonuses = researchBonuses(data, research);
  const fuelName = options.fuel ?? 'coal';
  const fuelValue = data.items[fuelName]?.fuelValue;

  // --- Place everything --------------------------------------------------
  const placed: Placed[] = [];
  const occ = new Map<string, Placed>();
  for (const p of layout.entities) {
    const e = data.entities[p.name];
    if (!e) {
      warnings.push(`Unknown building ${p.name}`);
      continue;
    }
    const q = place(p, e);
    placed.push(q);
    for (const [x, y] of tilesOf(q)) occ.set(key(x, y), q);
  }
  const at = (x: number, y: number) => occ.get(key(x, y));
  // A beacon no pole reaches gives no effect (only checked when the layout has poles).
  const poles = placed.filter((q) => q.e.kind === 'pole');
  const unpoweredBeacons = new Set(
    poles.length ? placed.filter((q) => q.e.kind === 'beacon' && !poles.some((p) => inSupplyArea(p, q))).map((q) => q.p.id) : [],
  );
  const beacons = beaconsByEntity(data, { ...layout, entities: layout.entities.filter((p) => !unpoweredBeacons.has(p.id)) });

  const edges: Edge[] = [];
  const supplies = new Map<NodeId, string>(); // chest node -> supplied item
  const sinks = new Set<NodeId>(); // nodes that absorb anything (chests)
  const sinkAccept = new Map<NodeId, Set<string>>();
  const transport: Record<string, TransportState> = {};
  const capacities = new Map<string, number>();
  const machines = new Map<string, MachineInfo>();
  const idle = new Map<string, EntityStatus>();

  // --- Machines ----------------------------------------------------------
  for (const q of placed) {
    const kind = q.e.kind;
    if (kind === 'lab') {
      // A lab is a machine whose inputs (packs per second) are set once we know
      // which packs reach it and so what it researches (see below).
      const rate = machineRate(data, { entity: q.e.name, modules: q.p.modules, beacons: beacons.get(q.p.id) ?? [] }, bonuses);
      machines.set(q.p.id, {
        q,
        rate,
        itemIn: new Map(),
        itemOut: new Map(),
        fluidIn: new Map(),
        fluidOut: new Map(),
        electric: q.e.energySource === 'electric' && rate.powerW > 0,
        drainW: q.e.energySource === 'electric' && rate.powerW > 0 ? Math.min(q.e.drain ?? 0, rate.powerW) : 0,
        weight: 1,
      });
      continue;
    }
    if (!MACHINES.has(kind)) continue;
    const needsRecipe = CRAFTERS.has(kind) || kind === 'mining-drill';
    if (needsRecipe && !q.p.recipe) {
      idle.set(q.p.id, 'no-recipe');
      continue;
    }
    const rate = machineRate(
      data,
      { entity: q.e.name, recipe: q.p.recipe, modules: q.p.modules, beacons: beacons.get(q.p.id) ?? [] },
      bonuses,
    );
    const info: MachineInfo = {
      q,
      rate,
      itemIn: new Map(),
      itemOut: new Map(),
      fluidIn: new Map(),
      fluidOut: new Map(),
      electric: q.e.energySource === 'electric' && rate.powerW > 0,
      drainW: q.e.energySource === 'electric' && rate.powerW > 0 ? Math.min(q.e.drain ?? 0, rate.powerW) : 0,
      weight: POWER_PLANT.has(kind) ? -1e-3 : kind === 'solar-panel' ? 1e-6 : 1,
    };
    const isFluid = (n: string) => data.items[n]?.type === 'fluid' || n === 'water' || n === 'steam';
    for (const f of rate.inputs) (isFluid(f.name) ? info.fluidIn : info.itemIn).set(f.name, f.perSecond);
    for (const f of rate.outputs) {
      if (f.name === ELECTRICITY) continue;
      (isFluid(f.name) ? info.fluidOut : info.itemOut).set(f.name, f.perSecond);
    }
    if (rate.fuelW > 0) {
      if (fuelValue) {
        info.fuel = { name: fuelName, perSecond: rate.fuelW / fuelValue };
        info.itemIn.set(fuelName, (info.itemIn.get(fuelName) ?? 0) + info.fuel.perSecond);
      } else warnings.push(`${fuelName} has no fuel value`);
    }
    machines.set(q.p.id, info);
  }

  const machineNode = (id: string) => `m:${id}`;
  const machineAccepts = (id: string) => new Set(machines.get(id)?.itemIn.keys() ?? []);

  // Labs and chests are item stores.
  for (const q of placed) {
    if (q.e.kind === 'chest') {
      const node = `c:${q.p.id}`;
      sinks.add(node);
      if (q.p.recipe) supplies.set(node, q.p.recipe);
    } else if (q.e.kind === 'lab') {
      // The lab's slots: inserters fill them and can take packs on to the next
      // lab; the lab itself uses packs from them.
      const node = `l:${q.p.id}`;
      const packs = new Set(q.e.inputs ?? []);
      sinkAccept.set(node, packs);
      edges.push({ id: `lab:${q.p.id}`, from: node, to: machineNode(q.p.id), accept: packs });
    }
  }

  /** The node an inserter or drill interacts with at a tile, if any. */
  const nodeAt = (x: number, y: number): { node: NodeId; q: Placed } | undefined => {
    const q = at(x, y);
    if (!q) return undefined;
    const k = q.e.kind;
    if (k === 'lab') return { node: `l:${q.p.id}`, q };
    if (machines.has(q.p.id)) return { node: machineNode(q.p.id), q };
    if (k === 'chest') return { node: `c:${q.p.id}`, q };
    if (k === 'belt' || k === 'underground-belt') return { node: `b:${q.p.id}`, q };
    if (k === 'splitter') return { node: `s:${q.p.id}`, q };
    return undefined;
  };

  // --- Belts -------------------------------------------------------------
  // Every belt tile, underground and splitter is two nodes, one per lane:
  // `b:<id>:L` / `b:<id>:R` and `s:<id>:L` / `s:<id>:R`.
  const isBeltNode = (n: NodeId) => n.startsWith('b:') || n.startsWith('s:');
  const undergroundRole = pairUndergrounds(placed, warnings);
  const beltCap = (q: Placed) => q.e.beltThroughput ?? 0;

  /** Belt-like entity at a tile that pushes items into tile (x, y) from behind/side. */
  const feedsInto = (src: Placed, x: number, y: number): boolean => {
    if (src.e.kind === 'belt') return src.x + DX[src.d] === x && src.y + DY[src.d] === y;
    if (src.e.kind === 'underground-belt') return undergroundRole.get(src.p.id)?.role === 'exit' && src.x + DX[src.d] === x && src.y + DY[src.d] === y;
    if (src.e.kind === 'splitter') return tilesOf(src).some(([tx, ty]) => tx + DX[src.d] === x && ty + DY[src.d] === y);
    return false;
  };

  /**
   * Edges from a belt-like source moving direction d out of tile (x, y), one per
   * lane. `cap` is the source's whole-belt throughput; each lane gets half.
   */
  const linkForward = (srcId: string, fromBase: NodeId, x: number, y: number, d: Dir, cap: number) => {
    const tx = x + DX[d];
    const ty = y + DY[d];
    const t = at(tx, ty);
    const laneCap = cap / 2;
    const laneRow = (ln: Lane) => {
      const row = `cap:${srcId}:${x},${y}:${ln}`;
      capacities.set(row, laneCap);
      return row;
    };
    if (!t) {
      for (const ln of LANES) edges.push({ id: `${srcId}>exit@${x},${y}:${ln}`, from: `${fromBase}:${ln}`, to: EXIT, capRow: laneRow(ln), report: srcId, lane: ln });
      return;
    }
    const k = t.e.kind;
    let toBase: NodeId | undefined;
    /** Side-loading: both source lanes go onto this one lane of the target. */
    let onto: Lane | undefined;
    /** Only this source lane gets through (side-loading an underground belt). */
    let only: Lane | undefined;
    // Which side of the target the source is on, seen facing the target's direction.
    const fromSide: Lane = opposite(d) === (t.d + 3) % 4 ? 'L' : 'R';
    if (k === 'belt') {
      if (t.d !== opposite(d)) {
        toBase = `b:${t.p.id}`;
        if (t.d !== d) {
          // Perpendicular: a curve (lanes kept) if nothing feeds the target
          // from behind and this is its only side feeder; otherwise
          // side-loading onto the lane on the source's side.
          const behind = at(t.x - DX[t.d], t.y - DY[t.d]);
          const straightFeed = behind && BELTS.has(behind.e.kind) && feedsInto(behind, t.x, t.y);
          const left = at(t.x + DX[(t.d + 3) % 4]!, t.y + DY[(t.d + 3) % 4]!);
          const right = at(t.x + DX[(t.d + 1) % 4]!, t.y + DY[(t.d + 1) % 4]!);
          const sideFeeds = [left, right].filter((s) => s && BELTS.has(s.e.kind) && feedsInto(s, t.x, t.y)).length;
          if (straightFeed || sideFeeds > 1) onto = fromSide;
        }
      }
    } else if (k === 'underground-belt') {
      const role = undergroundRole.get(t.p.id)?.role;
      if (role === 'entrance' && t.d === d) toBase = `b:${t.p.id}`;
      else if (role && t.d !== d && t.d !== opposite(d)) {
        // Side-loading an underground: only the half of the tile with belt on
        // it takes items, the half with the tunnel hood blocks them (wiki, Belt
        // transport system). So only the source lane over the open half gets
        // through: the upstream half of an entrance, the downstream half of an exit.
        toBase = `b:${t.p.id}`;
        onto = fromSide;
        const openHalf = role === 'entrance' ? opposite(t.d) : t.d;
        only = laneOnSide(d, openHalf);
      }
    } else if (k === 'splitter') {
      if (t.d === d) toBase = `s:${t.p.id}`;
    }
    if (!toBase) return; // dead end: items stop here
    const split = k === 'splitter' ? { splitter: t.p.id, dir: 'in' as const, side: splitterSide(t, tx, ty) } : undefined;
    if (onto) {
      // Both lanes merge onto one lane of the target: that lane's speed limits them together.
      const shared = `cap:onto:${srcId}:${x},${y}`;
      capacities.set(shared, laneThroughput(t.e));
      for (const ln of LANES) {
        if (only && ln !== only) continue;
        edges.push({ id: `${srcId}>${toBase}@${x},${y}:${ln}>${onto}`, from: `${fromBase}:${ln}`, to: `${toBase}:${onto}`, capRow: [laneRow(ln), shared], report: srcId, lane: ln, split });
      }
      return;
    }
    for (const ln of LANES) edges.push({ id: `${srcId}>${toBase}@${x},${y}:${ln}`, from: `${fromBase}:${ln}`, to: `${toBase}:${ln}`, capRow: laneRow(ln), report: srcId, lane: ln, split });
  };

  for (const q of placed) {
    const k = q.e.kind;
    if (k === 'belt') {
      transport[q.p.id] = blankTransport('belt', beltCap(q));
      linkForward(q.p.id, `b:${q.p.id}`, q.x, q.y, q.d, beltCap(q));
    } else if (k === 'underground-belt') {
      transport[q.p.id] = blankTransport('underground-belt', beltCap(q));
      const info = undergroundRole.get(q.p.id);
      if (info?.role === 'entrance' && info.partner) {
        for (const ln of LANES) {
          const capRow = `cap:${q.p.id}:${ln}`;
          capacities.set(capRow, beltCap(q) / 2);
          edges.push({ id: `${q.p.id}>ug:${ln}`, from: `b:${q.p.id}:${ln}`, to: `b:${info.partner}:${ln}`, capRow, report: q.p.id, lane: ln });
        }
      } else if (info?.role === 'exit') {
        linkForward(q.p.id, `b:${q.p.id}`, q.x, q.y, q.d, beltCap(q));
      }
    } else if (k === 'splitter') {
      transport[q.p.id] = blankTransport('splitter', 2 * beltCap(q));
      // A filter sends its item only to the priority side and everything else
      // only to the other side (2.0: the filter needs an output priority).
      const filter = q.p.outputPriority ? q.p.filters?.[0] : undefined;
      for (const [x, y] of tilesOf(q)) {
        const before = edges.length;
        linkForward(q.p.id, `s:${q.p.id}`, x, y, q.d, beltCap(q));
        const side = splitterSide(q, x, y);
        for (const e of edges.slice(before)) {
          e.split = { splitter: q.p.id, dir: 'out', side };
          if (filter) {
            if (side === q.p.outputPriority) e.accept = new Set([filter]);
            else e.reject = new Set([filter]);
          }
        }
      }
    }
  }

  // --- Inserters ---------------------------------------------------------
  const electricInserters: PoweredLink[] = [];
  for (const q of placed) {
    if (q.e.kind !== 'inserter') continue;
    const reach = inserterReach(q.e);
    const pick = nodeAt(q.x - DX[q.d] * reach, q.y - DY[q.d] * reach);
    const drop = nodeAt(q.x + DX[q.d] * reach, q.y + DY[q.d] * reach);
    const capacity = inserterCapacity(q.e, bonuses, pick?.q, drop?.q);
    transport[q.p.id] = blankTransport('inserter', capacity);
    if (!pick || !drop) continue;
    const capRow = `cap:${q.p.id}`;
    capacities.set(capRow, capacity);
    let accept: Set<string> | undefined;
    if (drop.node.startsWith('m:')) accept = machineAccepts(drop.q.p.id);
    else if (sinkAccept.has(drop.node)) accept = sinkAccept.get(drop.node);
    // Filter inserters: an allow list narrows what moves, a deny list blocks items.
    const filters = q.p.filters?.filter(Boolean) ?? [];
    let reject: Set<string> | undefined;
    if (filters.length && q.p.filterMode === 'blacklist') reject = new Set(filters);
    else if (filters.length) accept = new Set(accept ? filters.filter((f) => accept!.has(f)) : filters);
    // Belts: pick from either lane; drop onto the far lane, or onto the belt's
    // right lane when the belt runs toward or away from the inserter (wiki,
    // Inserters).
    const froms = isBeltNode(pick.node) ? LANES.map((ln) => `${pick.node}:${ln}`) : [pick.node];
    let to = drop.node;
    if (isBeltNode(drop.node)) {
      const near = laneOnSide(drop.q.d, opposite(q.d));
      to = `${drop.node}:${near ? otherLane(near) : 'R'}`;
    }
    for (const from of froms) edges.push({ id: `ins:${q.p.id}:${from}`, from, to, capRow, accept, reject, report: q.p.id });
    if (q.e.energySource === 'electric')
      electricInserters.push({ q, capRow, capacity, jPerItem: (q.e.energyPerRotation ?? 0) / inserterHandSize(q.e, bonuses), drainW: q.e.drain ?? 0 });
  }

  // --- Drills drop onto the tile in front ---------------------------------
  for (const [id, m] of machines) {
    if (m.q.e.kind !== 'mining-drill' || m.itemOut.size === 0) continue;
    const [x, y] = drillDropTile(m.q);
    const target = nodeAt(x, y);
    if (!target) continue;
    const accept = target.node.startsWith('m:') ? machineAccepts(target.q.p.id) : undefined;
    if (isBeltNode(target.node)) {
      // The game places drill output just past the drill's edge
      // (vector_to_place_result {0, -1.85} electric, {-0.35, -1.3} burner), so
      // on the near lane of a belt across its front. On a belt running along
      // the drill's facing, the burner drill's offset is to its left; the
      // electric drill's is dead centre, and we assume the belt's right lane.
      const near = laneOnSide(target.q.d, opposite(m.q.d));
      const lane: Lane = near ?? (m.q.e.name === 'burner-mining-drill' ? (target.q.d === m.q.d ? 'L' : 'R') : 'R');
      edges.push({ id: `drop:${id}`, from: machineNode(id), to: `${target.node}:${lane}`, accept });
    } else edges.push({ id: `drop:${id}`, from: machineNode(id), to: target.node, accept });
  }

  // --- Fluids ------------------------------------------------------------
  const fluidNet = buildFluidNetworks(placed, at, machines, warnings);

  // --- Power -------------------------------------------------------------
  const powerNets = buildPowerNetworks(placed, machines);
  // Electric inserters run off the same networks; one no pole reaches never moves.
  const insertersOn = new Map<string, PoweredLink[]>();
  if (powerNets.modelled) {
    for (const link of electricInserters) {
      const net = powerNets.netOf(link.q);
      if (!net) {
        capacities.set(link.capRow, 0);
        transport[link.q.p.id]!.powerShare = 0;
        continue;
      }
      let l = insertersOn.get(net);
      if (!l) insertersOn.set(net, (l = []));
      l.push(link);
    }
  }

  // --- Which items can reach each node ------------------------------------
  const reach = new Map<NodeId, Set<string>>();
  const addReach = (n: NodeId, item: string) => {
    let s = reach.get(n);
    if (!s) reach.set(n, (s = new Set()));
    if (s.has(item)) return false;
    s.add(item);
    return true;
  };
  for (const [id, m] of machines) for (const item of m.itemOut.keys()) addReach(machineNode(id), item);
  for (const [node, item] of supplies) addReach(node, item);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      const src = reach.get(e.from);
      if (!src) continue;
      for (const item of src) {
        if (!allows(e, item)) continue;
        if (e.from.startsWith('m:') && !machines.get(e.from.slice(2))?.itemOut.has(item)) continue;
        if (addReach(e.to, item)) changed = true;
      }
    }
  }

  // --- Labs: what they research -------------------------------------------
  const labs = [...machines.values()].filter((m) => m.q.e.kind === 'lab');
  const packsAtLabs = new Set<string>();
  for (const m of labs) for (const item of reach.get(machineNode(m.q.p.id)) ?? []) packsAtLabs.add(item);
  const labTech = labs.length && packsAtLabs.size ? pickResearch(data, packsAtLabs, options.labResearch) : undefined;
  if (labTech?.cost) {
    for (const m of labs) {
      const cycles = ((m.q.e.researchingSpeed ?? 1) * (1 + m.rate.speedBonus)) / labTech.cost.time;
      m.rate.craftsPerSecond = cycles;
      m.rate.inputs = labTech.cost.ingredients.map((i) => ({ name: i.name, perSecond: i.amount * cycles }));
      for (const f of m.rate.inputs) m.itemIn.set(f.name, f.perSecond);
    }
  } else {
    // Nothing to research: labs stand idle.
    for (const m of labs) {
      machines.delete(m.q.p.id);
      idle.set(m.q.p.id, 'idle');
    }
  }

  // --- Linear program -----------------------------------------------------
  const constraints: Record<string, Constraint> = {};
  const variables: Record<string, Coefficients> = {};
  const balance = (node: NodeId, item: string) => `bal:${node}:${item}`;
  const usedRows = new Set<string>();
  const coef = (v: Record<string, number>, row: string, value: number) => {
    v[row] = (v[row] ?? 0) + value;
    usedRows.add(row);
  };

  // Flow variables.
  const byId = new Map(placed.map((q) => [q.p.id, q]));
  /** The side a splitter prefers in this direction, if set. */
  const splitPriority = (sp: NonNullable<Edge['split']>) => {
    const p = byId.get(sp.splitter)?.p;
    return sp.dir === 'in' ? p?.inputPriority : p?.outputPriority;
  };
  const flowVars: { name: string; edge: Edge; item: string }[] = [];
  for (const e of edges) {
    const items = reach.get(e.from);
    if (!items) continue;
    for (const item of items) {
      if (!allows(e, item)) continue;
      if (e.from.startsWith('m:') && !machines.get(e.from.slice(2))?.itemOut.has(item)) continue;
      const name = `x:${e.id}:${item}`;
      // Items leaving the layout count towards the objective, so supply chests
      // and drills push as much as the build can carry.
      const v: Record<string, number> = { obj: e.to === EXIT ? OUTPUT_WEIGHT : -1e-6 };
      if (e.split && splitPriority(e.split) === e.split.side) v.obj! += PRIORITY_WEIGHT;
      coef(v, balance(e.from, item), -1);
      if (e.to !== EXIT) coef(v, balance(e.to, item), 1);
      for (const row of [e.capRow ?? []].flat()) coef(v, row, 1);
      variables[name] = v;
      flowVars.push({ name, edge: e, item });
    }
  }
  // Inserters draw power for every swing, plus their drain.
  const inserterNet = new Map<string, { net: string; link: PoweredLink }>();
  for (const [net, links] of insertersOn) for (const link of links) inserterNet.set(link.q.p.id, { net, link });
  const inserterFlows = new Map<string, { name: string; j: number }[]>();
  for (const fv of flowVars) {
    const on = fv.edge.id.startsWith('ins:') && fv.edge.report ? inserterNet.get(fv.edge.report) : undefined;
    if (!on) continue;
    coef(variables[fv.name] as Record<string, number>, `pow:${on.net}`, -on.link.jPerItem);
    let l = inserterFlows.get(on.net);
    if (!l) inserterFlows.set(on.net, (l = []));
    l.push({ name: fv.name, j: on.link.jPerItem });
  }
  // Drain: every powered electric consumer draws it, busy or not.
  const drainOf = new Map<string, number>();
  const addDrain = (net: string | undefined, w: number) => {
    if (net && w > 0) drainOf.set(net, (drainOf.get(net) ?? 0) + w);
  };
  for (const [net, links] of insertersOn) for (const l of links) addDrain(net, l.drainW);
  if (powerNets.modelled) {
    for (const m of machines.values()) if (m.electric) addDrain(m.powerNet, m.drainW);
    for (const id of idle.keys()) {
      const q = byId.get(id);
      if (q?.e.energySource === 'electric') addDrain(powerNets.netOf(q), q.e.drain ?? 0);
    }
    // Beacons draw their full power all the time.
    for (const q of placed) if (q.e.kind === 'beacon') addDrain(powerNets.netOf(q), q.e.energyUsage ?? 0);
  }
  for (const [net, w] of drainOf) {
    const v: Record<string, number> = { obj: 1e-6 };
    coef(v, `pow:${net}`, -1);
    coef(v, `cap:drain:${net}`, 1);
    constraints[`cap:drain:${net}`] = { max: w };
    variables[`drain:${net}`] = v;
  }
  /** Power the inserters on a network draw at these values, plus all drain there, in W. */
  const inserterDemand = (vals: Map<string, number>, net: string) => {
    let w = vals.get(`drain:${net}`) ?? 0;
    for (const f of inserterFlows.get(net) ?? []) w += (vals.get(f.name) ?? 0) * f.j;
    return w;
  };

  // Supplies and sinks.
  for (const [node, item] of supplies) {
    const v: Record<string, number> = {};
    coef(v, balance(node, item), 1);
    variables[`supply:${node}`] = v;
  }
  for (const node of sinks) {
    for (const item of reach.get(node) ?? []) {
      if (supplies.get(node) === item) continue;
      const v: Record<string, number> = { obj: OUTPUT_WEIGHT };
      coef(v, balance(node, item), -1);
      variables[`absorb:${node}:${item}`] = v;
    }
  }
  // Machine activity.
  for (const [id, m] of machines) {
    const v: Record<string, number> = { obj: m.weight };
    coef(v, `u:${id}`, 1);
    constraints[`u:${id}`] = { max: 1 };
    for (const [item, r] of m.itemIn) coef(v, balance(machineNode(id), item), -r);
    for (const [item, r] of m.itemOut) coef(v, balance(machineNode(id), item), r);
    // Fluids go through the networks the machine touches.
    const nets = fluidNet.netsOf.get(id) ?? [];
    for (const [fluid, r] of m.fluidIn) {
      coef(v, balance(machineNode(id), fluid), -r);
      for (const net of nets) {
        const name = `xf:${net}>${id}:${fluid}`;
        const capRow = `cap:${name}`;
        variables[name] = { [balance(`f:${net}`, fluid)]: -1, [balance(machineNode(id), fluid)]: 1, [capRow]: 1 };
        constraints[capRow] = { max: fluidNet.dead.has(net) ? 0 : FLUID_FLOW_LIMIT };
        usedRows.add(balance(`f:${net}`, fluid));
      }
    }
    for (const [fluid, r] of m.fluidOut) {
      coef(v, balance(machineNode(id), fluid), r);
      for (const net of nets) {
        const name = `xf:${id}>${net}:${fluid}`;
        const capRow = `cap:${name}`;
        variables[name] = { [balance(`f:${net}`, fluid)]: 1, [balance(machineNode(id), fluid)]: -1, [capRow]: 1 };
        constraints[capRow] = { max: fluidNet.dead.has(net) ? 0 : FLUID_FLOW_LIMIT };
        usedRows.add(balance(`f:${net}`, fluid));
      }
    }
    // Electricity.
    if (powerNets.modelled) {
      if (m.electric) {
        if (m.powerNet) coef(v, `pow:${m.powerNet}`, -(m.rate.powerW - m.drainW));
        else constraints[`u:${id}`] = { max: 0 };
      }
      if (m.rate.powerW < 0 && m.powerNet) coef(v, `pow:${m.powerNet}`, -m.rate.powerW);
    }
    variables[`u:${id}`] = v;
  }
  // Pumps move any fluid from the network behind them to the one in front.
  const allFluids = new Set<string>();
  for (const m of machines.values()) for (const f of [...m.fluidIn.keys(), ...m.fluidOut.keys()]) allFluids.add(f);
  for (const link of fluidNet.pumps) {
    const capRow = `cap:pump:${link.id}`;
    constraints[capRow] = { max: fluidNet.dead.has(link.from) || fluidNet.dead.has(link.to) ? 0 : link.capacity };
    for (const fluid of allFluids) {
      const from = balance(`f:${link.from}`, fluid);
      const to = balance(`f:${link.to}`, fluid);
      if (!usedRows.has(from) || !usedRows.has(to)) continue;
      variables[`xp:${link.id}:${fluid}`] = { [from]: -1, [to]: 1, [capRow]: 1, obj: -1e-6 };
    }
  }
  for (const row of usedRows) {
    if (row.startsWith('bal:')) constraints[row] = { equal: 0 };
    else if (row.startsWith('pow:')) constraints[row] = { min: 0 };
  }
  for (const [row, cap] of capacities) if (usedRows.has(row)) constraints[row] = { max: cap };

  let solution = solve({ direction: 'maximize', objective: 'obj', constraints, variables });
  // Short of power: the game gives every machine on the network the same
  // share (satisfaction), so they all slow down alike, rather than the LP
  // feeding some fully and starving others.
  /** Satisfaction of each short network; absent means fully powered. */
  const netShare = new Map<string, number>();
  if (solution.status === 'optimal' && powerNets.modelled) {
    const shares = evenPowerShares(solution.variables, machines, powerNets.nets, insertersOn, drainOf, inserterDemand, constraints, variables);
    if (shares.size) {
      applyPowerShares(shares, machines, insertersOn, drainOf, constraints);
      for (const [net, s] of shares) netShare.set(net, Math.min(1, s));
      for (const [net, s] of shares) for (const link of insertersOn.get(net) ?? []) {
        const t = transport[link.q.p.id]!;
        t.capacity = link.capacity * s;
        t.powerShare = s;
      }
      solution = solve({ direction: 'maximize', objective: 'obj', constraints, variables });
    }
  }
  const power: PowerState = { demandW: 0, supplyW: 0, capacityW: 0, modelled: powerNets.modelled };
  if (solution.status !== 'optimal') {
    return { ok: false, entities: {}, transport, outputs: [], inputs: [], power, warnings: [...warnings, `Solver: ${solution.status}`] };
  }
  let values = new Map(solution.variables);
  const val = (n: string) => values.get(n) ?? 0;

  // Second solve with free disposal of every machine output: tells a machine
  // held back by its outputs apart from one held back by its inputs.
  const relaxedVars: Record<string, Coefficients> = { ...variables };
  for (const [id, m] of machines) {
    for (const item of [...m.itemOut.keys(), ...m.fluidOut.keys()]) {
      relaxedVars[`dump:${id}:${item}`] = { [balance(machineNode(id), item)]: -1 };
      constraints[balance(machineNode(id), item)] ??= { equal: 0 };
    }
  }
  const relaxed = solve({ direction: 'maximize', objective: 'obj', constraints, variables: relaxedVars });
  const relaxedValues = new Map(relaxed.status === 'optimal' ? relaxed.variables : []);

  // Third solve: keep the best total found, and among all ways to reach it
  // pick the one where splitters split (and draw from their two inputs) as
  // evenly as possible. That is the game's rule: half each way, with the
  // overflow going to the other side only when one side can't take more.
  // Splitters with a priority (or a filter, which needs one) on a side are not
  // balanced on that side: the LP already filled the priority side first.
  const balanced = balanceSplitters(
    flowVars.filter((fv) => !fv.edge.split || !splitPriority(fv.edge.split)),
    variables,
    constraints,
    values,
  );
  if (balanced) values = balanced;
  for (const name of Object.keys(variables)) {
    if (!name.startsWith('xf:') || val(name) <= FLUID_FLOW_PRACTICAL + 1e-6) continue;
    const [, link, fluid] = /^xf:(.*):([^:]+)$/.exec(name) ?? [];
    const machineId = link?.split('>').find((p) => machines.has(p));
    const q = machineId ? machines.get(machineId)!.q : undefined;
    warnings.push(
      `${q ? `${q.e.name} at ${q.x},${q.y}` : 'A machine'} moves ${Math.round(val(name))}/s of ${fluid} through one connection; the game allows 6000/s but usually manages about ${FLUID_FLOW_PRACTICAL}/s`,
    );
  }

  // --- Results -------------------------------------------------------------
  const entities: Record<string, EntityState> = {};
  for (const [id, status] of idle) {
    const q = placed.find((x) => x.p.id === id)!;
    entities[id] = { activity: 0, status, rate: machineRate(data, { entity: q.e.name }, bonuses) };
  }
  const tightNets = new Set<string>();
  for (const net of powerNets.nets) {
    let supply = 0;
    let demand = 0;
    for (const m of machines.values()) {
      if (m.powerNet !== net) continue;
      const u = val(`u:${m.q.p.id}`);
      if (m.rate.powerW < 0) {
        supply += -m.rate.powerW * u;
        power.capacityW += -m.rate.powerW;
      } else if (m.electric) demand += (m.rate.powerW - m.drainW) * u;
    }
    const ins = inserterDemand(values, net);
    demand += ins;
    power.demandW += ins;
    power.supplyW += supply;
    if (powerNets.modelled && demand > 0 && supply - demand < 1e-6 * Math.max(1, demand)) tightNets.add(net);
  }
  if (!powerNets.modelled)
    for (const q of placed) if (q.e.kind === 'beacon' && !unpoweredBeacons.has(q.p.id)) power.demandW += q.e.energyUsage ?? 0;
  for (const [id, m] of machines) {
    const u = Math.min(1, Math.max(0, val(`u:${id}`)));
    const scaled = scaleRate(m.rate, u);
    if (m.electric) scaled.powerW = powerNets.modelled && !m.powerNet ? 0 : machinePowerW(m, u, netShare.get(m.powerNet ?? '') ?? 1);
    if (m.electric && m.powerNet === undefined && !powerNets.modelled) power.demandW += machinePowerW(m, u);
    else if (m.electric && m.powerNet) power.demandW += (m.rate.powerW - m.drainW) * u;
    let status: EntityStatus = 'working';
    let missing: string[] | undefined;
    if (u < 0.999) {
      const ur = relaxedValues.get(`u:${id}`) ?? u;
      const unconnected = [...m.itemIn.keys()].filter((item) => !hasInflow(edges, machineNode(id), item, reach))
        .concat([...m.fluidIn.keys()].filter((f) => (fluidNet.netsOf.get(id) ?? []).length === 0 || !fluidNet.carries(id, f)));
      if (powerNets.modelled && m.electric && !m.powerNet) status = 'no-power';
      else if (POWER_PLANT.has(m.q.e.kind) && unconnected.length === 0 && ur <= u + 1e-6) status = 'idle';
      else if (unconnected.length > 0) {
        status = 'starved';
        missing = unconnected;
      } else if (ur > u + 1e-4) status = 'output-blocked';
      else if (m.powerNet && tightNets.has(m.powerNet) && m.electric) status = 'low-power';
      else status = 'starved';
      if (POWER_PLANT.has(m.q.e.kind) && u > 1e-6 && status === 'output-blocked') status = 'working';
    }
    entities[id] = { activity: u, status, rate: scaled, ...(missing ? { missing } : {}) };
  }

  // Transport flows.
  const itemTotals = new Map<string, Map<string, number>>();
  for (const fv of flowVars) {
    const f = val(fv.name);
    if (f <= 1e-9 || !fv.edge.report) continue;
    let m = itemTotals.get(fv.edge.report);
    if (!m) itemTotals.set(fv.edge.report, (m = new Map()));
    m.set(fv.item, (m.get(fv.item) ?? 0) + f);
  }
  // Belt lanes: what enters each lane node (from upstream, side-loads, drops).
  const laneTotals = new Map<NodeId, Map<string, number>>();
  for (const fv of flowVars) {
    const to = fv.edge.to;
    if (!isBeltNode(to)) continue;
    const f = val(fv.name);
    if (f <= 1e-9) continue;
    let m = laneTotals.get(to);
    if (!m) laneTotals.set(to, (m = new Map()));
    m.set(fv.item, (m.get(fv.item) ?? 0) + f);
  }
  const asFlows = (m?: Map<string, number>) => [...(m ?? [])].map(([name, perSecond]) => ({ name, perSecond }));
  const total = (fs: Flow[]) => fs.reduce((a, f) => a + f.perSecond, 0);
  for (const [id, t] of Object.entries(transport)) {
    if (t.kind === 'inserter') {
      t.items = asFlows(itemTotals.get(id));
      t.perSecond = total(t.items);
      t.utilization = t.capacity > 0 ? t.perSecond / t.capacity : 0;
      const on = inserterNet.get(id);
      if (on) t.powerW = t.perSecond * on.link.jPerItem + on.link.drainW * (netShare.get(on.net) ?? 1);
      continue;
    }
    const base = t.kind === 'splitter' ? `s:${id}` : `b:${id}`;
    const left = asFlows(laneTotals.get(`${base}:L`));
    const right = asFlows(laneTotals.get(`${base}:R`));
    t.lanes = { left, right };
    t.items = sumFlows([...left, ...right], 1e-9);
    t.perSecond = total(t.items);
    const laneCap = t.capacity / 2;
    t.utilization = laneCap > 0 ? Math.max(total(left), total(right)) / laneCap : 0;
  }


  const outputs: Flow[] = [];
  const inputs: Flow[] = [];
  for (const fv of flowVars) if (fv.edge.to === EXIT) outputs.push({ name: fv.item, perSecond: val(fv.name) });
  for (const node of sinks) for (const item of reach.get(node) ?? []) outputs.push({ name: item, perSecond: val(`absorb:${node}:${item}`) });
  for (const [node, item] of supplies) inputs.push({ name: item, perSecond: val(`supply:${node}`) });

  const chests: Record<string, { stored: Flow[]; supplied: Flow[] }> = {};
  for (const q of placed) {
    if (q.e.kind !== 'chest') continue;
    const node = `c:${q.p.id}`;
    const item = supplies.get(node);
    chests[q.p.id] = {
      stored: sumFlows([...(reach.get(node) ?? [])].map((i) => ({ name: i, perSecond: val(`absorb:${node}:${i}`) })), 1e-7),
      supplied: item ? sumFlows([{ name: item, perSecond: val(`supply:${node}`) }], 1e-7) : [],
    };
  }

  return {
    ok: true,
    entities,
    transport,
    chests,
    outputs: sumFlows(outputs, 1e-7),
    inputs: sumFlows(inputs, 1e-7),
    power,
    ...(labTech
      ? {
          research: {
            tech: labTech.name,
            unitsPerSecond: labs.reduce((a, m) => a + (entities[m.q.p.id]?.rate.craftsPerSecond ?? 0) * (1 + m.rate.productivityBonus), 0),
            packs: sumFlows(labs.flatMap((m) => entities[m.q.p.id]?.rate.inputs ?? []), 1e-9),
            choices: researchChoices(data, packsAtLabs).map((t) => t.name),
          },
        }
      : {}),
    warnings,
  };
}

function balanceSplitters(
  flowVars: { name: string; edge: Edge; item: string }[],
  variables: Record<string, Coefficients>,
  constraints: Record<string, Constraint>,
  solved: Map<string, number>,
): Map<string, number> | undefined {
  const sides = new Map<string, Map<string, string[]>>(); // row group -> side -> flow vars
  const add = (group: string, side: string, name: string) => {
    let g = sides.get(group);
    if (!g) sides.set(group, (g = new Map()));
    let l = g.get(side);
    if (!l) g.set(side, (l = []));
    l.push(name);
  };
  for (const fv of flowVars) {
    const sp = fv.edge.split;
    // Each lane is split (and drawn) on its own, as in the game.
    if (sp) add(`${sp.dir}:${sp.splitter}:${fv.edge.lane ?? ''}`, sp.side, fv.name);
  }
  if (sides.size === 0) return undefined;
  const vars: Record<string, Record<string, number>> = {};
  let best = 0;
  for (const [name, c] of Object.entries(variables)) {
    const copy: Record<string, number> = { ...(c as Record<string, number>) };
    const o = copy.obj ?? 0;
    // Keep what the first solve achieved (machines, outputs, priorities), but
    // not the tiny per-edge flow cost: an even split may use a longer path.
    if (Math.abs(o) > 1e-5) {
      copy.objfix = o;
      best += o * (solved.get(name) ?? 0);
    }
    delete copy.obj;
    vars[name] = copy;
  }
  const cons: Record<string, Constraint> = { ...constraints, objfix: { min: best - 1e-7 * Math.max(1, Math.abs(best)) } };
  let any = false;
  for (const [group, g] of sides) {
    const list = [...g.values()];
    if (list.length !== 2) continue;
    any = true;
    const [a, b] = list as [string[], string[]];
    const imb = `imb:${group}`;
    vars[imb] = { imbalance: 1, [`${imb}:p`]: 1, [`${imb}:n`]: 1 };
    cons[`${imb}:p`] = { min: 0 };
    cons[`${imb}:n`] = { min: 0 };
    for (const n of a) {
      vars[n]![`${imb}:p`] = (vars[n]![`${imb}:p`] ?? 0) - 1;
      vars[n]![`${imb}:n`] = (vars[n]![`${imb}:n`] ?? 0) + 1;
    }
    for (const n of b) {
      vars[n]![`${imb}:p`] = (vars[n]![`${imb}:p`] ?? 0) + 1;
      vars[n]![`${imb}:n`] = (vars[n]![`${imb}:n`] ?? 0) - 1;
    }
  }
  if (!any) return undefined;
  const r = solve({ direction: 'minimize', objective: 'imbalance', constraints: cons, variables: vars });
  return r.status === 'optimal' ? new Map(r.variables) : undefined;
}

/**
 * Technologies these packs can research: every ingredient among them. Most
 * advanced first (more pack types, then infinite, then longer units).
 */
export function researchChoices(data: GameData, packs: Iterable<string>): Technology[] {
  const have = new Set(packs);
  return Object.values(data.technologies)
    .filter((t) => t.cost && t.cost.ingredients.length > 0 && t.cost.ingredients.every((i) => have.has(i.name)))
    .sort(
      (a, b) =>
        b.cost!.ingredients.length - a.cost!.ingredients.length ||
        Number(b.maxLevel === 'infinite') - Number(a.maxLevel === 'infinite') ||
        b.cost!.time - a.cost!.time ||
        a.name.localeCompare(b.name),
    );
}

/** The chosen technology if its packs all arrive, else the most advanced one they allow. */
function pickResearch(data: GameData, packs: Set<string>, wanted?: string): Technology | undefined {
  const want = wanted ? data.technologies[wanted] : undefined;
  if (want?.cost) return want;
  return researchChoices(data, packs)[0];
}

/** An electric inserter's capacity row, and its capacity at full power. */
interface PoweredLink {
  q: Placed;
  capRow: string;
  capacity: number;
  /** Energy per item moved: one full arm turn per swing, shared by a hand's worth of items. */
  jPerItem: number;
  drainW: number;
}

/** Caps every electric machine and inserter on each short network at its share of full speed. */
function applyPowerShares(
  shares: Map<string, number>,
  machines: Map<string, MachineInfo>,
  insertersOn: Map<string, PoweredLink[]>,
  drainOf: Map<string, number>,
  constraints: Record<string, Constraint>,
) {
  for (const [net, s] of shares) {
    const share = Math.min(1, s);
    // Satisfaction applies to the whole request, drain and beacons included.
    const drain = drainOf.get(net);
    if (drain) constraints[`cap:drain:${net}`] = { max: drain * share };
    for (const m of machines.values())
      if (m.electric && m.powerNet === net && m.rate.powerW > 0) constraints[`u:${m.q.p.id}`] = { max: share };
    for (const link of insertersOn.get(net) ?? []) if (constraints[link.capRow]) constraints[link.capRow] = { max: link.capacity * share };
  }
}

/**
 * Power satisfaction per short network. A network is short when the machines
 * on it would use more than the generation the first solve could get. Its
 * share s is found by bisection so that, with every consumer on it (machines
 * and inserters alike) slowed to s and power not limiting, demand equals that
 * generation.
 */
function evenPowerShares(
  first: [string, number][],
  machines: Map<string, MachineInfo>,
  nets: string[],
  insertersOn: Map<string, PoweredLink[]>,
  drainOf: Map<string, number>,
  inserterDemand: (vals: Map<string, number>, net: string) => number,
  constraints: Record<string, Constraint>,
  variables: Record<string, Coefficients>,
): Map<string, number> {
  const at = (vals: Map<string, number>, id: string) => vals.get(`u:${id}`) ?? 0;
  const consumersOf = (net: string) => [...machines.values()].filter((m) => m.electric && m.powerNet === net && m.rate.powerW > 0);
  const demand = (vals: Map<string, number>, net: string) =>
    consumersOf(net).reduce((a, m) => a + (m.rate.powerW - m.drainW) * at(vals, m.q.p.id), 0) + inserterDemand(vals, net);
  const firstVals = new Map(first);
  const supply = new Map<string, number>();
  for (const net of nets) {
    let s = 0;
    for (const m of machines.values()) if (m.powerNet === net && m.rate.powerW < 0) s += -m.rate.powerW * at(firstVals, m.q.p.id);
    supply.set(net, s);
  }
  // What the machines would do with unlimited power.
  const free: Record<string, Constraint> = {};
  for (const [row, c] of Object.entries(constraints)) if (!row.startsWith('pow:')) free[row] = c;
  const solveCapped = (caps: Map<string, number>) => {
    const cons = { ...free };
    applyPowerShares(caps, machines, insertersOn, drainOf, cons);
    const r = solve({ direction: 'maximize', objective: 'obj', constraints: cons, variables });
    return r.status === 'optimal' ? new Map(r.variables) : undefined;
  };
  const unlimited = solveCapped(new Map());
  if (!unlimited) return new Map();
  const short = nets.filter((net) => demand(unlimited, net) > (supply.get(net) ?? 0) * (1 + 1e-6) + 1e-3);
  if (!short.length) return new Map();
  const lo = new Map(short.map((n) => [n, 0]));
  const hi = new Map(short.map((n) => [n, 1]));
  for (let i = 0; i < 20; i++) {
    const mid = new Map(short.map((n) => [n, (lo.get(n)! + hi.get(n)!) / 2]));
    const vals = solveCapped(mid);
    if (!vals) break;
    for (const n of short) {
      if (demand(vals, n) > supply.get(n)!) hi.set(n, mid.get(n)!);
      else lo.set(n, mid.get(n)!);
    }
  }
  return lo;
}

function blankTransport(kind: TransportState['kind'], capacity: number): TransportState {
  return { kind, perSecond: 0, capacity, utilization: 0, items: [] };
}

function scaleRate(r: EntityRate, u: number): EntityRate {
  return {
    ...r,
    craftsPerSecond: r.craftsPerSecond * u,
    powerW: r.powerW > 0 ? r.powerW * u : r.powerW * u,
    fuelW: r.fuelW * u,
    inputs: r.inputs.map((f) => ({ name: f.name, perSecond: f.perSecond * u })),
    outputs: r.outputs.map((f) => ({ name: f.name, perSecond: f.perSecond * u })),
  };
}

function hasInflow(edges: Edge[], node: NodeId, item: string, reach: Map<NodeId, Set<string>>): boolean {
  return edges.some((e) => e.to === node && allows(e, item) && (reach.get(e.from)?.has(item) ?? false));
}

// ---------------------------------------------------------------------------
// Underground belts: along each line, the upstream one is the entrance and the
// next one of the same kind within reach is its exit.

function pairUndergrounds(placed: Placed[], warnings: string[]) {
  const roles = new Map<string, { role: 'entrance' | 'exit'; partner?: string }>();
  const lines = new Map<string, Placed[]>();
  for (const q of placed) {
    if (q.e.kind !== 'underground-belt') continue;
    const lineKey = `${q.e.name}|${q.d}|${q.d % 2 === 0 ? q.x : q.y}`;
    let l = lines.get(lineKey);
    if (!l) lines.set(lineKey, (l = []));
    l.push(q);
  }
  for (const line of lines.values()) {
    const d = line[0]!.d;
    const along = (q: Placed) => q.x * DX[d] + q.y * DY[d];
    line.sort((a, b) => along(a) - along(b));
    let pending: Placed | undefined;
    for (const q of line) {
      const max = (q.e.maxDistance ?? 4) + 1;
      if (pending && along(q) - along(pending) <= max) {
        roles.set(pending.p.id, { role: 'entrance', partner: q.p.id });
        roles.set(q.p.id, { role: 'exit', partner: pending.p.id });
        pending = undefined;
      } else {
        if (pending) {
          roles.set(pending.p.id, { role: 'entrance' });
          warnings.push(`Underground belt at ${pending.x},${pending.y} has no exit in range`);
        }
        pending = q;
      }
    }
    if (pending) {
      roles.set(pending.p.id, { role: 'entrance' });
      warnings.push(`Underground belt at ${pending.x},${pending.y} has no exit in range`);
    }
  }
  return roles;
}

// ---------------------------------------------------------------------------
// Fluid networks: pipes, tanks, pumps, boilers and engines that touch join up;
// pipe-to-ground pairs join along their line. Other machines plug into any
// network next to them.

function buildFluidNetworks(
  placed: Placed[],
  at: (x: number, y: number) => Placed | undefined,
  machines: Map<string, MachineInfo>,
  warnings: string[],
) {
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const connectors = placed.filter((q) => FLUID_CONNECTORS.has(q.e.kind));
  for (const q of connectors) parent.set(q.p.id, q.p.id);
  for (const q of connectors) {
    for (const [x, y] of neighbourTiles(q)) {
      const n = at(x, y);
      if (n && FLUID_CONNECTORS.has(n.e.kind) && n.p.id !== q.p.id) union(q.p.id, n.p.id);
    }
  }
  // Pipe-to-ground pairs.
  const lines = new Map<string, Placed[]>();
  for (const q of connectors) {
    if (q.e.kind !== 'pipe-to-ground') continue;
    const k = `${q.e.name}|${q.d % 2}|${q.d % 2 === 0 ? q.x : q.y}`;
    let l = lines.get(k);
    if (!l) lines.set(k, (l = []));
    l.push(q);
  }
  for (const line of lines.values()) {
    const vertical = line[0]!.d % 2 === 0;
    line.sort((a, b) => (vertical ? a.y - b.y : a.x - b.x));
    for (let i = 0; i + 1 < line.length; i += 2) {
      const a = line[i]!;
      const b = line[i + 1]!;
      const dist = vertical ? b.y - a.y : b.x - a.x;
      if (dist <= (a.e.maxDistance ?? 10) + 1) union(a.p.id, b.p.id);
      else warnings.push(`Pipe to ground at ${a.x},${a.y} has no partner in range`);
    }
  }
  const netsOf = new Map<string, string[]>();
  for (const [id, m] of machines) {
    if (m.fluidIn.size === 0 && m.fluidOut.size === 0) continue;
    const nets = new Set<string>();
    if (parent.has(id)) nets.add(find(id));
    else
      for (const [x, y] of neighbourTiles(m.q)) {
        const n = at(x, y);
        if (n && parent.has(n.p.id)) nets.add(find(n.p.id));
      }
    netsOf.set(id, [...nets]);
  }
  // Which fluids are offered on each network, to explain starvation.
  const offered = new Map<string, Set<string>>();
  for (const [id, m] of machines)
    for (const net of netsOf.get(id) ?? []) {
      let s = offered.get(net);
      if (!s) offered.set(net, (s = new Set()));
      for (const f of m.fluidOut.keys()) s.add(f);
    }
  // Pumps: from the network behind to the one in front.
  const pumps: { id: string; from: string; to: string; capacity: number }[] = [];
  const netAt = (x: number, y: number) => {
    const n = at(x, y);
    return n && parent.has(n.p.id) ? find(n.p.id) : undefined;
  };
  for (const q of placed) {
    if (q.e.kind !== 'pump') continue;
    const [fx, fy] = drillDropTile(q);
    const back = drillDropTile({ ...q, d: opposite(q.d) });
    const to = netAt(fx, fy);
    const from = netAt(back[0], back[1]);
    if (from && to && from !== to) pumps.push({ id: q.p.id, from, to, capacity: q.e.pumpingSpeed ?? 1200 });
    else warnings.push(`Pump at ${q.x},${q.y} is not between two pipelines`);
  }
  // Pipelines spreading outside 320×320 tiles stop flowing.
  const extent = new Map<string, [number, number, number, number]>();
  for (const q of connectors) {
    const r = find(q.p.id);
    const b = extent.get(r) ?? [Infinity, Infinity, -Infinity, -Infinity];
    extent.set(r, [Math.min(b[0], q.x), Math.min(b[1], q.y), Math.max(b[2], q.x + q.w), Math.max(b[3], q.y + q.h)]);
  }
  const dead = new Set<string>();
  for (const [net, [x0, y0, x1, y1]] of extent) {
    if (x1 - x0 > PIPELINE_MAX_EXTENT || y1 - y0 > PIPELINE_MAX_EXTENT) {
      dead.add(net);
      warnings.push(`A pipeline at ${x0},${y0} spreads outside ${PIPELINE_MAX_EXTENT}×${PIPELINE_MAX_EXTENT} tiles, so nothing flows in it (split it with a pump)`);
    }
  }
  // Pumped fluids count as offered downstream.
  for (const link of pumps) {
    const src = offered.get(link.from);
    if (!src) continue;
    let dst = offered.get(link.to);
    if (!dst) offered.set(link.to, (dst = new Set()));
    for (const f of src) dst.add(f);
  }
  const carries = (machine: string, fluid: string) => (netsOf.get(machine) ?? []).some((n) => offered.get(n)?.has(fluid));
  return { netsOf, carries, pumps, dead };
}

// ---------------------------------------------------------------------------
// Electric networks: poles connect when within wire reach; a building is on a
// network if any of its tiles is inside a pole's supply area. A layout with no
// generators is assumed to be fed from outside.

/** Whether a pole's supply area touches this entity. */
function inSupplyArea(pole: Placed, q: Placed): boolean {
  const cx = pole.x + pole.w / 2;
  const cy = pole.y + pole.h / 2;
  const r = pole.e.supplyAreaDistance ?? 0;
  return q.x < cx + r && cx - r < q.x + q.w && q.y < cy + r && cy - r < q.y + q.h;
}

function buildPowerNetworks(placed: Placed[], machines: Map<string, MachineInfo>) {
  const generators = [...machines.values()].filter((m) => m.rate.powerW < 0);
  const nets: string[] = [];
  let netOf: (q: Placed) => string | undefined = () => undefined;
  if (generators.length === 0) return { modelled: false, nets, netOf };
  const poles = placed.filter((q) => q.e.kind === 'pole');
  if (poles.length === 0) {
    nets.push('all');
    for (const m of machines.values()) m.powerNet = 'all';
    return { modelled: true, nets, netOf: () => 'all' };
  }
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const p of poles) parent.set(p.p.id, p.p.id);
  const centre = (q: Placed) => [q.x + q.w / 2, q.y + q.h / 2] as const;
  for (let i = 0; i < poles.length; i++)
    for (let j = i + 1; j < poles.length; j++) {
      const a = poles[i]!;
      const b = poles[j]!;
      const [ax, ay] = centre(a);
      const [bx, by] = centre(b);
      const reach = Math.min(a.e.wireReach ?? 0, b.e.wireReach ?? 0);
      if (Math.hypot(ax - bx, ay - by) <= reach + 1e-9) parent.set(find(a.p.id), find(b.p.id));
    }
  netOf = (q: Placed) => {
    for (const p of poles) if (inSupplyArea(p, q)) return find(p.p.id);
    return undefined;
  };
  for (const m of machines.values()) m.powerNet = netOf(m.q);
  for (const p of poles) {
    const r = find(p.p.id);
    if (!nets.includes(r)) nets.push(r);
  }
  return { modelled: true, nets, netOf };
}
