// Layout data model for the grid editor. Pure functions only, so it can be
// tested without a canvas and shared with the rate engine.

import type { Entity } from '../data/types';
import { ENTITIES, isRotatable } from './catalog';
import { evenFloor, moveRail, railBounds, railTiles, railValid, rotateRail, type PlacedRail } from './rails';

export type { PlacedRail } from './rails';

/** 0 = north, 1 = east, 2 = south, 3 = west */
export type Direction = 0 | 1 | 2 | 3;

export interface PlacedEntity {
  id: string;
  /** prototype name, e.g. "assembling-machine-2" */
  name: string;
  /** top-left tile of the (rotated) footprint */
  x: number;
  y: number;
  direction: Direction;
  recipe?: string;
  modules?: string[];
  /** Inserters: item filters (up to 5). Splitters: the first entry is the filter item. */
  filters?: string[];
  /** Inserters: filters exclude instead of allow. */
  filterMode?: 'blacklist';
  /** Splitters: preferred input and output side, seen facing the way items travel. */
  inputPriority?: 'left' | 'right';
  outputPriority?: 'left' | 'right';
  /** Rail signals on 45° track: the 16-way facing is direction * 4 + 2. */
  diagonal?: boolean;
  /** Requester and buffer chests: logistic requests. */
  requests?: { name: string; count: number }[];
}

export interface Layout {
  version: 1;
  entities: PlacedEntity[];
  /** water tiles as "x,y" keys */
  water: string[];
  /** Rail track pieces (2.0 blueprint form). Signals and train stops are entities. */
  rails?: PlacedRail[];
  /** City-block grid shown on the map: lines at k·pitch + offset, with a rail corridor of the given width centred on each. */
  blockGrid?: BlockGrid;
}

export interface BlockGrid {
  pitch: number;
  offset: number;
  corridor: number;
}

/** A block grid is usable when the pitch is even and leaves room between corridors. */
export function validBlockGrid(g: unknown): g is BlockGrid {
  const b = g as BlockGrid;
  return !!b && Number.isInteger(b.pitch) && Number.isInteger(b.offset) && Number.isInteger(b.corridor) && b.pitch >= 16 && b.pitch <= 1000 && b.corridor >= 0 && b.corridor < b.pitch - 4;
}

/** Which block a tile is in: block (i, j) spans grid lines i..i+1 and j..j+1. */
export function blockOf(g: BlockGrid, x: number, y: number): [number, number] {
  return [Math.floor((x - g.offset) / g.pitch), Math.floor((y - g.offset) / g.pitch)];
}

/** Whether a tile lies in a rail corridor of the grid. */
export function inCorridor(g: BlockGrid, x: number, y: number): boolean {
  const h = g.corridor / 2;
  const d = (v: number) => {
    const m = (((v + 0.5 - g.offset) % g.pitch) + g.pitch) % g.pitch;
    return Math.min(m, g.pitch - m);
  };
  return d(x) < h || d(y) < h;
}

export const emptyLayout = (): Layout => ({ version: 1, entities: [], water: [] });

export const tileKey = (x: number, y: number) => `${x},${y}`;

export function footprint(def: Pick<Entity, 'width' | 'height'>, direction: Direction) {
  return direction % 2 === 0
    ? { w: def.width, h: def.height }
    : { w: def.height, h: def.width };
}

export function entityRect(e: PlacedEntity) {
  const def = ENTITIES[e.name];
  const { w, h } = footprint(def ?? { width: 1, height: 1 }, e.direction);
  return { x: e.x, y: e.y, w, h };
}

export function tilesOf(rect: { x: number; y: number; w: number; h: number }) {
  const out: [number, number][] = [];
  for (let dy = 0; dy < rect.h; dy++) for (let dx = 0; dx < rect.w; dx++) out.push([rect.x + dx, rect.y + dy]);
  return out;
}

/** Map from tile key to the id of the entity covering it. Rails count too, under buildings. */
export function buildOccupancy(entities: readonly PlacedEntity[], rails: readonly PlacedRail[] = []) {
  const occ = new Map<string, string>();
  for (const r of rails) for (const k of railTiles(r)) occ.set(k, r.id);
  for (const e of entities) for (const [x, y] of tilesOf(entityRect(e))) occ.set(tileKey(x, y), e.id);
  return occ;
}

/** Occupancy of a whole layout: buildings and rails. */
export const layoutOccupancy = (layout: Layout) => buildOccupancy(layout.entities, layout.rails);

/** Top-left tile so the footprint is centred on the cursor tile (like the game). */
export function anchorForCursor(name: string, direction: Direction, cx: number, cy: number) {
  const def = ENTITIES[name];
  const { w, h } = footprint(def, direction);
  return { x: cx - Math.floor((w - 1) / 2), y: cy - Math.floor((h - 1) / 2) };
}

export type PlaceCheck = { ok: true } | { ok: false; reason: string };

export function canPlace(
  occ: Map<string, string>,
  waterSet: Set<string>,
  name: string,
  x: number,
  y: number,
  direction: Direction,
  ignoreId?: string,
): PlaceCheck {
  const def = ENTITIES[name];
  if (!def) return { ok: false, reason: `Unknown building ${name}` };
  const rect = { x, y, ...footprint(def, direction) };
  const tiles = tilesOf(rect);
  for (const [tx, ty] of tiles) {
    const k = tileKey(tx, ty);
    const other = occ.get(k);
    if (other && other !== ignoreId) return { ok: false, reason: 'Blocked by another building' };
  }
  if (def.kind === 'offshore-pump') {
    // The pump stands on the shore facing the water: the tile it faces must be
    // water and the tile behind it land (works for 1x1 and 1x2 pumps).
    const [front, back] = offshoreTiles(rect, direction);
    if (!waterSet.has(tileKey(front[0], front[1]))) return { ok: false, reason: 'Offshore pump must face water' };
    if (waterSet.has(tileKey(back[0], back[1]))) return { ok: false, reason: 'Offshore pump needs land behind it' };
    return { ok: true };
  }
  for (const [tx, ty] of tiles) if (waterSet.has(tileKey(tx, ty))) return { ok: false, reason: 'Cannot build on water' };
  return { ok: true };
}

/**
 * [front, back] tiles for a one-tile-wide offshore pump. A pump two tiles deep
 * has its front tile in the water; a one-tile pump faces the tile beyond it.
 */
function offshoreTiles(rect: { x: number; y: number; w: number; h: number }, d: Direction): [[number, number], [number, number]] {
  const { x, y, w, h } = rect;
  const depth = d % 2 === 0 ? h : w;
  const reach = depth >= 2 ? 0 : 1; // how far the front tile sits outside the footprint
  switch (d) {
    case 0: return [[x, y - reach], [x, y + h - 1]];
    case 2: return [[x, y + h - 1 + reach], [x, y]];
    case 1: return [[x + w - 1 + reach, y], [x, y]];
    case 3: return [[x - reach, y], [x + w - 1, y]];
  }
}

/**
 * Offshore pumps snap to the shore like in the game: keep the requested
 * direction if it works, otherwise use the first direction that faces water.
 */
export function autoOrientOffshore(occ: Map<string, string>, waterSet: Set<string>, cx: number, cy: number, preferred: Direction) {
  for (let i = 0; i < 4; i++) {
    const d = ((preferred + i) % 4) as Direction;
    const { x, y } = anchorForCursor('offshore-pump', d, cx, cy);
    if (canPlace(occ, waterSet, 'offshore-pump', x, y, d).ok) return { x, y, direction: d };
  }
  return null;
}

let idCounter = 0;
export const newId = () => `e${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export function placeEntity(layout: Layout, e: Omit<PlacedEntity, 'id'>): { layout: Layout; result: PlaceCheck; id?: string } {
  const occ = layoutOccupancy(layout);
  const water = new Set(layout.water);
  const result = canPlace(occ, water, e.name, e.x, e.y, e.direction);
  if (!result.ok) return { layout, result };
  const id = newId();
  return { layout: { ...layout, entities: [...layout.entities, { ...e, id }] }, result, id };
}

export function removeEntities(layout: Layout, ids: Iterable<string>): Layout {
  const s = new Set(ids);
  if (s.size === 0) return layout;
  const out: Layout = { ...layout, entities: layout.entities.filter((e) => !s.has(e.id)) };
  if (layout.rails?.some((r) => s.has(r.id))) out.rails = layout.rails.filter((r) => !s.has(r.id));
  return out;
}

/** Add rails, skipping exact duplicates and pieces that would run through a building. */
export function addRails(layout: Layout, rails: readonly Omit<PlacedRail, 'id'>[]): { layout: Layout; added: string[]; blocked: number } {
  const have = new Set((layout.rails ?? []).map(railKey));
  const occ = buildOccupancy(layout.entities);
  const water = new Set(layout.water);
  const added: PlacedRail[] = [];
  let blocked = 0;
  for (const r of rails) {
    const k = railKey(r);
    if (have.has(k)) continue;
    const placed = { ...r, id: newId() };
    if (railTiles(placed).some((t) => occ.has(t) || water.has(t))) {
      blocked++;
      continue;
    }
    have.add(k);
    added.push(placed);
  }
  if (!added.length) return { layout, added: [], blocked };
  return { layout: { ...layout, rails: [...(layout.rails ?? []), ...added] }, added: added.map((r) => r.id), blocked };
}

const railKey = (r: Omit<PlacedRail, 'id'>) => `${r.name}|${r.x}|${r.y}|${r.direction}`;


export function updateEntity(layout: Layout, id: string, patch: Partial<Omit<PlacedEntity, 'id'>>): Layout {
  return { ...layout, entities: layout.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

/** Rotate a placed entity clockwise in place, keeping its centre; fails silently if blocked. */
export function rotateEntity(layout: Layout, id: string): Layout {
  const e = layout.entities.find((x) => x.id === id);
  if (!e) return layout;
  const def = ENTITIES[e.name];
  if (!def || !isRotatable(def)) return layout;
  const dir = ((e.direction + 1) % 4) as Direction;
  const old = footprint(def, e.direction);
  const next = footprint(def, dir);
  const nx = e.x + Math.floor((old.w - next.w) / 2);
  const ny = e.y + Math.floor((old.h - next.h) / 2);
  const occ = layoutOccupancy(layout);
  const check = canPlace(occ, new Set(layout.water), e.name, nx, ny, dir, id);
  if (!check.ok) return layout;
  return updateEntity(layout, id, { direction: dir, x: nx, y: ny });
}

export function setWater(layout: Layout, tiles: [number, number][], on: boolean): Layout {
  const set = new Set(layout.water);
  const occ = layoutOccupancy(layout);
  let changed = false;
  for (const [x, y] of tiles) {
    const k = tileKey(x, y);
    if (on) {
      if (occ.has(k) || set.has(k)) continue; // never flood a building
      set.add(k);
      changed = true;
    } else if (set.delete(k)) changed = true;
  }
  return changed ? { ...layout, water: [...set] } : layout;
}

/** Tiles of a square brush centred on cx,cy. */
export function brushTiles(cx: number, cy: number, size: number): [number, number][] {
  const r0 = -Math.floor((size - 1) / 2);
  const out: [number, number][] = [];
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) out.push([cx + r0 + dx, cy + r0 + dy]);
  return out;
}

/** Tiles on a straight line from a to b, snapped to the dominant axis (belt drag). */
export function lineTiles(ax: number, ay: number, bx: number, by: number): { tiles: [number, number][]; direction: Direction } {
  const dx = bx - ax;
  const dy = by - ay;
  const tiles: [number, number][] = [];
  let direction: Direction;
  if (Math.abs(dx) >= Math.abs(dy)) {
    direction = dx >= 0 ? 1 : 3;
    const s = Math.sign(dx) || 1;
    for (let i = 0; i <= Math.abs(dx); i++) tiles.push([ax + i * s, ay]);
  } else {
    direction = dy >= 0 ? 2 : 0;
    const s = Math.sign(dy);
    for (let i = 0; i <= Math.abs(dy); i++) tiles.push([ax, ay + i * s]);
  }
  return { tiles, direction };
}

/** A small lake so a fresh greenfield map has somewhere for offshore pumps. */
export function starterLayout(): Layout {
  const water: string[] = [];
  for (let y = -6; y <= 6; y++)
    for (let x = -30; x <= -18; x++) {
      const nx = (x + 24) / 7;
      const ny = y / 6.5;
      if (nx * nx + ny * ny <= 1) water.push(tileKey(x, y));
    }
  return { version: 1, entities: [], water };
}

export function parseLayout(json: string): Layout {
  const raw = JSON.parse(json);
  if (!raw || !Array.isArray(raw.entities) || !Array.isArray(raw.water)) throw new Error('Not a layout file');
  const entities: PlacedEntity[] = raw.entities
    .filter((e: PlacedEntity) => typeof e?.name === 'string' && ENTITIES[e.name] && Number.isInteger(e.x) && Number.isInteger(e.y))
    .map((e: PlacedEntity) => ({ ...e, id: typeof e.id === 'string' ? e.id : newId(), direction: ((e.direction ?? 0) & 3) as Direction }));
  const out: Layout = { version: 1, entities, water: raw.water.filter((k: unknown) => typeof k === 'string') };
  if (Array.isArray(raw.rails)) {
    const rails = (raw.rails as PlacedRail[])
      .filter((r) => r && railValid(r))
      .map((r) => ({ id: typeof r.id === 'string' ? r.id : newId(), name: r.name, x: r.x, y: r.y, direction: r.direction }));
    if (rails.length) out.rails = rails;
  }
  if (validBlockGrid(raw.blockGrid)) out.blockGrid = { pitch: raw.blockGrid.pitch, offset: raw.blockGrid.offset, corridor: raw.blockGrid.corridor };
  return out;
}

// ---- selections, clipboard and rotation of groups ---------------------------

/** A copied group of buildings (and rails), positioned relative to its bounding box. */
export interface Clipboard {
  entities: Omit<PlacedEntity, 'id'>[];
  /** Rails, relative to the same corner. When there are rails, w and h are even and the clipboard moves in steps of 2. */
  rails?: Omit<PlacedRail, 'id'>[];
  w: number;
  h: number;
}

export function boundsOf(entities: readonly PlacedEntity[] | readonly Omit<PlacedEntity, 'id'>[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of entities) {
    const r = entityRect(e as PlacedEntity);
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Bounds of buildings and rails together; with rails, the corner and size are even. */
export function groupBounds(entities: readonly Omit<PlacedEntity, 'id'>[], rails: readonly Omit<PlacedRail, 'id'>[] = []) {
  const parts = [] as { x: number; y: number; w: number; h: number }[];
  if (entities.length) parts.push(boundsOf(entities));
  if (rails.length) parts.push(railBounds(rails as PlacedRail[]));
  if (!parts.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Math.min(...parts.map((b) => b.x)), y0 = Math.min(...parts.map((b) => b.y));
  let x1 = Math.max(...parts.map((b) => b.x + b.w)), y1 = Math.max(...parts.map((b) => b.y + b.h));
  if (rails.length) {
    x0 = evenFloor(x0);
    y0 = evenFloor(y0);
    x1 = -evenFloor(-x1);
    y1 = -evenFloor(-y1);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function copyToClipboard(entities: readonly PlacedEntity[], rails: readonly PlacedRail[] = []): Clipboard | null {
  if (!entities.length && !rails.length) return null;
  const b = groupBounds(entities, rails);
  const clip: Clipboard = {
    w: b.w,
    h: b.h,
    entities: entities.map(({ id: _id, ...e }) => ({ ...e, x: e.x - b.x, y: e.y - b.y, modules: e.modules ? [...e.modules] : undefined })),
  };
  if (rails.length) clip.rails = rails.map(({ id: _id, ...r }) => moveRail(r, -b.x, -b.y));
  return clip;
}

/** Rotate a clipboard 90° clockwise. Buildings that can't turn keep their direction but still move. */
export function rotateClipboard(clip: Clipboard): Clipboard {
  const out: Clipboard = {
    w: clip.h,
    h: clip.w,
    entities: clip.entities.map((e) => {
      const r = entityRect(e as PlacedEntity);
      const def = ENTITIES[e.name];
      const turns = def && (isRotatable(def) || def.width !== def.height);
      const direction = (turns ? (e.direction + 1) % 4 : e.direction) as Direction;
      return { ...e, direction, x: clip.h - (r.y + r.h), y: r.x };
    }),
  };
  if (clip.rails?.length) out.rails = clip.rails.map((r) => rotateRail(r, clip.h));
  return out;
}

/** Top-left corner of the clipboard when centred on tile cx,cy (even when it holds rails). */
function clipOrigin(clip: Clipboard, cx: number, cy: number) {
  let ox = cx - Math.floor((clip.w - 1) / 2);
  let oy = cy - Math.floor((clip.h - 1) / 2);
  if (clip.rails?.length) {
    ox = evenFloor(ox);
    oy = evenFloor(oy);
  }
  return { ox, oy };
}

/** Where each clipboard entity lands when the clipboard is centred on tile cx,cy. */
export function clipboardAt(clip: Clipboard, cx: number, cy: number) {
  const { ox, oy } = clipOrigin(clip, cx, cy);
  return clip.entities.map((e) => ({ ...e, x: e.x + ox, y: e.y + oy }));
}

/** Where the clipboard's rails land when it is centred on tile cx,cy. */
export function clipboardRailsAt(clip: Clipboard, cx: number, cy: number) {
  const { ox, oy } = clipOrigin(clip, cx, cy);
  return (clip.rails ?? []).map((r) => moveRail(r, ox, oy));
}

/** Paste: place every building and rail that fits; returns how many were blocked. */
export function pasteClipboard(layout: Layout, clip: Clipboard, cx: number, cy: number): { layout: Layout; placed: string[]; blocked: number } {
  // Rails first, so buildings in the clipboard can't land on the pasted track.
  const withRails = addRails(layout, clipboardRailsAt(clip, cx, cy));
  layout = withRails.layout;
  const occ = layoutOccupancy(layout);
  const water = new Set(layout.water);
  const added: PlacedEntity[] = [];
  let blocked = withRails.blocked;
  for (const e of clipboardAt(clip, cx, cy)) {
    if (!canPlace(occ, water, e.name, e.x, e.y, e.direction).ok) {
      blocked++;
      continue;
    }
    const placed = { ...e, id: newId() };
    added.push(placed);
    for (const [x, y] of tilesOf(entityRect(placed))) occ.set(tileKey(x, y), placed.id);
  }
  const placed = [...withRails.added, ...added.map((e) => e.id)];
  if (!added.length) return { layout, placed, blocked };
  return { layout: { ...layout, entities: [...layout.entities, ...added] }, placed, blocked };
}

/** Rotate a group of placed buildings and rails 90° clockwise around their centre. Unchanged if anything would collide. */
export function rotateGroup(layout: Layout, ids: readonly string[]): Layout {
  const set = new Set(ids);
  const group = layout.entities.filter((e) => set.has(e.id));
  const rails = (layout.rails ?? []).filter((r) => set.has(r.id));
  if (!group.length && !rails.length) return layout;
  if (group.length === 1 && !rails.length) return rotateEntity(layout, group[0]!.id);
  const b = groupBounds(group, rails);
  const rotated = rotateClipboard(copyToClipboard(group, rails)!);
  // keep the centre where it was
  let ox = b.x + Math.floor((b.w - rotated.w) / 2);
  let oy = b.y + Math.floor((b.h - rotated.h) / 2);
  if (rails.length) {
    ox = evenFloor(ox);
    oy = evenFloor(oy);
  }
  const otherRails = (layout.rails ?? []).filter((r) => !set.has(r.id));
  const movedRails = rails.map((r, i) => ({ ...moveRail(rotated.rails![i]!, ox, oy), id: r.id }));
  const others = layout.entities.filter((e) => !set.has(e.id));
  const occ = buildOccupancy(others, [...otherRails, ...movedRails]);
  const water = new Set(layout.water);
  const blockers = buildOccupancy(others);
  for (const r of movedRails) if (railTiles(r).some((t) => blockers.has(t) || water.has(t))) return layout;
  const moved = group.map((e, i) => ({ ...e, ...rotated.entities[i], id: e.id, x: rotated.entities[i]!.x + ox, y: rotated.entities[i]!.y + oy }));
  for (const e of moved) {
    if (!canPlace(occ, water, e.name, e.x, e.y, e.direction).ok) return layout;
    for (const [x, y] of tilesOf(entityRect(e))) occ.set(tileKey(x, y), e.id);
  }
  const byId = new Map(moved.map((e) => [e.id, e]));
  const railById = new Map(movedRails.map((r) => [r.id, r]));
  const out: Layout = { ...layout, entities: layout.entities.map((e) => byId.get(e.id) ?? e) };
  if (rails.length) out.rails = layout.rails!.map((r) => railById.get(r.id) ?? r);
  return out;
}

/** Ids of rails that touch a tile rectangle (inclusive corners). */
export function railsInBox(rails: readonly PlacedRail[] = [], ax: number, ay: number, bx: number, by: number): string[] {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  return rails
    .filter((r) =>
      railTiles(r).some((k) => {
        const [x, y] = k.split(',').map(Number);
        return x! >= x0 && x! <= x1 && y! >= y0 && y! <= y1;
      }),
    )
    .map((r) => r.id);
}

/** Ids of buildings that overlap a tile rectangle (inclusive corners). */
export function entitiesInBox(entities: readonly PlacedEntity[], ax: number, ay: number, bx: number, by: number): string[] {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx) + 1;
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by) + 1;
  return entities
    .filter((e) => {
      const r = entityRect(e);
      return r.x < x1 && x0 < r.x + r.w && r.y < y1 && y0 < r.y + r.h;
    })
    .map((e) => e.id);
}
