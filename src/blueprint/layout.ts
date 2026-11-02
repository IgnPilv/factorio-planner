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
import { boundsOf, footprint, type Clipboard, type Direction, type PlacedEntity } from '../editor/model';
import { poleInfo } from '../editor/power';
import {
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

  // Shift so the blueprint sits near the origin; the game re-centres anyway.
  const b = known.length ? boundsOf(known) : { x: 0, y: 0, w: 0, h: 0 };

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
    if (def.kind === 'underground-belt') be.type = ugRole.get(e.id) ?? 'input';
    if (e.recipe && RECIPE_PROTOTYPES.has(def.prototype) && def.kind !== 'rocket-silo') be.recipe = e.recipe;
    const items = moduleRequests(def.prototype, e.modules);
    if (items.length) be.items = items;
    return be;
  });

  return {
    blueprint: makeBlueprint(out, {
      label: opts.label,
      wires: poleWires(known),
      itemOf: (n) => ENTITIES[n]?.item ?? n,
    }),
    skipped: entities.length - known.length,
  };
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

export interface ImportResult {
  clipboard: Clipboard | null;
  /** Entity names the planner doesn't have (count per name). */
  unknown: Record<string, number>;
  label?: string;
}

/** Turn a blueprint into an editor clipboard, ready to paste. */
export function blueprintToClipboard(bp: Blueprint): ImportResult {
  const unknown: Record<string, number> = {};
  const legacy = (bp.version ?? 0) < 2 ** 49; // before 2.0 directions were 8-way
  const placed: Omit<PlacedEntity, 'id'>[] = [];
  for (const be of bp.entities ?? []) {
    const def = ENTITIES[be.name];
    if (!def) {
      unknown[be.name] = (unknown[be.name] ?? 0) + 1;
      continue;
    }
    const raw = be.direction ?? 0;
    let dir = (Math.round(legacy ? raw / 2 : raw / 4) % 4) as Direction;
    if (def.kind === 'inserter') dir = ((dir + 2) % 4) as Direction;
    const { w, h } = footprint(def, dir);
    const e: Omit<PlacedEntity, 'id'> = {
      name: be.name,
      x: Math.round(be.position.x - w / 2),
      y: Math.round(be.position.y - h / 2),
      direction: dir,
    };
    if (be.recipe && gameRecipeOk(be.recipe)) e.recipe = be.recipe;
    const modules = readModules(be, def.moduleSlots ?? 0);
    if (modules) e.modules = modules;
    placed.push(e);
  }
  if (!placed.length) return { clipboard: null, unknown, label: bp.label };
  const b = boundsOf(placed);
  return {
    clipboard: { w: b.w, h: b.h, entities: placed.map((e) => ({ ...e, x: e.x - b.x, y: e.y - b.y })) },
    unknown,
    label: bp.label,
  };
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
