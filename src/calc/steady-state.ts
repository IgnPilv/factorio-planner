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
import type { Entity, GameData } from '../data/types';
import { sumFlows, type Flow } from './flow';
import { beaconsByEntity, type PlacedEntity } from './layout';
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
  utilization: number;
  items: Flow[];
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
  /** Items leaving the layout: open belt ends, chests, labs. */
  outputs: Flow[];
  /** Items taken from supply chests. */
  inputs: Flow[];
  power: PowerState;
  warnings: string[];
}

export interface SteadyOptions {
  /** Fuel for burner machines and boilers. Default "coal". */
  fuel?: string;
}

// ---------------------------------------------------------------------------
// Game mechanics

/**
 * Inserter items per second, chest to chest: one swing each way takes
 * ceil(0.5 / rotation speed) ticks, and each round trip moves a full hand.
 * Matches the wiki: inserter 0.83/s, long-handed 1.2/s, fast 2.31/s.
 */
export function inserterThroughput(entity: Entity, bonuses?: ResearchBonuses): number {
  const rot = entity.rotationSpeed ?? 0;
  if (rot <= 0) return 0;
  const swingTicks = Math.ceil(0.5 / rot - 1e-9);
  const hand = inserterHandSize(entity, bonuses);
  return (hand * 60) / (2 * swingTicks);
}

export function inserterHandSize(entity: Entity, bonuses?: ResearchBonuses): number {
  const bonus = entity.bulk ? bonuses?.bulkInserterBonus ?? 0 : bonuses?.inserterStackBonus ?? 0;
  return 1 + bonus;
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
const FLUID_CONNECTORS = new Set(['pipe', 'pipe-to-ground', 'storage-tank', 'pump', 'offshore-pump', 'boiler', 'generator', 'steam-turbine']);
const POWER_PLANT = new Set(['offshore-pump', 'boiler', 'generator', 'steam-turbine']);

// ---------------------------------------------------------------------------
// Flow network

/** Where items can sit: a machine's item port, a belt tile, a splitter, a chest, a lab, or outside. */
type NodeId = string;
const EXIT = 'exit';
/** Objective value of one item per second leaving the layout (machine activity counts 1). */
const OUTPUT_WEIGHT = 1e-2;

interface Edge {
  id: string;
  from: NodeId;
  to: NodeId;
  /** Capacity row this edge counts against, if any. */
  capRow?: string;
  /** Items allowed through; undefined = anything. */
  accept?: Set<string>;
  /** Report this edge's flow under this transport entity id. */
  report?: string;
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
  weight: number;
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
  const beacons = beaconsByEntity(data, layout);

  const edges: Edge[] = [];
  const supplies = new Map<NodeId, string>(); // chest node -> supplied item
  const sinks = new Set<NodeId>(); // nodes that absorb anything (chests, labs)
  const sinkAccept = new Map<NodeId, Set<string>>();
  const transport: Record<string, TransportState> = {};
  const capacities = new Map<string, number>();
  const machines = new Map<string, MachineInfo>();
  const idle = new Map<string, EntityStatus>();

  // --- Machines ----------------------------------------------------------
  for (const q of placed) {
    const kind = q.e.kind;
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
      const node = `l:${q.p.id}`;
      sinks.add(node);
      sinkAccept.set(node, new Set(q.e.inputs ?? []));
    }
  }

  /** The node an inserter or drill interacts with at a tile, if any. */
  const nodeAt = (x: number, y: number): { node: NodeId; q: Placed } | undefined => {
    const q = at(x, y);
    if (!q) return undefined;
    const k = q.e.kind;
    if (machines.has(q.p.id)) return { node: machineNode(q.p.id), q };
    if (k === 'chest') return { node: `c:${q.p.id}`, q };
    if (k === 'lab') return { node: `l:${q.p.id}`, q };
    if (k === 'belt' || k === 'underground-belt') return { node: `b:${q.p.id}`, q };
    if (k === 'splitter') return { node: `s:${q.p.id}`, q };
    return undefined;
  };

  // --- Belts -------------------------------------------------------------
  const undergroundRole = pairUndergrounds(placed, warnings);
  const beltCap = (q: Placed) => q.e.beltThroughput ?? 0;

  /** Belt-like entity at a tile that pushes items into tile (x, y) from behind/side. */
  const feedsInto = (src: Placed, x: number, y: number): boolean => {
    if (src.e.kind === 'belt') return src.x + DX[src.d] === x && src.y + DY[src.d] === y;
    if (src.e.kind === 'underground-belt') return undergroundRole.get(src.p.id)?.role === 'exit' && src.x + DX[src.d] === x && src.y + DY[src.d] === y;
    if (src.e.kind === 'splitter') return tilesOf(src).some(([tx, ty]) => tx + DX[src.d] === x && ty + DY[src.d] === y);
    return false;
  };

  /** Edge from a belt-like source moving direction d out of tile (x, y). */
  const linkForward = (srcId: string, from: NodeId, x: number, y: number, d: Dir, cap: number, src: Placed) => {
    const tx = x + DX[d];
    const ty = y + DY[d];
    const t = at(tx, ty);
    const capRow = `cap:${srcId}:${x},${y}`;
    if (!t) {
      capacities.set(capRow, cap);
      edges.push({ id: `${srcId}>exit@${x},${y}`, from, to: EXIT, capRow, report: srcId });
      return;
    }
    const k = t.e.kind;
    let to: NodeId | undefined;
    let laneLimit = false;
    if (k === 'belt') {
      if (t.d === opposite(d)) to = undefined;
      else {
        to = `b:${t.p.id}`;
        if (t.d !== d) {
          // Perpendicular: a curve if nothing feeds the target from behind and
          // this is its only side feeder; otherwise side-loading onto one lane.
          const behind = at(t.x - DX[t.d], t.y - DY[t.d]);
          const straightFeed = behind && BELTS.has(behind.e.kind) && feedsInto(behind, t.x, t.y);
          const left = at(t.x + DX[(t.d + 3) % 4]!, t.y + DY[(t.d + 3) % 4]!);
          const right = at(t.x + DX[(t.d + 1) % 4]!, t.y + DY[(t.d + 1) % 4]!);
          const sideFeeds = [left, right].filter((s) => s && BELTS.has(s.e.kind) && feedsInto(s, t.x, t.y)).length;
          laneLimit = !!straightFeed || sideFeeds > 1;
        }
      }
    } else if (k === 'underground-belt') {
      const role = undergroundRole.get(t.p.id)?.role;
      if (role === 'entrance' && t.d === d) to = `b:${t.p.id}`;
      else if (role === 'entrance' && t.d !== opposite(d)) {
        to = `b:${t.p.id}`;
        laneLimit = true;
      }
    } else if (k === 'splitter') {
      if (t.d === d) to = `s:${t.p.id}`;
    }
    if (!to) return; // dead end: items stop here
    if (laneLimit) {
      const lane = `cap:lane:${srcId}:${x},${y}`;
      capacities.set(lane, Math.min(laneThroughput(src.e), laneThroughput(t.e)));
      // One lane only; that is also below the source belt's own limit.
      edges.push({ id: `${srcId}>${to}@${x},${y}#lane`, from, to, capRow: lane, report: srcId });
      return;
    }
    capacities.set(capRow, cap);
    edges.push({ id: `${srcId}>${to}@${x},${y}`, from, to, capRow, report: srcId });
  };

  for (const q of placed) {
    const k = q.e.kind;
    if (k === 'belt') {
      transport[q.p.id] = blankTransport('belt', beltCap(q));
      linkForward(q.p.id, `b:${q.p.id}`, q.x, q.y, q.d, beltCap(q), q);
    } else if (k === 'underground-belt') {
      transport[q.p.id] = blankTransport('underground-belt', beltCap(q));
      const info = undergroundRole.get(q.p.id);
      if (info?.role === 'entrance' && info.partner) {
        const capRow = `cap:${q.p.id}`;
        capacities.set(capRow, beltCap(q));
        edges.push({ id: `${q.p.id}>ug`, from: `b:${q.p.id}`, to: `b:${info.partner}`, capRow, report: q.p.id });
      } else if (info?.role === 'exit') {
        linkForward(q.p.id, `b:${q.p.id}`, q.x, q.y, q.d, beltCap(q), q);
      }
    } else if (k === 'splitter') {
      transport[q.p.id] = blankTransport('splitter', 2 * beltCap(q));
      for (const [x, y] of tilesOf(q)) linkForward(q.p.id, `s:${q.p.id}`, x, y, q.d, beltCap(q), q);
    }
  }

  // --- Inserters ---------------------------------------------------------
  for (const q of placed) {
    if (q.e.kind !== 'inserter') continue;
    const reach = inserterReach(q.e);
    const capacity = inserterThroughput(q.e, bonuses);
    transport[q.p.id] = blankTransport('inserter', capacity);
    const pick = nodeAt(q.x - DX[q.d] * reach, q.y - DY[q.d] * reach);
    const drop = nodeAt(q.x + DX[q.d] * reach, q.y + DY[q.d] * reach);
    if (!pick || !drop) continue;
    const capRow = `cap:${q.p.id}`;
    capacities.set(capRow, capacity);
    let accept: Set<string> | undefined;
    if (drop.node.startsWith('m:')) accept = machineAccepts(drop.q.p.id);
    else if (sinkAccept.has(drop.node)) accept = sinkAccept.get(drop.node);
    edges.push({ id: `ins:${q.p.id}`, from: pick.node, to: drop.node, capRow, accept, report: q.p.id });
  }

  // --- Drills drop onto the tile in front ---------------------------------
  for (const [id, m] of machines) {
    if (m.q.e.kind !== 'mining-drill' || m.itemOut.size === 0) continue;
    const [x, y] = drillDropTile(m.q);
    const target = nodeAt(x, y);
    if (!target) continue;
    const accept = target.node.startsWith('m:') ? machineAccepts(target.q.p.id) : undefined;
    edges.push({ id: `drop:${id}`, from: machineNode(id), to: target.node, accept });
  }

  // --- Fluids ------------------------------------------------------------
  const fluidNet = buildFluidNetworks(placed, at, machines, warnings);

  // --- Power -------------------------------------------------------------
  const powerNets = buildPowerNetworks(placed, machines);

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
        if (e.accept && !e.accept.has(item)) continue;
        if (e.from.startsWith('m:') && !machines.get(e.from.slice(2))?.itemOut.has(item)) continue;
        if (addReach(e.to, item)) changed = true;
      }
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
  const flowVars: { name: string; edge: Edge; item: string }[] = [];
  for (const e of edges) {
    const items = reach.get(e.from);
    if (!items) continue;
    for (const item of items) {
      if (e.accept && !e.accept.has(item)) continue;
      if (e.from.startsWith('m:') && !machines.get(e.from.slice(2))?.itemOut.has(item)) continue;
      const name = `x:${e.id}:${item}`;
      // Items leaving the layout count towards the objective, so supply chests
      // and drills push as much as the build can carry.
      const v: Record<string, number> = { obj: e.to === EXIT ? OUTPUT_WEIGHT : -1e-6 };
      coef(v, balance(e.from, item), -1);
      if (e.to !== EXIT) coef(v, balance(e.to, item), 1);
      if (e.capRow) coef(v, e.capRow, 1);
      variables[name] = v;
      flowVars.push({ name, edge: e, item });
    }
  }
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
        variables[name] = { [balance(`f:${net}`, fluid)]: -1, [balance(machineNode(id), fluid)]: 1 };
        usedRows.add(balance(`f:${net}`, fluid));
      }
    }
    for (const [fluid, r] of m.fluidOut) {
      coef(v, balance(machineNode(id), fluid), r);
      for (const net of nets) {
        const name = `xf:${id}>${net}:${fluid}`;
        variables[name] = { [balance(`f:${net}`, fluid)]: 1, [balance(machineNode(id), fluid)]: -1 };
        usedRows.add(balance(`f:${net}`, fluid));
      }
    }
    // Electricity.
    if (powerNets.modelled) {
      if (m.electric) {
        if (m.powerNet) coef(v, `pow:${m.powerNet}`, -m.rate.powerW);
        else constraints[`u:${id}`] = { max: 0 };
      }
      if (m.rate.powerW < 0 && m.powerNet) coef(v, `pow:${m.powerNet}`, -m.rate.powerW);
    }
    variables[`u:${id}`] = v;
  }
  for (const row of usedRows) {
    if (row.startsWith('bal:')) constraints[row] = { equal: 0 };
    else if (row.startsWith('pow:')) constraints[row] = { min: 0 };
  }
  for (const [row, cap] of capacities) if (usedRows.has(row)) constraints[row] = { max: cap };

  const solution = solve({ direction: 'maximize', objective: 'obj', constraints, variables });
  const power: PowerState = { demandW: 0, supplyW: 0, capacityW: 0, modelled: powerNets.modelled };
  if (solution.status !== 'optimal') {
    return { ok: false, entities: {}, transport, outputs: [], inputs: [], power, warnings: [...warnings, `Solver: ${solution.status}`] };
  }
  const values = new Map(solution.variables);
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
      } else if (m.electric) demand += m.rate.powerW * u;
    }
    power.supplyW += supply;
    if (powerNets.modelled && demand > 0 && supply - demand < 1e-6 * Math.max(1, demand)) tightNets.add(net);
  }
  for (const [id, m] of machines) {
    const u = Math.min(1, Math.max(0, val(`u:${id}`)));
    const scaled = scaleRate(m.rate, u);
    if (m.electric) power.demandW += m.rate.powerW * u;
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
  for (const [id, t] of Object.entries(transport)) {
    const items = [...(itemTotals.get(id) ?? [])].map(([name, perSecond]) => ({ name, perSecond }));
    const perSecond = items.reduce((s, i) => s + i.perSecond, 0);
    t.items = items;
    t.perSecond = perSecond;
    t.utilization = t.capacity > 0 ? perSecond / t.capacity : 0;
  }

  // Lab consumption becomes their "inputs".
  for (const q of placed) {
    if (q.e.kind !== 'lab') continue;
    const node = `l:${q.p.id}`;
    const absorbed = [...(reach.get(node) ?? [])]
      .map((item) => ({ name: item, perSecond: val(`absorb:${node}:${item}`) }))
      .filter((f) => f.perSecond > 1e-9);
    const rate = machineRate(data, { entity: q.e.name, modules: q.p.modules, beacons: beacons.get(q.p.id) ?? [] }, bonuses);
    entities[q.p.id] = { activity: absorbed.length > 0 ? 1 : 0, status: absorbed.length > 0 ? 'working' : 'starved', rate: { ...rate, inputs: absorbed } };
  }

  const outputs: Flow[] = [];
  const inputs: Flow[] = [];
  for (const fv of flowVars) if (fv.edge.to === EXIT) outputs.push({ name: fv.item, perSecond: val(fv.name) });
  for (const node of sinks) for (const item of reach.get(node) ?? []) outputs.push({ name: item, perSecond: val(`absorb:${node}:${item}`) });
  for (const [node, item] of supplies) inputs.push({ name: item, perSecond: val(`supply:${node}`) });

  return {
    ok: true,
    entities,
    transport,
    outputs: sumFlows(outputs, 1e-7),
    inputs: sumFlows(inputs, 1e-7),
    power,
    warnings,
  };
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
  return edges.some((e) => e.to === node && (!e.accept || e.accept.has(item)) && (reach.get(e.from)?.has(item) ?? false));
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
  const carries = (machine: string, fluid: string) => (netsOf.get(machine) ?? []).some((n) => offered.get(n)?.has(fluid));
  return { netsOf, carries };
}

// ---------------------------------------------------------------------------
// Electric networks: poles connect when within wire reach; a building is on a
// network if any of its tiles is inside a pole's supply area. A layout with no
// generators is assumed to be fed from outside.

function buildPowerNetworks(placed: Placed[], machines: Map<string, MachineInfo>) {
  const generators = [...machines.values()].filter((m) => m.rate.powerW < 0);
  const nets: string[] = [];
  if (generators.length === 0) return { modelled: false, nets };
  const poles = placed.filter((q) => q.e.kind === 'pole');
  if (poles.length === 0) {
    nets.push('all');
    for (const m of machines.values()) m.powerNet = 'all';
    return { modelled: true, nets };
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
  for (const m of machines.values()) {
    const q = m.q;
    for (const p of poles) {
      const [cx, cy] = centre(p);
      const r = p.e.supplyAreaDistance ?? 0;
      if (q.x < cx + r && cx - r < q.x + q.w && q.y < cy + r && cy - r < q.y + q.h) {
        m.powerNet = find(p.p.id);
        break;
      }
    }
  }
  for (const p of poles) {
    const r = find(p.p.id);
    if (!nets.includes(r)) nets.push(r);
  }
  return { modelled: true, nets };
}
