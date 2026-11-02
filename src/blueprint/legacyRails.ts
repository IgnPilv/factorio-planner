// Rebuild 1.x rail junctions with 2.0 track.
//
// 1.x straight track along an axis is the same piece in 2.0 (shifted one tile,
// see blueprintToClipboard). 1.x curves and diagonal pieces have no 2.0 shape:
// the 2.0 turn radius is larger (13 against about 10) and diagonals sit on a
// different grid. So instead of translating pieces, each route that a train
// could drive through a 1.x curve section is planned again with 2.0 pieces,
// between the same straight track, the way you would re-lay it by hand. When the
// larger 2.0 curves don't fit, the new track branches off further back along the
// straight track, and straight stubs that then lead nowhere are removed.
//
// 1.x geometry, checked against a real 0.17 city-block blueprint (every one of
// its 1914 straights, 76 diagonals and 152 curves joins up end to end):
// - straight, direction 0/4 (north-south): ends (0, ±1); 2/6: ends (±1, 0)
// - diagonal, direction 1: ends (0,-1) and (1,0); 3, 5, 7 turn that by 90° each
// - curve, direction 0: straight end (1, 4) heading south, 45° end (-2, -3)
//   heading north-west; direction 1 mirrors it (ends (-1, 4) and (2, -3)), and
//   directions 2k and 2k+1 turn those by k x 90° clockwise.
// Positions are relative to the entity position; headings are 16-way and point
// out of the piece through that end.

import { buildPiece, mod16, opposite, type Point, type RailEnd, type RailPiece } from '../rails/geometry';
import { pieceFromEntity, railEntity } from '../rails/blueprint';

export interface LegacyRailInput {
  name: string;
  position: Point;
  direction?: number;
}

export interface LegacyConversion {
  /** New 2.0 pieces, as blueprint name, centre and 16-way direction. */
  added: { name: RailPiece['type']; x: number; y: number; direction: number }[];
  /** Indexes (into the straights passed in) of 1.x straight pieces to drop. */
  removedStraights: Set<number>;
  /** Routes through 1.x curves that were rebuilt, and those that could not be. */
  routes: number;
  failed: number;
  /** 1.x curve and diagonal pieces replaced, and those that could not be. */
  legacyPieces: number;
  lostPieces: number;
}

type End = RailEnd;
interface Piece {
  straight: boolean;
  ends: [End, End];
}

const rot = (p: Point, k: number): Point => {
  let { x, y } = p;
  for (let i = 0; i < k; i++) [x, y] = [-y, x];
  return { x, y };
};

/** Ends of a 1.x piece, or undefined when it isn't 1.x track. */
export function legacyEnds(e: LegacyRailInput): [End, End] | undefined {
  const d = (e.direction ?? 0) % 8;
  const at = (o: Point, dir: number): End => ({ x: e.position.x + o.x, y: e.position.y + o.y, dir: mod16(dir) });
  if (e.name === 'straight-rail') {
    if (d % 4 === 0) return [at({ x: 0, y: -1 }, 0), at({ x: 0, y: 1 }, 8)];
    if (d % 4 === 2) return [at({ x: 1, y: 0 }, 4), at({ x: -1, y: 0 }, 12)];
    // Diagonal: direction 1 joins (0,-1) and (1,0); each later odd direction turns 90°.
    const k = (d - 1) / 2;
    const a = rot({ x: 0, y: -1 }, k), b = rot({ x: 1, y: 0 }, k);
    // Each end heads away from the other end.
    return [at(a, headingOf(a.x - b.x, a.y - b.y)), at(b, headingOf(b.x - a.x, b.y - a.y))];
  }
  if (e.name === 'curved-rail') {
    const k = Math.floor(d / 2);
    const mirrored = d % 2 === 1;
    const straightEnd = rot({ x: mirrored ? -1 : 1, y: 4 }, k);
    const diagEnd = rot({ x: mirrored ? 2 : -2, y: -3 }, k);
    return [at(straightEnd, 8 + 4 * k), at(diagEnd, (mirrored ? 2 : 14) + 4 * k)];
  }
  return undefined;
}

/** 16-way heading of a vector along an axis or a 45° diagonal. */
function headingOf(dx: number, dy: number): number {
  return mod16(Math.round((Math.atan2(dx, -dy) * 8) / Math.PI));
}

const STEP = (dir: number): Point => {
  const a = (mod16(dir) * Math.PI) / 8;
  return { x: Math.round(Math.sin(a)), y: Math.round(-Math.cos(a)) };
};
const pkey = (p: Point) => `${p.x},${p.y}`;

/**
 * Plan 2.0 track replacing the 1.x curve and diagonal pieces. `straights` are
 * the 1.x straight pieces along an axis and `legacy` the curves and diagonals,
 * both already moved onto the 2.0 grid (positions +1, +1).
 */
export function convertLegacyRails(straights: readonly LegacyRailInput[], legacy: readonly LegacyRailInput[], maxBackoff = 12): LegacyConversion {
  const pieces: Piece[] = [];
  for (const s of straights) pieces.push({ straight: true, ends: legacyEnds(s)! });
  const firstLegacy = pieces.length;
  for (const l of legacy) {
    const ends = legacyEnds(l);
    if (ends) pieces.push({ straight: false, ends });
  }
  // Ends at each point. Two ends join when they share a point and head opposite ways.
  const atPoint = new Map<string, { piece: number; end: 0 | 1 }[]>();
  pieces.forEach((p, i) =>
    p.ends.forEach((e, j) => {
      const k = pkey(e);
      if (!atPoint.has(k)) atPoint.set(k, []);
      atPoint.get(k)!.push({ piece: i, end: j as 0 | 1 });
    }),
  );
  const partners = (e: End) => (atPoint.get(pkey(e)) ?? []).filter((o) => pieces[o.piece]!.ends[o.end].dir === opposite(e.dir));

  // Straight pieces keyed by the point they start from and their heading, to walk along straight track.
  const straightFrom = new Map<string, number>();
  pieces.forEach((p, i) => {
    if (!p.straight) return;
    for (const e of p.ends) straightFrom.set(`${pkey(e)}|${opposite(e.dir)}`, i);
  });

  // Every route a train can take through the curve sections, from straight track to straight track.
  interface Route { start: End; goal: End; via: Set<number> }
  const routes = new Map<string, Route>();
  let failed = 0;
  for (let i = firstLegacy; i < pieces.length; i++) {
    for (const j of [0, 1] as const) {
      const entry = pieces[i]!.ends[j];
      const before = partners(entry);
      if (!before.length || !before.every((o) => pieces[o.piece]!.straight)) continue;
      // Drive in through this end: travel heading is opposite the end's outward heading.
      const start: End = { x: entry.x, y: entry.y, dir: opposite(entry.dir) };
      let steps = 0;
      const walk = (piece: number, endIn: 0 | 1, seen: Set<number>) => {
        if (++steps > 20000) return;
        const out = pieces[piece]!.ends[endIn === 0 ? 1 : 0];
        const next = partners(out);
        if (!next.length) {
          return;
        }
        if (next.every((o) => pieces[o.piece]!.straight)) {
          const goal: End = { x: out.x, y: out.y, dir: out.dir };
          const a = `${pkey(start)}|${start.dir}>${pkey(goal)}|${goal.dir}`;
          const b = `${pkey(goal)}|${opposite(goal.dir)}>${pkey(start)}|${opposite(start.dir)}`;
          const r = routes.get(a) ?? routes.get(b);
          if (r) for (const v of seen) r.via.add(v);
          else routes.set(a, { start, goal, via: new Set(seen) });
          return;
        }
        for (const o of next) {
          if (pieces[o.piece]!.straight || seen.has(o.piece)) continue;
          seen.add(o.piece);
          walk(o.piece, o.end, seen);
          seen.delete(o.piece);
        }
      };
      walk(i, j, new Set([i]));
    }
  }

  // Points along the straight track behind a start (or ahead of a goal) where new track may branch off.
  const along = (from: End, backwards: boolean): End[] => {
    const out: End[] = [from];
    let at: Point = from;
    const dir = backwards ? opposite(from.dir) : from.dir;
    const v = STEP(dir);
    for (let k = 0; k < maxBackoff; k++) {
      if (!straightFrom.has(`${pkey(at)}|${dir}`)) break;
      at = { x: at.x + 2 * v.x, y: at.y + 2 * v.y };
      out.push({ x: at.x, y: at.y, dir: from.dir });
    }
    return out;
  };

  const added = new Map<string, LegacyConversion['added'][number]>();
  const branchedFrom = new Set<string>();
  const failedEnds = new Set<string>();
  let rebuilt = 0;
  const covered = new Set<number>();
  for (const r of routes.values()) {
    const starts = along(r.start, true), goals = along(r.goal, false);
    // Tight 1.x loops need a 2.0 balloon loop: allow a much longer route on a second try.
    const uTurn = r.goal.dir === opposite(r.start.dir);
    const path = (uTurn ? undefined : planBetween(starts, goals, 8000, 60, 1)) ?? planBetween(starts, goals, 200000, 260, 1.6);
    if (!path) {
      failed++;
      failedEnds.add(pkey(r.start)).add(pkey(r.goal));
      continue;
    }
    rebuilt++;
    for (const v of r.via) covered.add(v);
    for (const p of path) {
      const e = railEntity(p);
      const piece = { name: p.type, x: e.position.x, y: e.position.y, direction: e.direction ?? 0 };
      added.set(`${piece.name}|${piece.x}|${piece.y}|${piece.direction}`, piece);
    }
    branchedFrom.add(pkey(r.start)).add(pkey(r.goal));
  }

  // Straight stubs left between where the new track branches off and where the 1.x curve began.
  const removed = new Set<number>();
  const newEnds = new Set<string>();
  for (const p of added.values()) {
    const piece = pieceFromEntity({ name: p.name, position: { x: p.x, y: p.y }, direction: p.direction });
    for (const e of [piece.a, piece.b]) newEnds.add(`${pkey(e)}|${e.dir}`);
  }
  for (const start of branchedFrom) {
    if (failedEnds.has(start)) continue;
    let pt = start;
    for (let k = 0; k <= maxBackoff; k++) {
      const here = (atPoint.get(pt) ?? []).filter((o) => o.piece < firstLegacy && !removed.has(o.piece));
      if (here.length !== 1) break;
      const { piece, end } = here[0]!;
      const out = pieces[piece]!.ends[end];
      // Track that joins this straight at its end: a new piece, or another straight.
      if (newEnds.has(`${pt}|${opposite(out.dir)}`)) break;
      removed.add(piece);
      pt = pkey(pieces[piece]!.ends[end === 0 ? 1 : 0]);
    }
  }
  const legacyPieces = covered.size;
  // Curve pieces on no rebuilt route: dead ends at the blueprint's edge, or routes that didn't fit.
  const lostPieces = pieces.length - firstLegacy - covered.size;
  return { added: [...added.values()], removedStraights: removed, routes: rebuilt, failed, legacyPieces, lostPieces };
}

const COST: Record<RailPiece['type'], number> = { 'straight-rail': 2, 'half-diagonal-rail': 4.47, 'curved-rail-a': 5.05, 'curved-rail-b': 4.95 };

/**
 * Shortest 2.0 track from any of the starts to any of the goals, arriving at a
 * goal point with its heading exactly. Starts and goals are listed nearest the
 * curve first; branching further back costs a little so the new track keeps
 * close to the old layout.
 */
function planBetween(starts: End[], goals: End[], maxExpand: number, slack: number, weight: number): RailPiece[] | undefined {
  const goalSet = new Map<string, number>();
  goals.forEach((g, k) => goalSet.set(`${g.x},${g.y}|${g.dir}`, k));
  const h = (p: Point) => Math.min(...goals.map((g) => Math.hypot(g.x - p.x, g.y - p.y)));
  const span = Math.hypot(goals[0]!.x - starts[0]!.x, goals[0]!.y - starts[0]!.y);
  const limit = 2 * span + slack;
  type Node = { end: End; g: number; piece?: RailPiece; prev?: Node };
  const open: { f: number; n: Node }[] = [];
  const push = (f: number, n: Node) => {
    open.push({ f, n });
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (open[p]!.f <= open[i]!.f) break;
      [open[p], open[i]] = [open[i]!, open[p]!];
      i = p;
    }
  };
  const pop = () => {
    const top = open[0]!;
    const last = open.pop()!;
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < open.length && open[l]!.f < open[m]!.f) m = l;
        if (r < open.length && open[r]!.f < open[m]!.f) m = r;
        if (m === i) break;
        [open[m], open[i]] = [open[i]!, open[m]!];
        i = m;
      }
    }
    return top.n;
  };
  const best = new Map<string, number>();
  starts.forEach((s, k) => {
    const g = k * 3;
    best.set(`${s.x},${s.y}|${s.dir}`, g);
    push(g + weight * h(s), { end: s, g });
  });
  for (let i = 0; i < maxExpand && open.length; i++) {
    const n = pop();
    const key = `${n.end.x},${n.end.y}|${n.end.dir}`;
    if (n.piece && goalSet.has(key)) {
      const out: RailPiece[] = [];
      for (let m: Node | undefined = n; m?.piece; m = m.prev) out.push(m.piece);
      return out.reverse();
    }
    if ((best.get(key) ?? Infinity) < n.g) continue;
    for (const turn of [0, -1, 1] as const) {
      const p = buildPiece(n.end, turn, '');
      if (!p) continue;
      const g = n.g + COST[p.type] + (turn ? 0.3 : 0);
      if (g > limit) continue;
      const k = `${p.b.x},${p.b.y}|${p.b.dir}`;
      // Arriving at a goal further along costs a little too.
      const gg = g + (goalSet.has(k) ? goalSet.get(k)! * 3 : 0);
      if ((best.get(k) ?? Infinity) <= gg) continue;
      best.set(k, gg);
      push(gg + weight * h(p.b), { end: p.b, g: gg, piece: p, prev: n });
    }
  }
  return undefined;
}
