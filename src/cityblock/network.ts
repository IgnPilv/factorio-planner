// Electric pole and roboport networks, from the game's prototype values.
// Pure functions on centre positions, so the layout editor and the city-block
// planner can share them.
//
// Game rules used (Factorio 2.x, values from data/nauvis.json):
// - A pole powers every building that overlaps the square centre ± supply_area_distance
//   (substation: 9, so an 18x18 area).
// - Two poles can be wired when the distance between their centres is at most the
//   smaller of their maximum_wire_distance values (substation: 18).
// - A roboport's logistics zone is centre ± logistics_radius (25 → 50x50) and its
//   construction zone centre ± construction_radius (55 → 110x110).
// - Two roboports join one network when their connection squares
//   (centre ± logistics_connection_distance, which defaults to the logistics radius)
//   touch or overlap, so centres at most 50 tiles apart on both axes.

import { gameData } from '../data';
import type { Entity } from '../data/types';

/** A building by its centre (tile coordinates; a 2x2 building centred on a tile corner has integer centre). */
export interface Node {
  id: string;
  name: string;
  x: number;
  y: number;
}

/** Half-open rectangle in tile coordinates: tiles x0..x1-1, y0..y1-1. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const def = (name: string): Entity | undefined => gameData.entities[name];

export const isPole = (n: Node) => def(n.name)?.kind === 'pole';
export const isRoboport = (n: Node) => def(n.name)?.kind === 'roboport';

export function supplyRect(n: Node): Rect | undefined {
  const r = def(n.name)?.supplyAreaDistance;
  if (r === undefined) return undefined;
  return { x0: n.x - r, y0: n.y - r, x1: n.x + r, y1: n.y + r };
}

export function logisticsRect(n: Node): Rect | undefined {
  const r = def(n.name)?.logisticsRadius;
  return r === undefined ? undefined : { x0: n.x - r, y0: n.y - r, x1: n.x + r, y1: n.y + r };
}

export function constructionRect(n: Node): Rect | undefined {
  const r = def(n.name)?.constructionRadius;
  return r === undefined ? undefined : { x0: n.x - r, y0: n.y - r, x1: n.x + r, y1: n.y + r };
}

/** Can these two poles be connected with a copper wire? */
export function canWire(a: Node, b: Node): boolean {
  const ra = def(a.name)?.wireReach;
  const rb = def(b.name)?.wireReach;
  if (ra === undefined || rb === undefined) return false;
  const reach = Math.min(ra, rb);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= reach * reach + 1e-9;
}

/** Do these two roboports join the same logistic network? */
export function roboportsConnect(a: Node, b: Node): boolean {
  const ra = def(a.name)?.logisticsConnectionDistance;
  const rb = def(b.name)?.logisticsConnectionDistance;
  if (ra === undefined || rb === undefined) return false;
  return Math.abs(a.x - b.x) <= ra + rb && Math.abs(a.y - b.y) <= ra + rb;
}

/** Union-find components of nodes under a symmetric link test. */
export function components(nodes: Node[], linked: (a: Node, b: Node) => boolean): Node[][] {
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      if (linked(nodes[i], nodes[j])) parent[find(i)] = find(j);
  const groups = new Map<number, Node[]>();
  nodes.forEach((n, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(n);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** Every pair of poles that can be wired (the game auto-connects up to 5 neighbours; this lists all candidates). */
export function wireLinks(nodes: Node[]): [Node, Node][] {
  const poles = nodes.filter(isPole);
  const out: [Node, Node][] = [];
  for (let i = 0; i < poles.length; i++)
    for (let j = i + 1; j < poles.length; j++) if (canWire(poles[i], poles[j])) out.push([poles[i], poles[j]]);
  return out;
}

export interface Coverage {
  total: number;
  covered: number;
  /** Uncovered tiles, merged into horizontal runs. */
  gaps: Rect[];
}

/**
 * Which tiles of `area` fall inside at least one of `zones`. A tile counts as
 * covered when its whole square is inside a zone (zones here always have
 * integer or half-integer edges, so this is exact for the game's areas).
 */
export function coverage(area: Rect, zones: Rect[]): Coverage {
  const w = area.x1 - area.x0;
  const h = area.y1 - area.y0;
  const grid = new Uint8Array(Math.max(0, w * h));
  for (const z of zones) {
    const x0 = Math.max(area.x0, Math.ceil(z.x0));
    const x1 = Math.min(area.x1, Math.floor(z.x1));
    const y0 = Math.max(area.y0, Math.ceil(z.y0));
    const y1 = Math.min(area.y1, Math.floor(z.y1));
    for (let y = y0; y < y1; y++) grid.fill(1, (y - area.y0) * w + (x0 - area.x0), (y - area.y0) * w + (x1 - area.x0));
  }
  let covered = 0;
  const gaps: Rect[] = [];
  for (let y = 0; y < h; y++) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const c = x < w ? grid[y * w + x] : 1;
      if (c) covered += x < w ? 1 : 0;
      if (!c && run < 0) run = x;
      if (c && run >= 0) {
        gaps.push({ x0: area.x0 + run, y0: area.y0 + y, x1: area.x0 + x, y1: area.y0 + y + 1 });
        run = -1;
      }
    }
  }
  return { total: w * h, covered, gaps: mergeRuns(gaps) };
}

/** Merge vertically stacked runs with the same x span into rectangles. */
function mergeRuns(runs: Rect[]): Rect[] {
  const open = new Map<string, Rect>();
  const out: Rect[] = [];
  for (const r of runs) {
    const k = `${r.x0},${r.x1}`;
    const prev = open.get(k);
    if (prev && prev.y1 === r.y0) prev.y1 = r.y1;
    else {
      if (prev) out.push(prev);
      open.set(k, { ...r });
    }
  }
  return [...out, ...open.values()];
}

/** Centre of a building placed by its top-left tile (the layout editor's convention). */
export function centreOf(e: { name: string; x: number; y: number; direction?: number }): { x: number; y: number } {
  const d = def(e.name);
  const w = d?.width ?? 1;
  const h = d?.height ?? 1;
  const rotated = (e.direction ?? 0) % 2 === 1;
  return { x: e.x + (rotated ? h : w) / 2, y: e.y + (rotated ? w : h) / 2 };
}
