// Factorio blueprint strings: the JSON shape of a 2.0 blueprint and the
// encoding the game uses for copy/paste. A string is a version byte ("0")
// followed by base64 of the zlib-deflated JSON.
//
// Conventions checked against the game's prototype files (wube/factorio-data)
// and Factorio-Draftsman, which round-trips strings with the game:
//   - position is the entity's centre in tiles (x.5 for odd sizes)
//   - direction is 16-way: north 0, east 4, south 8, west 12; omitted for north
//   - copper wires are [entity, 5, entity, 5] (5 = pole copper connector)
//   - module requests go in `items` with inventory 4 for crafting machines and
//     furnaces, 3 for labs, 2 for mining drills, 1 for beacons

import { unzlibSync, zlibSync } from 'fflate';

export interface Position {
  x: number;
  y: number;
}

export interface ItemRequest {
  id: { name: string; quality?: string };
  items: { in_inventory?: { inventory: number; stack: number; count?: number }[]; grid_count?: number };
}

/** An entity before numbering: what callers build. */
export interface BlueprintEntityInput {
  name: string;
  position: Position;
  /** 0-15, north = 0, clockwise. Omitted when north. */
  direction?: number;
  recipe?: string;
  quality?: string;
  /** Underground belts: which end this is. */
  type?: 'input' | 'output';
  /** Module and other item requests (2.0 format). 1.x blueprints use a name -> count map. */
  items?: ItemRequest[] | Record<string, number>;
  /** 1.x copper wires: entity numbers of connected poles. */
  neighbours?: number[];
  [key: string]: unknown;
}

export interface BlueprintEntity extends BlueprintEntityInput {
  entity_number: number;
}

export type BlueprintWire = [number, number, number, number];

export interface BlueprintIcon {
  index: number;
  signal: { name: string; type?: string };
}

export interface Blueprint {
  item: 'blueprint';
  label?: string;
  description?: string;
  icons?: BlueprintIcon[];
  entities?: BlueprintEntity[];
  wires?: BlueprintWire[];
  tiles?: { name: string; position: Position }[];
  'snap-to-grid'?: Position;
  'absolute-snapping'?: boolean;
  'position-relative-to-grid'?: Position;
  version: number;
  [key: string]: unknown;
}

export const POLE_COPPER = 5;

/** Module inventory index per prototype type (defines.inventory). */
export const MODULE_INVENTORY: Record<string, number> = {
  'assembling-machine': 4,
  furnace: 4,
  'rocket-silo': 4,
  lab: 3,
  'mining-drill': 2,
  beacon: 1,
};

/** Factorio packs a version as four 16-bit numbers: major.minor.patch.dev. */
export function encodeVersion(major: number, minor: number, patch = 0, dev = 0): number {
  // 2^48 * major is far below 2^53, so plain numbers stay exact.
  return major * 2 ** 48 + minor * 2 ** 32 + patch * 2 ** 16 + dev;
}

export function decodeVersion(v: number): [number, number, number, number] {
  const major = Math.floor(v / 2 ** 48);
  const minor = Math.floor(v / 2 ** 32) % 2 ** 16;
  const patch = Math.floor(v / 2 ** 16) % 2 ** 16;
  const dev = v % 2 ** 16;
  return [major, minor, patch, dev];
}

/**
 * Version written into exported blueprints: 2.0.10.1, the stamp on the 2.0
 * blueprints in the game's own files. An early 2.0 version, so any 2.x game
 * accepts the string (games refuse blueprints from newer versions).
 */
export const BLUEPRINT_VERSION = encodeVersion(2, 0, 10, 1);

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Encode any blueprint-string JSON object ({blueprint}, {blueprint_book}, ...). */
export function encodeJsonString(obj: unknown): string {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  return '0' + toBase64(zlibSync(json, { level: 9 }));
}

/** Decode a blueprint string to its JSON object. Also accepts raw JSON, which 2.0 can import. */
export function decodeJsonString(str: string): Record<string, unknown> {
  const s = str.trim();
  if (!s) throw new Error('The blueprint string is empty');
  if (s.startsWith('{')) return JSON.parse(s);
  if (s[0] !== '0') throw new Error(`Unknown blueprint string version "${s[0]}"`);
  let bytes: Uint8Array;
  try {
    bytes = unzlibSync(fromBase64(s.slice(1).replace(/\s+/g, '')));
  } catch {
    throw new Error('Not a valid blueprint string (could not decompress it)');
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function encodeBlueprintString(bp: Blueprint): string {
  return encodeJsonString({ blueprint: bp });
}

/**
 * Decode a string holding a blueprint. For a blueprint book, returns the
 * active blueprint (or the first one found).
 */
export function decodeBlueprintString(str: string): Blueprint {
  const obj = decodeJsonString(str);
  const bp = findBlueprint(obj);
  if (!bp) {
    const kind = Object.keys(obj)[0] ?? 'nothing';
    throw new Error(kind === 'blueprint_book' ? 'This blueprint book has no blueprints in it' : `This string holds a ${kind.replace(/_/g, ' ')}, not a blueprint`);
  }
  return bp;
}

/** Every blueprint in a string (a lone blueprint, or all of a book's, nested books included), in book order. */
export function decodeAllBlueprints(str: string): Blueprint[] {
  const out: Blueprint[] = [];
  const walk = (obj: Record<string, unknown>) => {
    if (obj.blueprint) out.push(obj.blueprint as Blueprint);
    const book = obj.blueprint_book as { blueprints?: ({ index: number } & Record<string, unknown>)[] } | undefined;
    for (const entry of [...(book?.blueprints ?? [])].sort((a, b) => a.index - b.index)) walk(entry);
  };
  walk(decodeJsonString(str));
  return out;
}

export interface BlueprintBook {
  item: 'blueprint-book';
  label?: string;
  icons?: BlueprintIcon[];
  blueprints: { index: number; blueprint: Blueprint }[];
  active_index: number;
  version: number;
}

/** A blueprint book holding the given blueprints in order. */
export function makeBook(blueprints: Blueprint[], label?: string): BlueprintBook {
  const book: BlueprintBook = {
    item: 'blueprint-book',
    blueprints: blueprints.map((blueprint, index) => ({ index, blueprint })),
    active_index: 0,
    version: BLUEPRINT_VERSION,
  };
  if (label) book.label = label;
  return book;
}

export function encodeBookString(book: BlueprintBook): string {
  return encodeJsonString({ blueprint_book: book });
}

function findBlueprint(obj: Record<string, unknown>): Blueprint | undefined {
  if (obj.blueprint) return obj.blueprint as Blueprint;
  const book = obj.blueprint_book as { blueprints?: ({ index: number } & Record<string, unknown>)[]; active_index?: number } | undefined;
  if (!book?.blueprints?.length) return undefined;
  const sorted = [...book.blueprints].sort((a, b) => a.index - b.index);
  const active = sorted.find((b) => b.index === book.active_index);
  for (const entry of active ? [active, ...sorted] : sorted) {
    const found = findBlueprint(entry);
    if (found) return found;
  }
  return undefined;
}

export interface MakeBlueprintOptions {
  label?: string;
  description?: string;
  icons?: BlueprintIcon[];
  /** Wires between entities, by their index in the entities array (0-based). */
  wires?: BlueprintWire[];
  snapToGrid?: Position;
  absoluteSnapping?: boolean;
  positionRelativeToGrid?: Position;
  /** Item name of an entity, for the automatic icons. Defaults to the entity name. */
  itemOf?: (entityName: string) => string | undefined;
}

/**
 * Build a blueprint: numbers the entities from 1, renumbers wires from array
 * indices to entity numbers, and picks icons from the most common buildings.
 */
export function makeBlueprint(entities: BlueprintEntityInput[], opts: MakeBlueprintOptions = {}): Blueprint {
  const numbered = entities.map((e, i) => {
    const out: BlueprintEntity = { entity_number: i + 1, ...e };
    if (!out.direction) delete out.direction;
    return out;
  });
  const bp = { item: 'blueprint' } as Blueprint;
  if (opts.label) bp.label = opts.label;
  if (opts.description) bp.description = opts.description;
  bp.icons = opts.icons ?? autoIcons(entities, opts.itemOf);
  bp.entities = numbered;
  if (opts.wires?.length) bp.wires = opts.wires.map(([a, ca, b, cb]) => [a + 1, ca, b + 1, cb]);
  if (opts.snapToGrid) bp['snap-to-grid'] = opts.snapToGrid;
  if (opts.absoluteSnapping) bp['absolute-snapping'] = true;
  if (opts.positionRelativeToGrid) bp['position-relative-to-grid'] = opts.positionRelativeToGrid;
  bp.version = BLUEPRINT_VERSION;
  return bp;
}

function autoIcons(entities: { name: string }[], itemOf?: (n: string) => string | undefined): BlueprintIcon[] {
  const counts = new Map<string, number>();
  for (const e of entities) {
    const item = itemOf?.(e.name) ?? e.name;
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([name], i) => ({ index: i + 1, signal: { type: 'item', name } }));
}
