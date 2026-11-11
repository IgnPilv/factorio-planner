// The export written by the companion mod (mod/map-viewer-export/control.lua),
// and its decoded, render-ready form.

export const MARK_START = 'FACTORIO-MAP-VIEWER-EXPORT-1:';
export const MARK_END = ':END-FACTORIO-MAP-VIEWER-EXPORT';
/** Numbers per entity in a surface's flat entity list. */
export const FIELDS = 6;

type RGB = [number, number, number];

/** JSON as the mod writes it (helpers.table_to_json turns empty tables into {} or []). */
export interface RawExport {
  format: number;
  game_version?: string;
  mods?: Record<string, string>;
  tick?: number;
  player_force?: number;
  tiles: { name: string; color?: RGB }[];
  entities: {
    name: string; type?: string; w?: number; h?: number;
    color?: RGB; friendly_color?: RGB; enemy_color?: RGB; icon?: string;
  }[];
  recipes: { name: string; icon?: string }[] | Record<string, never>;
  forces: { index: number; name: string }[];
  surfaces: RawSurface[] | Record<string, never>;
}

export interface RawSurface {
  name: string;
  index: number;
  planet?: string;
  platform?: string;
  chunks: (number | string)[] | Record<string, never>;
  entities: number[] | Record<string, never>;
}

export interface Proto {
  name: string;
  type: string;
  w: number;
  h: number;
  icon?: string;
  /** 0-255 RGB used for this prototype on the map, by force class. */
  own: RGB;
  enemy: RGB;
  neutral: RGB;
}

export interface Chunk {
  cx: number;
  cy: number;
  /** Tile palette index per tile, row by row. */
  tiles: Uint16Array;
  /** Indices (entity numbers, not offsets) into the surface's entity arrays. */
  entities: number[];
}

export interface Surface {
  name: string;
  index: number;
  planet?: string;
  platform?: string;
  kind: 'planet' | 'platform' | 'other';
  chunks: Map<string, Chunk>;
  /** Bounds in chunk coordinates (inclusive). */
  minCx: number; minCy: number; maxCx: number; maxCy: number;
  count: number;
  proto: Uint32Array;
  /** Positions in tiles. */
  x: Float32Array;
  y: Float32Array;
  dir: Uint8Array;
  force: Uint16Array;
  /** 1-based recipe index, 0 = none. */
  recipe: Uint32Array;
}

export interface MapExport {
  gameVersion?: string;
  mods: Record<string, string>;
  tick: number;
  playerForce: number;
  tiles: { name: string; color: RGB }[];
  protos: Proto[];
  recipes: { name: string; icon?: string }[];
  forces: Map<number, string>;
  surfaces: Surface[];
}

const arr = <T>(v: T[] | Record<string, never> | undefined): T[] => (Array.isArray(v) ? v : []);

/** Map colours come as 0-1 or 0-255; returns 0-255. */
export function rgb(c: RGB | undefined, fallback: RGB): RGB {
  if (!c) return fallback;
  const scale = c.some((v) => v > 1) ? 1 : 255;
  return [Math.round(c[0] * scale), Math.round(c[1] * scale), Math.round(c[2] * scale)];
}

/** Expands "3*5,7,2*1018" into 1024 palette indices. */
export function parseRuns(runs: string, out = new Uint16Array(1024)): Uint16Array {
  let i = 0;
  for (const part of runs.split(',')) {
    if (!part) continue;
    const star = part.indexOf('*');
    const idx = Number(star < 0 ? part : part.slice(0, star));
    const n = star < 0 ? 1 : Number(part.slice(star + 1));
    out.fill(idx, i, Math.min(1024, i + n));
    i += n;
  }
  return out;
}

const NEUTRAL_BY_TYPE: Record<string, RGB> = {
  tree: [40, 90, 30],
  plant: [60, 120, 40],
  'simple-entity': [110, 100, 90],
  cliff: [120, 100, 70],
  resource: [140, 140, 140],
};
const DEFAULT_OWN: RGB = [64, 140, 200];
const DEFAULT_ENEMY: RGB = [200, 40, 40];

function protoOf(raw: RawExport['entities'][number]): Proto {
  const type = raw.type ?? 'unknown';
  const own = rgb(raw.color ?? raw.friendly_color, DEFAULT_OWN);
  return {
    name: raw.name,
    type,
    w: raw.w ?? 1,
    h: raw.h ?? 1,
    icon: raw.icon,
    own,
    enemy: rgb(raw.enemy_color, DEFAULT_ENEMY),
    neutral: rgb(raw.color, NEUTRAL_BY_TYPE[type] ?? own),
  };
}

function surfaceKind(s: RawSurface): Surface['kind'] {
  if (s.platform) return 'platform';
  if (s.planet) return 'planet';
  return 'other';
}

export function decodeExport(raw: RawExport): MapExport {
  if (raw.format !== 1) throw new Error(`Unsupported export format ${raw.format}. Update the website or the mod.`);
  const surfaces: Surface[] = [];
  for (const s of arr(raw.surfaces)) {
    const flat = arr(s.entities);
    const count = Math.floor(flat.length / FIELDS);
    const surface: Surface = {
      name: s.name, index: s.index, planet: s.planet, platform: s.platform, kind: surfaceKind(s),
      chunks: new Map(), minCx: Infinity, minCy: Infinity, maxCx: -Infinity, maxCy: -Infinity,
      count,
      proto: new Uint32Array(count), x: new Float32Array(count), y: new Float32Array(count),
      dir: new Uint8Array(count), force: new Uint16Array(count), recipe: new Uint32Array(count),
    };
    const c = arr(s.chunks);
    for (let i = 0; i + 2 < c.length; i += 3) {
      const cx = Number(c[i]), cy = Number(c[i + 1]);
      surface.chunks.set(`${cx},${cy}`, { cx, cy, tiles: parseRuns(String(c[i + 2])), entities: [] });
      surface.minCx = Math.min(surface.minCx, cx); surface.maxCx = Math.max(surface.maxCx, cx);
      surface.minCy = Math.min(surface.minCy, cy); surface.maxCy = Math.max(surface.maxCy, cy);
    }
    for (let e = 0; e < count; e++) {
      const o = e * FIELDS;
      surface.proto[e] = flat[o] - 1;
      surface.x[e] = flat[o + 1] / 8;
      surface.y[e] = flat[o + 2] / 8;
      surface.dir[e] = flat[o + 3];
      surface.force[e] = flat[o + 4];
      surface.recipe[e] = flat[o + 5];
      const key = `${Math.floor(surface.x[e] / 32)},${Math.floor(surface.y[e] / 32)}`;
      surface.chunks.get(key)?.entities.push(e);
    }
    if (surface.chunks.size) surfaces.push(surface);
  }
  const order = { planet: 0, platform: 1, other: 2 };
  surfaces.sort((a, b) => order[a.kind] - order[b.kind] || a.index - b.index);

  return {
    gameVersion: raw.game_version,
    mods: raw.mods && !Array.isArray(raw.mods) ? raw.mods : {},
    tick: raw.tick ?? 0,
    playerForce: raw.player_force ?? 1,
    tiles: arr(raw.tiles).map((t) => ({ name: t.name, color: rgb(t.color, [0, 0, 0]) })),
    protos: arr(raw.entities).map(protoOf),
    recipes: arr(raw.recipes),
    forces: new Map(arr(raw.forces).map((f) => [f.index, f.name])),
    surfaces,
  };
}

/** 'own' for the exporting player's force, 'enemy' for enemies, else 'neutral'. */
export function forceClass(map: MapExport, force: number): 'own' | 'enemy' | 'neutral' {
  if (force === map.playerForce) return 'own';
  const name = map.forces.get(force);
  if (name === 'enemy') return 'enemy';
  if (name === 'neutral' || name === undefined) return 'neutral';
  return 'own';
}

/** "iron-gear-wheel" -> "Iron gear wheel". */
export function prettyName(name: string): string {
  const s = name.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function surfaceTitle(s: Surface): string {
  if (s.platform) return s.platform;
  return prettyName(s.planet ?? s.name);
}
