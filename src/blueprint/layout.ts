// Converting between editor layouts and Factorio blueprints.
//
// Editor conventions differ from the game's in a few places, all handled here:
//   - editor x,y is the top-left tile; blueprints use the centre
//   - editor directions are 0-3; the game uses 16-way (x4)
//   - editor inserters face the way items travel; in the game an inserter's
//     direction points at its pickup side (prototype pickup_position {0,-1})
//   - underground belts face the way items travel in both (the game adds
//     type input/output, which the editor infers from pairing)
//   - pipe-to-ground faces its above-ground connection in the game; the editor
//     only knows the axis, so pairs are turned to face away from each other
//   - offshore pumps face the water in both
//   - drills store the mined resource in `recipe` in the editor; not exported

import { gameData } from '../data';
import { ENTITIES } from '../editor/catalog';
import { footprint, groupBounds, type Clipboard, type Direction, type PlacedEntity } from '../editor/model';
import { isRailName, RAIL_ITEM, railValid, signalAt, type PlacedRail } from '../editor/rails';
import { poleInfo } from '../editor/power';
import {
  encodeVersion,
  makeBlueprint,
  MODULE_INVENTORY,
  POLE_COPPER,
  type Blueprint,
  type BlueprintEntity,
  type BlueprintEntityInput,
  type BlueprintWire,
  type ItemRequest,
} from './format';

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/** Recipes are only written for machines whose recipe the player picks. */
const RECIPE_PROTOTYPES = new Set(['assembling-machine']);

export interface ExportOptions {
  label?: string;
  /** Rail track to include (signals and train stops are among the entities). */
  rails?: readonly PlacedRail[];
}

export interface ExportResult {
  blueprint: Blueprint;
  /** Buildings left out because the game data doesn't know them. */
  skipped: number;
}

/** Turn placed buildings into a blueprint. Positions are relative, so any subset works. */
export function layoutToBlueprint(entities: readonly PlacedEntity[], opts: ExportOptions = {}): ExportResult {
  const known = entities.filter((e) => ENTITIES[e.name]);
  const ugRole = undergroundRoles(known);
  const ptgDir = pipeToGroundDirections(known);

  const rails = opts.rails ?? [];
  // Shift so the blueprint sits near the origin; the game re-centres anyway.
  // With rails the shift is even, so rail ends stay on the rail grid.
  const b = groupBounds(known, rails);

  const out: BlueprintEntityInput[] = known.map((e) => {
    const def = ENTITIES[e.name]!;
    const { w, h } = footprint(def, e.direction);
    let dir: number = e.direction;
    if (def.kind === 'inserter') dir = (dir + 2) % 4;
    if (def.kind === 'pipe-to-ground') dir = ptgDir.get(e.id) ?? dir;
    const be: BlueprintEntityInput = {
      name: e.name,
      position: { x: e.x - b.x + w / 2, y: e.y - b.y + h / 2 },
    };
    if (dir) be.direction = dir * 4;
    if (e.diagonal && def.kind === 'rail-signal') be.direction = dir * 4 + 2;
    if (def.kind === 'underground-belt') be.type = ugRole.get(e.id) ?? 'input';
    if (e.recipe && RECIPE_PROTOTYPES.has(def.prototype) && def.kind !== 'rocket-silo') be.recipe = e.recipe;
    const items = moduleRequests(def.prototype, e.modules);
    if (items.length) be.items = items;
    Object.assign(be, logisticsSettings(def.kind, e));
    return be;
  });

  for (const r of rails) {
    const be: BlueprintEntityInput = { name: r.name, position: { x: r.x - b.x, y: r.y - b.y } };
    if (r.direction) be.direction = r.direction;
    out.push(be);
  }

  return {
    blueprint: makeBlueprint(out, {
      label: opts.label,
      wires: poleWires(known),
      itemOf: (n) => (isRailName(n) ? RAIL_ITEM : (ENTITIES[n]?.item ?? n)),
    }),
    skipped: entities.length - known.length,
  };
}

const SIDES = new Set(['left', 'right']);
const isItem = (n: unknown): n is string => typeof n === 'string' && !!gameData.items[n];
const REQUESTERS = new Set(['requester-chest', 'buffer-chest']);

/** Inserter filters, splitter priorities and filter, chest requests, in 2.0 blueprint form. */
function logisticsSettings(kind: string, e: PlacedEntity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (kind === 'inserter') {
    const filters = (e.filters ?? []).filter(isItem).slice(0, 5);
    if (filters.length) {
      out.use_filters = true;
      out.filters = filters.map((name, i) => ({ index: i + 1, name, quality: 'normal', comparator: '=' }));
      if (e.filterMode === 'blacklist') out.filter_mode = 'blacklist';
    }
  } else if (kind === 'splitter') {
    if (e.inputPriority && SIDES.has(e.inputPriority)) out.input_priority = e.inputPriority;
    if (e.outputPriority && SIDES.has(e.outputPriority)) {
      out.output_priority = e.outputPriority;
      if (isItem(e.filters?.[0])) out.filter = { name: e.filters[0], quality: 'normal', comparator: '=' };
    }
  } else if (REQUESTERS.has(e.name)) {
    const reqs = (e.requests ?? []).filter((r) => isItem(r.name) && r.count > 0);
    if (reqs.length)
      out.request_filters = {
        sections: [{ index: 1, filters: reqs.map((r, i) => ({ index: i + 1, name: r.name, quality: 'normal', comparator: '=', count: r.count })) }],
      };
  }
  return out;
}

/** Read the same settings back (2.0, plus the 1.1 shapes). */
function readLogistics(kind: string, name: string, be: BlueprintEntity): Partial<PlacedEntity> {
  const out: Partial<PlacedEntity> = {};
  const nameOf = (f: unknown) => (typeof f === 'string' ? f : (f as { name?: unknown } | undefined)?.name);
  if (kind === 'inserter') {
    const raw = Array.isArray(be.filters) ? (be.filters as { index?: number; name?: unknown }[]) : [];
    const filters = [...raw].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((f) => f.name).filter(isItem);
    // 2.0 needs use_filters; 1.1 filter inserters had filters alone
    if (filters.length && be.use_filters !== false) {
      out.filters = filters.slice(0, 5);
      if (be.filter_mode === 'blacklist') out.filterMode = 'blacklist';
    }
  } else if (kind === 'splitter') {
    if (typeof be.input_priority === 'string' && SIDES.has(be.input_priority)) out.inputPriority = be.input_priority as 'left' | 'right';
    if (typeof be.output_priority === 'string' && SIDES.has(be.output_priority)) {
      out.outputPriority = be.output_priority as 'left' | 'right';
      const f = nameOf(be.filter);
      if (isItem(f)) out.filters = [f];
    }
  } else if (REQUESTERS.has(name)) {
    type Req = { name?: unknown; count?: unknown };
    const rf = be.request_filters as { sections?: { filters?: Req[] }[] } | Req[] | undefined;
    // 2.0: { sections: [{ filters }] }; 1.1: [{ index, name, count }]
    const list: Req[] = Array.isArray(rf) ? rf : (rf?.sections ?? []).flatMap((sec) => sec.filters ?? []);
    const reqs = list.filter((r) => isItem(r.name)).map((r) => ({ name: r.name as string, count: Math.max(1, Math.floor(Number(r.count) || 1)) }));
    if (reqs.length) out.requests = reqs;
  }
  return out;
}

function moduleRequests(prototype: string, modules?: string[]): ItemRequest[] {
  const inventory = MODULE_INVENTORY[prototype];
  if (!inventory || !modules?.length) return [];
  const byName = new Map<string, number[]>();
  modules.forEach((m, slot) => {
    if (!m) return;
    if (!byName.has(m)) byName.set(m, []);
    byName.get(m)!.push(slot);
  });
  return [...byName].map(([name, slots]) => ({
    id: { name },
    items: { in_inventory: slots.map((stack) => ({ inventory, stack })) },
  }));
}

/**
 * Copper wires: a minimum spanning tree over poles in reach of each other.
 * Gives the same networks as the editor with few wires per pole (the game
 * caps copper connections per pole).
 */
function poleWires(entities: readonly PlacedEntity[]): BlueprintWire[] {
  const poles = entities.map((e, i) => ({ i, p: poleInfo(e) })).filter((x) => x.p);
  const edges: { a: number; b: number; d2: number }[] = [];
  for (let i = 0; i < poles.length; i++)
    for (let j = i + 1; j < poles.length; j++) {
      const a = poles[i]!.p!, b = poles[j]!.p!;
      const reach = Math.min(a.reach, b.reach);
      const d2 = (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2;
      if (d2 <= reach * reach + 1e-9) edges.push({ a: poles[i]!.i, b: poles[j]!.i, d2 });
    }
  edges.sort((x, y) => x.d2 - y.d2 || x.a - y.a || x.b - y.b);
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const wires: BlueprintWire[] = [];
  for (const { a, b } of edges) {
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    parent.set(ra, rb);
    wires.push([a, POLE_COPPER, b, POLE_COPPER]);
  }
  return wires;
}

/** Pair underground belts along their line like the game: an entrance links to the next exit in range. */
export function undergroundRoles(entities: readonly PlacedEntity[]): Map<string, 'input' | 'output'> {
  const roles = new Map<string, 'input' | 'output'>();
  const lines = new Map<string, PlacedEntity[]>();
  for (const e of entities) {
    if (ENTITIES[e.name]?.kind !== 'underground-belt') continue;
    const k = `${e.name}|${e.direction}|${e.direction % 2 === 0 ? e.x : e.y}`;
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k)!.push(e);
  }
  for (const line of lines.values()) {
    const d = line[0]!.direction;
    const along = (e: PlacedEntity) => e.x * DX[d]! + e.y * DY[d]!;
    line.sort((a, b) => along(a) - along(b));
    let pending: PlacedEntity | undefined;
    for (const e of line) {
      const max = (ENTITIES[e.name]?.maxDistance ?? 4) + 1;
      if (pending && along(e) - along(pending) <= max) {
        roles.set(pending.id, 'input');
        roles.set(e.id, 'output');
        pending = undefined;
      } else {
        if (pending) roles.set(pending.id, 'input');
        pending = e;
      }
    }
    if (pending) roles.set(pending.id, 'input');
  }
  return roles;
}

/** Pipe-to-ground pairs face away from each other (each faces its above-ground side). */
function pipeToGroundDirections(entities: readonly PlacedEntity[]): Map<string, Direction> {
  const out = new Map<string, Direction>();
  const lines = new Map<string, PlacedEntity[]>();
  for (const e of entities) {
    if (ENTITIES[e.name]?.kind !== 'pipe-to-ground') continue;
    const k = `${e.name}|${e.direction % 2}|${e.direction % 2 === 0 ? e.x : e.y}`;
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k)!.push(e);
  }
  for (const line of lines.values()) {
    const vertical = line[0]!.direction % 2 === 0;
    line.sort((a, b) => (vertical ? a.y - b.y : a.x - b.x));
    for (let i = 0; i + 1 < line.length; i += 2) {
      const a = line[i]!, b = line[i + 1]!;
      const dist = vertical ? b.y - a.y : b.x - a.x;
      if (dist > (ENTITIES[a.name]?.maxDistance ?? 10) + 1) continue;
      out.set(a.id, vertical ? 0 : 3);
      out.set(b.id, vertical ? 2 : 1);
    }
  }
  return out;
}

// ---- import --------------------------------------------------------------

/**
 * Buildings renamed in 2.0. Only applied to pre-2.0 blueprints: "stack-inserter"
 * is a different (Space Age) building in 2.0. Filter inserters became the
 * filter setting on ordinary inserters.
 */
const RAIL_PIECE = /(^|-)(straight|curved|half-diagonal)-rail(-[ab])?$|^rail-ramp$|^rail-support$/;
const RAIL_PARTS = new Set(['rail-signal', 'train-stop', 'rolling-stock']);

const LEGACY_NAMES: Record<string, string> = {
  'logistic-chest-active-provider': 'active-provider-chest',
  'logistic-chest-passive-provider': 'passive-provider-chest',
  'logistic-chest-storage': 'storage-chest',
  'logistic-chest-buffer': 'buffer-chest',
  'logistic-chest-requester': 'requester-chest',
  'filter-inserter': 'fast-inserter',
  'stack-inserter': 'bulk-inserter',
  'stack-filter-inserter': 'bulk-inserter',
};

export interface ImportResult {
  clipboard: Clipboard | null;
  /** Entity names the planner doesn't have (count per name). */
  unknown: Record<string, number>;
  label?: string;
}

/** Turn a blueprint into an editor clipboard, ready to paste. */
export function blueprintToClipboard(bp: Blueprint): ImportResult {
  const unknown: Record<string, number> = {};
  // 1.1 and older use 8-way directions; 2.0 (internally 1.2 while in development) uses 16-way.
  const legacy = (bp.version ?? 0) < encodeVersion(1, 2);
  const placed: Omit<PlacedEntity, 'id'>[] = [];
  const rails: Omit<PlacedRail, 'id'>[] = [];
  let lostTrack = false;
  const lostRail = (name: string) => {
    unknown[name] = (unknown[name] ?? 0) + 1;
    lostTrack = true;
  };
  for (const be of bp.entities ?? []) {
    const r = readRail(be, legacy);
    if (r === undefined) continue;
    if (r) rails.push(r);
    else lostRail(legacy ? `${be.name} (1.x diagonal or curve)` : be.name);
  }
  // When some track can't be read, its signals, stops and trains are left out
  // too, rather than floating beside missing track.
  for (const orig of bp.entities ?? []) {
    if (RAIL_PIECE.test(orig.name)) continue;
    const be = legacy && LEGACY_NAMES[orig.name] ? { ...orig, name: LEGACY_NAMES[orig.name]! } : orig;
    const def = ENTITIES[be.name];
    // Trains are not placed: they stand on track and are not part of a layout.
    if (!def || def.kind === 'rolling-stock' || (lostTrack && RAIL_PARTS.has(def.kind))) {
      unknown[be.name] = (unknown[be.name] ?? 0) + 1;
      continue;
    }
    const raw = be.direction ?? 0;
    // Signals on 45° track face a diagonal: keep the quarter below and mark it.
    const diagonalSignal = def.kind === 'rail-signal' && (legacy ? raw % 2 === 1 : raw % 4 === 2);
    let dir = (diagonalSignal ? Math.floor(legacy ? raw / 2 : raw / 4) : Math.round(legacy ? raw / 2 : raw / 4) % 4) as Direction;
    if (def.kind === 'inserter') dir = ((dir + 2) % 4) as Direction;
    const { w, h } = footprint(def, dir);
    const e: Omit<PlacedEntity, 'id'> = {
      name: be.name,
      x: Math.round(be.position.x - w / 2),
      y: Math.round(be.position.y - h / 2),
      direction: dir,
    };
    if (diagonalSignal) e.diagonal = true;
    if (be.recipe && gameRecipeOk(be.recipe)) e.recipe = be.recipe;
    const modules = readModules(be, def.moduleSlots ?? 0);
    if (modules) e.modules = modules;
    Object.assign(e, readLogistics(def.kind, def.name, be));
    placed.push(e);
  }
  if (!placed.length && !rails.length) return { clipboard: null, unknown, label: bp.label };
  // Signals guard the track on their right: take their facing from the track beside them.
  if (rails.length)
    for (const e of placed) {
      if (ENTITIES[e.name]?.kind !== 'rail-signal') continue;
      const found = signalAt(rails as PlacedRail[], e.x, e.y, e.direction);
      if (found) {
        e.direction = found.direction as Direction;
        if (found.diagonal) e.diagonal = true;
        else delete e.diagonal;
      }
    }
  const b = groupBounds(placed, rails);
  const clipboard: Clipboard = { w: b.w, h: b.h, entities: placed.map((e) => ({ ...e, x: e.x - b.x, y: e.y - b.y })) };
  if (rails.length) clipboard.rails = rails.map((r) => ({ ...r, x: r.x - b.x, y: r.y - b.y }));
  return { clipboard, unknown, label: bp.label };
}

/**
 * A rail piece from a blueprint entity: undefined when it is not track, null when
 * it is track the editor can't hold. 1.x straight rails along an axis are the
 * same piece in 2.0; 1.x diagonal and curved rails have no 2.0 equivalent (the
 * game keeps them as legacy rails), so they are reported.
 */
function readRail(be: BlueprintEntity, legacy: boolean): Omit<PlacedRail, 'id'> | null | undefined {
  if (!RAIL_PIECE.test(be.name)) return undefined;
  const raw = be.direction ?? 0;
  let r: Omit<PlacedRail, 'id'> | undefined;
  if (legacy) {
    if (be.name === 'straight-rail' && raw % 2 === 0) r = { name: 'straight-rail', x: be.position.x, y: be.position.y, direction: raw % 4 === 0 ? 0 : 4 };
  } else if (isRailName(be.name)) r = { name: be.name, x: be.position.x, y: be.position.y, direction: raw };
  return r && railValid(r) ? r : null;
}

const gameRecipeOk = (r: string) => !!gameData.recipes[r];

function readModules(be: BlueprintEntity, slots: number): string[] | undefined {
  if (!slots || !be.items) return undefined;
  const out: string[] = Array.from({ length: slots }, () => '');
  if (Array.isArray(be.items)) {
    for (const req of be.items) {
      const name = req.id?.name;
      if (!name || !gameData.modules[name]) continue;
      for (const pos of req.items?.in_inventory ?? []) if (pos.stack < slots) out[pos.stack] = name;
    }
  } else {
    // 1.x: { "speed-module": 2 } fills slots in order
    let i = 0;
    for (const [name, n] of Object.entries(be.items)) {
      if (!gameData.modules[name]) continue;
      for (let k = 0; k < n && i < slots; k++) out[i++] = name;
    }
  }
  return out.some(Boolean) ? out : undefined;
}
