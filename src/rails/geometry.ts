// Factorio 2.0 rail geometry.
//
// Rail shapes are hard-coded in the engine (they are not in the prototype files),
// so the numbers here come from the developers' own statements:
// - FFF-377 "New new rails": every rail connection point lies on integer map
//   coordinates; a rail end connects to at most 3 pieces (left, straight, right).
//   https://factorio.com/blog/post/fff-377
// - boskid on the forum: rails build on a 2x2 grid; straight rails sit at odd/odd
//   centres, 45° straights at even/even, 22.5° straights and curve-B at odd/odd,
//   curve-A at one odd and one even coordinate.
//   https://forums.factorio.com/viewtopic.php?p=611478
// - Piece lengths measured with LuaRailPath (r/technicalfactorio, Nov 2024):
//   straight 2, diagonal 2√2, half-diagonal 2√5, curve-A 13·asin(5/13) whose ends
//   are a (1,5) vector apart, curve-B 13·(π/4 − asin(5/13)); turn radius 13.
// - Wiki "Rail": minimum turning radius 13; a 180° turn is 26 tiles between rail
//   centres and 28 tiles wide.  https://wiki.factorio.com/Rail
//
// From those facts the end points follow: curve-A runs from a straight end to a
// 22.5° end through (1,5); curve-A + curve-B must end on an integer point near the
// radius-13 arc at 45° (3.81, 9.19), which is (4, 9), so curve-B spans (3, 4). Two
// A+B halves make a 90° turn of exactly (13, 13). This reproduces every parity rule
// above, which is the check that the end points are right.
//
// Coordinates: x grows east, y grows south (map coordinates). Track headings use
// 16 directions, 0 = north, 4 = east, 8 = south, 12 = west, each step 22.5°.

export type RailType = 'straight-rail' | 'half-diagonal-rail' | 'curved-rail-a' | 'curved-rail-b';

export interface Point {
  x: number;
  y: number;
}

/** One end of a rail piece. `dir` is the heading when driving out of the piece through this end. */
export interface RailEnd extends Point {
  dir: number;
}

export interface RailPiece {
  id: string;
  type: RailType;
  /** The two ends; driving from a to b you leave through b heading b.dir. */
  a: RailEnd;
  b: RailEnd;
}

export const RADIUS = 13;
export const LENGTH: Record<RailType | 'diagonal', number> = {
  'straight-rail': 2,
  diagonal: 2 * Math.SQRT2,
  'half-diagonal-rail': 2 * Math.sqrt(5),
  'curved-rail-a': 13 * Math.asin(5 / 13),
  'curved-rail-b': 13 * (Math.PI / 4 - Math.asin(5 / 13)),
};

export const mod16 = (d: number) => ((d % 16) + 16) % 16;
export const opposite = (d: number) => mod16(d + 8);

/** Unit vector of a 16-way heading. */
export function headingVector(dir: number): Point {
  const a = (mod16(dir) * Math.PI) / 8;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

/**
 * Which tile corners an end with this heading may sit on. Every rail end has at
 * least one odd coordinate; no end is ever on an even/even point.
 */
export function endParity(dir: number): { xOdd: boolean; yOdd: boolean } {
  const d = mod16(dir) % 8; // the axis, ignoring travel direction
  if (d === 0) return { xOdd: true, yOdd: false }; // north–south
  if (d === 4) return { xOdd: false, yOdd: true }; // east–west
  if (d % 2 === 0) return { xOdd: true, yOdd: true }; // 45°
  if (d === 1 || d === 7) return { xOdd: false, yOdd: true }; // 22.5° off north–south
  return { xOdd: true, yOdd: false }; // 22.5° off east–west (3, 5)
}

const odd = (n: number) => Math.abs(n % 2) === 1;

export function endOnGrid(e: RailEnd): boolean {
  if (!Number.isInteger(e.x) || !Number.isInteger(e.y)) return false;
  const p = endParity(e.dir);
  return odd(e.x) === p.xOdd && odd(e.y) === p.yOdd;
}

// ---------- canonical shapes ----------

/** Displacement and headings of each piece when built from an end heading `from`. */
interface Shape {
  type: RailType;
  dx: number;
  dy: number;
  from: number;
  to: number;
}

/** The five base shapes, all leaving an end heading north (or NNE / NE). */
const BASE: Shape[] = [
  { type: 'straight-rail', dx: 0, dy: -2, from: 0, to: 0 },
  { type: 'straight-rail', dx: 2, dy: -2, from: 2, to: 2 },
  { type: 'half-diagonal-rail', dx: 2, dy: -4, from: 1, to: 1 },
  { type: 'curved-rail-a', dx: 1, dy: -5, from: 0, to: 1 },
  { type: 'curved-rail-b', dx: 3, dy: -4, from: 1, to: 2 },
];

const rot90 = (s: Shape): Shape => ({ ...s, dx: -s.dy, dy: s.dx, from: mod16(s.from + 4), to: mod16(s.to + 4) });
const mirror = (s: Shape): Shape => ({ ...s, dx: -s.dx, from: mod16(16 - s.from), to: mod16(16 - s.to) });
const reverse = (s: Shape): Shape => ({ ...s, dx: -s.dx, dy: -s.dy, from: opposite(s.to), to: opposite(s.from) });

/** Every directed shape: all 8 symmetries of the square, both travel directions. */
export const SHAPES: Shape[] = (() => {
  const out = new Map<string, Shape>();
  for (const base of BASE) {
    for (const m of [false, true]) {
      let s = m ? mirror(base) : base;
      for (let r = 0; r < 4; r++) {
        for (const t of [s, reverse(s)]) out.set(`${t.type}|${t.dx}|${t.dy}|${t.from}|${t.to}`, t);
        s = rot90(s);
      }
    }
  }
  return [...out.values()];
})();

/** Pieces that can be built from an end heading `dir` (straight, left and right options). */
export function shapesFrom(dir: number): Shape[] {
  return SHAPES.filter((s) => s.from === mod16(dir));
}

let seq = 0;
const nextId = () => `r${(seq++).toString(36)}`;

/**
 * Build a piece starting at `start` and leaving with heading start.dir.
 * `turn` is -1 (left), 0 (straight) or +1 (right).
 */
export function buildPiece(start: RailEnd, turn: -1 | 0 | 1, id = nextId()): RailPiece | undefined {
  const target = mod16(start.dir + turn);
  const s = shapesFrom(start.dir).find((x) => x.to === target);
  if (!s) return undefined;
  return {
    id,
    type: s.type,
    a: { x: start.x, y: start.y, dir: opposite(s.from) },
    b: { x: start.x + s.dx, y: start.y + s.dy, dir: s.to },
  };
}

/** Lay a straight run of `count` pieces from `start` (each 2 tiles, or 2√2 diagonal, or 2√5 at 22.5°). */
export function straightRun(start: RailEnd, count: number): RailPiece[] {
  const out: RailPiece[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    const p = buildPiece(at, 0);
    if (!p) break;
    out.push(p);
    at = p.b;
  }
  return out;
}

/** Follow a list of turns (-1, 0, +1 per piece) from a start end. */
export function path(start: RailEnd, turns: (-1 | 0 | 1)[]): RailPiece[] {
  const out: RailPiece[] = [];
  let at = start;
  for (const t of turns) {
    const p = buildPiece(at, t);
    if (!p) break;
    out.push(p);
    at = p.b;
  }
  return out;
}

/** 90° turn: curve-A, curve-B, curve-B, curve-A. Moves (13, 13). */
export const TURN_90: (-1 | 0 | 1)[] = [1, 1, 1, 1];

export function pieceLength(p: RailPiece): number {
  if (p.type === 'straight-rail') return p.a.dir % 4 === 2 ? LENGTH.diagonal : LENGTH['straight-rail'];
  return LENGTH[p.type];
}

/**
 * Points along the centre line, for drawing and footprints. Curves are drawn as
 * a cubic through both ends with the end headings, which follows the
 * radius-13 arc to within a few hundredths of a tile.
 */
export function centreLine(p: RailPiece, steps = 8): Point[] {
  // Heading when travelling a -> b at a is opposite of a.dir.
  const ta = headingVector(opposite(p.a.dir));
  const tb = headingVector(p.b.dir);
  const len = pieceLength(p);
  const k = len / 3;
  const c1 = { x: p.a.x + ta.x * k, y: p.a.y + ta.y * k };
  const c2 = { x: p.b.x - tb.x * k, y: p.b.y - tb.y * k };
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p.a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p.b.x,
      y: u * u * u * p.a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p.b.y,
    });
  }
  return pts;
}

/** Tiles the piece covers (rails are 2 tiles wide), as "x,y" keys of tile top-left corners. */
export function footprintTiles(p: RailPiece): Set<string> {
  const out = new Set<string>();
  const pts = centreLine(p, 24);
  for (const c of pts) {
    for (let dx = -1; dx < 1; dx++) for (let dy = -1; dy < 1; dy++) {
      // Tile whose square overlaps a 1.6 x 1.6 box around the centre line point.
      const tx = Math.floor(c.x + dx * 0.8 + 0.4);
      const ty = Math.floor(c.y + dy * 0.8 + 0.4);
      out.add(`${tx},${ty}`);
    }
  }
  return out;
}

// ---------- rail graph ----------

const endKey = (e: Point) => `${e.x},${e.y}`;

export interface RailIssue {
  pieceId?: string;
  at?: Point;
  severity: 'error' | 'warning';
  message: string;
}

export interface RailNetworkReport {
  issues: RailIssue[];
  /** Open rail ends (dead ends). */
  deadEnds: RailEnd[];
  /** Connections per end point, for drawing junctions. */
  junctions: { at: Point; branches: number }[];
}

/**
 * Check pieces the way the game would: every end on its grid, and ends that meet
 * must have matching headings; at most three pieces per side of a joint.
 */
export function checkRails(pieces: RailPiece[]): RailNetworkReport {
  const issues: RailIssue[] = [];
  const byPoint = new Map<string, { piece: RailPiece; end: RailEnd }[]>();
  for (const p of pieces) {
    for (const end of [p.a, p.b]) {
      if (!endOnGrid(end))
        issues.push({ pieceId: p.id, at: end, severity: 'error', message: `${p.type} end at (${end.x}, ${end.y}) is off the 2x2 rail grid` });
      const k = endKey(end);
      if (!byPoint.has(k)) byPoint.set(k, []);
      byPoint.get(k)!.push({ piece: p, end });
    }
  }
  const deadEnds: RailEnd[] = [];
  const junctions: { at: Point; branches: number }[] = [];
  for (const list of byPoint.values()) {
    const at = { x: list[0].end.x, y: list[0].end.y };
    // Group by axis: ends heading d and opposite(d) meet each other.
    const axes = new Map<number, { out: number; inn: number }>();
    for (const { end } of list) {
      const axis = end.dir % 8;
      const g = axes.get(axis) ?? { out: 0, inn: 0 };
      if (end.dir < 8) g.out++;
      else g.inn++;
      axes.set(axis, g);
    }
    for (const [axis, g] of axes) {
      if (g.out === 0 || g.inn === 0) {
        const e = list.find((x) => x.end.dir % 8 === axis)!.end;
        deadEnds.push(e);
      }
      if (g.out > 3 || g.inn > 3)
        issues.push({ at, severity: 'error', message: `More than 3 rails join one side at (${at.x}, ${at.y})` });
      if (g.out + g.inn > 2) junctions.push({ at, branches: g.out + g.inn });
    }
  }
  return { issues, deadEnds, junctions };
}

// ---------- trains ----------

/** Tiles of track one car occupies: joint_distance + connection_distance (4 + 3 = 7 in 2.x). */
export function carPitch(jointDistance = 4, connectionDistance = 3) {
  return jointDistance + connectionDistance;
}

/** Track length a train needs to stop fully inside a station, from the stop to the last car's end. */
export function trainLength(cars: number, pitch = carPitch()) {
  // Each car is 6 tiles long with 1 tile between cars.
  return cars * pitch - 1;
}
