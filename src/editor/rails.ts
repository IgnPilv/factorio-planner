// Rails in the layout editor.
//
// Rails are stored the way 2.0 blueprints store them: entity name, centre
// position and 16-way direction (see src/rails/blueprint.ts). That keeps import
// and export exact. Signals and train stops are ordinary 1x1 and 2x2 buildings;
// helpers here snap them next to a rail the way the game does.
//
// Rail ends always sit on integer points with fixed parity, so every move or
// rotation of rails has to keep even offsets (see evenFloor).

import { buildPiece, endOnGrid, footprintTiles, mod16, opposite, type Point, type RailEnd, type RailPiece, type RailType } from '../rails/geometry';
import { pieceFromEntity, railEntity } from '../rails/blueprint';

export interface PlacedRail {
  id: string;
  name: RailType;
  /** Entity centre, as in a blueprint. */
  x: number;
  y: number;
  /** 16-way blueprint direction. */
  direction: number;
}

export const RAIL_NAMES: ReadonlySet<string> = new Set<RailType>(['straight-rail', 'half-diagonal-rail', 'curved-rail-a', 'curved-rail-b']);
export const isRailName = (n: string): n is RailType => RAIL_NAMES.has(n);

/** Rails are crafted from the "rail" item whatever their shape. */
export const RAIL_ITEM = 'rail';

/** Largest even number not above n: offsets that keep rail parity. */
export const evenFloor = (n: number) => 2 * Math.floor(n / 2);

export function railPiece(r: Pick<PlacedRail, 'name' | 'x' | 'y' | 'direction'> & { id?: string }): RailPiece {
  return pieceFromEntity({ name: r.name, position: { x: r.x, y: r.y }, direction: r.direction }, r.id ?? '');
}

export function railFromPiece(p: RailPiece, id: string): PlacedRail {
  const e = railEntity(p);
  return { id, name: p.type, x: e.position.x, y: e.position.y, direction: e.direction ?? 0 };
}

/** A rail entity read from a blueprint or a file is valid when both its ends land on the rail grid. */
export function railValid(r: Pick<PlacedRail, 'name' | 'x' | 'y' | 'direction'>): boolean {
  if (!isRailName(r.name) || !Number.isInteger(r.x) || !Number.isInteger(r.y) || !Number.isInteger(r.direction)) return false;
  const p = railPiece(r);
  return endOnGrid(p.a) && endOnGrid(p.b);
}

const tileCache = new WeakMap<object, string[]>();
/** Tiles under a rail, as "x,y" keys. */
export function railTiles(r: PlacedRail): string[] {
  let t = tileCache.get(r);
  if (!t) {
    t = [...footprintTiles(railPiece(r))];
    tileCache.set(r, t);
  }
  return t;
}

/** Tile bounds of a set of rails (x, y inclusive start, w, h). */
export function railBounds(rails: readonly PlacedRail[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rails)
    for (const k of railTiles(r)) {
      const [x, y] = k.split(',').map(Number);
      x0 = Math.min(x0, x!);
      y0 = Math.min(y0, y!);
      x1 = Math.max(x1, x! + 1);
      y1 = Math.max(y1, y! + 1);
    }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const moveRail = <R extends Omit<PlacedRail, 'id'>>(r: R, dx: number, dy: number): R => ({ ...r, x: r.x + dx, y: r.y + dy });

/**
 * Rotate a rail 90° clockwise about the point (0, 0) and then shift it by (H, 0),
 * the same map as a clipboard rotation: (x, y) -> (H - y, x). H must be even.
 */
export function rotateRail<R extends Omit<PlacedRail, 'id'>>(r: R, H: number): R {
  const p = railPiece(r);
  const turn = (e: RailEnd): RailEnd => ({ x: H - e.y, y: e.x, dir: mod16(e.dir + 4) });
  const e = railEntity({ ...p, a: turn(p.a), b: turn(p.b) });
  return { ...r, x: e.position.x, y: e.position.y, direction: e.direction ?? 0 };
}

const endKey = (e: Point) => `${e.x},${e.y}`;

/** Rail ends that no other rail continues from. Each is ready to build from: dir is the heading out of it. */
export function freeEnds(rails: readonly PlacedRail[]): RailEnd[] {
  const count = new Map<string, { end: RailEnd; n: number }>();
  for (const r of rails) {
    const p = railPiece(r);
    for (const e of [p.a, p.b]) {
      // Ends meet when the same point is used with opposite headings.
      const k = `${endKey(e)}|${mod16(e.dir) % 8}`;
      const c = count.get(k);
      if (c) c.n++;
      else count.set(k, { end: e, n: 1 });
    }
  }
  return [...count.values()].filter((c) => c.n === 1).map((c) => c.end);
}

/** Nearest valid place to start new track near a point, heading `dir` (0, 4, 8, 12). */
export function snapStart(px: number, py: number, dir: number): RailEnd {
  const nearestOdd = (v: number) => 2 * Math.round((v - 1) / 2) + 1;
  const nearestEven = (v: number) => 2 * Math.round(v / 2);
  const ns = mod16(dir) % 8 === 0;
  return ns ? { x: nearestOdd(px), y: nearestEven(py), dir } : { x: nearestEven(px), y: nearestOdd(py), dir };
}

/** Where to start drawing track for the cursor at tile (tx, ty): a free rail end close by, else a new start. */
export function railStartAt(rails: readonly PlacedRail[], tx: number, ty: number, dir: number): RailEnd {
  const px = tx + 0.5, py = ty + 0.5;
  let best: RailEnd | undefined;
  let bestD = 2.6 ** 2;
  for (const e of freeEnds(rails)) {
    const d = (e.x - px) ** 2 + (e.y - py) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best ?? snapStart(px, py, dir);
}

// ---- route planning ----------------------------------------------------------

class Heap<T> {
  private a: { k: number; v: T }[] = [];
  get size() {
    return this.a.length;
  }
  push(k: number, v: T) {
    const a = this.a;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.k <= a[i]!.k) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!.v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.k < a[m]!.k) m = l;
        if (r < a.length && a[r]!.k < a[m]!.k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

const PIECE_COST: Record<RailType, number> = { 'straight-rail': 2, 'half-diagonal-rail': 4.47, 'curved-rail-a': 5.1, 'curved-rail-b': 5.0 };

/**
 * Plan track from `start` to the point (tx, ty), like the game's rail planner:
 * the shortest chain of pieces whose last end lands within reach of the target,
 * on a straight or 45° heading. Turns cost a little extra so routes stay
 * straight where they can. A target too tight to turn into gets the track that
 * comes closest without looping round.
 */
export function planRail(start: RailEnd, tx: number, ty: number, maxExpand = 6000): RailPiece[] {
  // Track ends on a straight or 45° heading, never halfway through a curve.
  const goal = (e: RailEnd) => e.dir % 2 === 0 && (e.x - tx) ** 2 + (e.y - ty) ** 2 <= 1.5 ** 2;
  const h = (e: Point) => Math.hypot(e.x - tx, e.y - ty);
  if (h(start) > 400 || h(start) <= 1.5) return [];
  type Node = { end: RailEnd; g: number; piece?: RailPiece; prev?: Node };
  const limit = 1.3 * h(start) + 8;
  const open = new Heap<Node>();
  const seen = new Map<string, number>();
  const root: Node = { end: start, g: 0 };
  open.push(h(start), root);
  let best: Node = root;
  let bestH = h(start);
  for (let i = 0; i < maxExpand && open.size; i++) {
    const n = open.pop()!;
    if (n !== root && goal(n.end)) {
      best = n;
      break;
    }
    const hn = h(n.end);
    if (hn < bestH && n.end.dir % 2 === 0) {
      bestH = hn;
      best = n;
    }
    for (const turn of [0, -1, 1] as const) {
      const p = buildPiece(n.end, turn);
      if (!p) continue;
      const g = n.g + PIECE_COST[p.type] + (turn ? 0.6 : 0);
      // No loops and detours: when the cursor can't be reached directly, stop as close as possible.
      if (g > limit) continue;
      const k = `${p.b.x},${p.b.y},${p.b.dir}`;
      if ((seen.get(k) ?? Infinity) <= g) continue;
      seen.set(k, g);
      open.push(g + h(p.b), { end: p.b, g, piece: p, prev: n });
    }
  }
  const out: RailPiece[] = [];
  for (let n: Node | undefined = best; n?.piece; n = n.prev) out.push(n.piece);
  return out.reverse();
}

// ---- signals and train stops --------------------------------------------------

const STEP: Record<number, [number, number]> = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };

/** Rail ends on straight north-south or east-west track, keyed "x,y|axis". */
// Joint sets are rebuilt per call otherwise; layouts and imports never change a rails array in place.
const jointCache = new WeakMap<object, { n: number; straight?: Set<string>; diagonal?: Set<string> }>();
function cached(rails: readonly PlacedRail[], kind: 'straight' | 'diagonal', build: () => Set<string>): Set<string> {
  let c = jointCache.get(rails);
  if (!c || c.n !== rails.length) jointCache.set(rails, (c = { n: rails.length }));
  return (c[kind] ??= build());
}

function straightJoints(rails: readonly PlacedRail[]): Set<string> {
  return cached(rails, 'straight', () => buildStraightJoints(rails));
}
function buildStraightJoints(rails: readonly PlacedRail[]): Set<string> {
  const out = new Set<string>();
  for (const r of rails) {
    const p = railPiece(r);
    for (const e of [p.a, p.b]) if (mod16(e.dir) % 4 === 0) out.add(`${e.x},${e.y}|${mod16(e.dir) % 8}`);
  }
  return out;
}

/**
 * Editor direction (0-3) for a signal on tile (tx, ty), so that it guards the
 * track beside it for right-hand traffic, or null when no straight track joint
 * is next to that tile. Tries `preferred` first. In blueprints a signal faces
 * against the travel direction, and the editor stores that facing (x4).
 */
export function signalDirectionAt(rails: readonly PlacedRail[], tx: number, ty: number, preferred: number): number | null {
  const joints = straightJoints(rails);
  const cx = tx + 0.5, cy = ty + 0.5;
  for (let i = 0; i < 4; i++) {
    const facing = (preferred + i) % 4;
    const travel = opposite(facing * 4);
    const [fx, fy] = STEP[travel]!;
    const [rx, ry] = [-fy, fx];
    const jx = cx - rx * 1.5 - fx * 0.5, jy = cy - ry * 1.5 - fy * 0.5;
    if (joints.has(`${jx},${jy}|${travel % 8}`)) return facing;
  }
  return null;
}

/** Rail ends on 45° track, keyed "x,y|axis". */
function diagonalJoints(rails: readonly PlacedRail[]): Set<string> {
  return cached(rails, 'diagonal', () => buildDiagonalJoints(rails));
}
function buildDiagonalJoints(rails: readonly PlacedRail[]): Set<string> {
  const out = new Set<string>();
  for (const r of rails) {
    const p = railPiece(r);
    for (const e of [p.a, p.b]) if (mod16(e.dir) % 4 === 2) out.add(`${e.x},${e.y}|${mod16(e.dir) % 8}`);
  }
  return out;
}

const DIAG: Record<number, [number, number]> = { 2: [1, -1], 6: [1, 1], 10: [-1, 1], 14: [-1, -1] };

/**
 * Facing for a signal on tile (tx, ty): on straight track like signalDirectionAt,
 * or on 45° track, where the signal stands one tile right and one tile along
 * from the joint diagonally (as in the game's blueprints) and faces one of the
 * diagonal directions. `diagonal` means the 16-way facing is direction * 4 + 2.
 */
export function signalAt(rails: readonly PlacedRail[], tx: number, ty: number, preferred: number): { direction: number; diagonal: boolean } | null {
  const straight = signalDirectionAt(rails, tx, ty, preferred);
  if (straight !== null) return { direction: straight, diagonal: false };
  const joints = diagonalJoints(rails);
  const cx = tx + 0.5, cy = ty + 0.5;
  for (let i = 0; i < 4; i++) {
    const facing = mod16((preferred + i) * 4 + 2);
    const travel = opposite(facing);
    const [fx, fy] = DIAG[travel]!;
    const [rx, ry] = [-fy, fx];
    const jx = cx - rx - fx * 0.5, jy = cy - ry - fy * 0.5;
    if (joints.has(`${jx},${jy}|${travel % 8}`)) return { direction: (facing - 2) / 4, diagonal: true };
  }
  return null;
}

/** 16-way facing of a signal building. */
export const signalFacing = (e: { direction: number; diagonal?: boolean }) => e.direction * 4 + (e.diagonal ? 2 : 0);

/**
 * Top-left tile and direction for a train stop near the cursor tile, standing on
 * the right of straight track at a rail joint, or null when there is none.
 */
export function trainStopAt(rails: readonly PlacedRail[], tx: number, ty: number, preferred: number): { x: number; y: number; direction: number } | null {
  const joints = straightJoints(rails);
  let best: { x: number; y: number; direction: number } | null = null;
  let bestD = Infinity;
  for (const k of joints) {
    const [xy, axis] = k.split('|');
    const [jx, jy] = xy!.split(',').map(Number);
    for (const travel of axis === '0' ? [0, 8] : [4, 12]) {
      const [fx, fy] = STEP[travel]!;
      const [rx, ry] = [-fy, fx];
      const cx = jx! + rx * 2 - fx, cy = jy! + ry * 2 - fy;
      const d = (cx - (tx + 0.5)) ** 2 + (cy - (ty + 0.5)) ** 2 + (travel / 4 === preferred ? 0 : 0.01);
      if (d < bestD && d <= 2) {
        bestD = d;
        best = { x: cx - 1, y: cy - 1, direction: travel / 4 };
      }
    }
  }
  return best;
}
