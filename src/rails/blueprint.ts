// How Factorio 2.0 blueprints store rails, signals and train stops.
//
// Worked out from the blueprints shipped in the game's own files
// (base/prototypes/tips-and-tricks-simulations.lua and factoriopedia-simulations.lua,
// wube/factorio-data 2.1.24): with the tables below, all 1,764 rail ends in those
// blueprints land on rail ends of neighbouring pieces, except open ends at the edges.
// See tests/rail-blueprint.test.ts, which checks a loop taken from those files.
//
// - Positions are entity centres. Directions use 16 steps (0 = north, 4 = east).
// - straight-rail: 0 north–south, 4 east–west, 2 NE–SW diagonal, 6 NW–SE diagonal;
//   centre is the midpoint.
// - half-diagonal-rail: 0, 2, 4, 6 run along headings 15, 1, 3, 5 (22.5° tracks);
//   centre is the midpoint.
// - curved-rail-a / curved-rail-b: 8 directions (even numbers). Direction 0 is the
//   left-hand curve leaving northwards, 2 the right-hand one; +4 rotates 90°
//   clockwise. Their ends relative to the centre are in CURVES below.
// - Rail signals stand 1.5 tiles to the right of the track at a rail joint, half a
//   tile past it; their direction is the opposite of the trains' travel heading.
// - Train stops stand 2 tiles to the right of the track; direction = travel heading.

import { mod16, opposite, type Point, type RailEnd, type RailPiece, type RailType } from './geometry';
import type { Signal } from './signals';

export interface BlueprintEntityLike {
  name: string;
  position: Point;
  direction?: number;
}

type End = [number, number, number]; // dx, dy, out heading

const rot = ([x, y, d]: End, k: number): End => {
  for (let i = 0; i < k; i++) [x, y, d] = [-y, x, mod16(d + 4)];
  return [x, y, d];
};

/** Ends of the curves at directions 0 and 2, relative to the entity position. */
const CURVES: Record<'curved-rail-a' | 'curved-rail-b', Record<0 | 2, End[]>> = {
  'curved-rail-a': { 0: [[0, 2, 8], [-1, -3, 15]], 2: [[0, 2, 8], [1, -3, 1]] },
  'curved-rail-b': { 0: [[-2, -2, 14], [1, 2, 7]], 2: [[2, -2, 2], [-1, 2, 9]] },
};

const HALF_DIAGONAL_HEADING = [15, 1, 3, 5];

/** The two ends (relative to the entity position) of a rail entity in a blueprint. */
export function railEnds(name: RailType, direction: number): End[] {
  const d = mod16(direction);
  if (name === 'curved-rail-a' || name === 'curved-rail-b') {
    return CURVES[name][(d % 4) as 0 | 2].map((e) => rot(e, Math.floor(d / 4)));
  }
  if (name === 'straight-rail') {
    const k = d % 8;
    if (k === 0) return [[0, -1, 0], [0, 1, 8]];
    if (k === 4) return [[1, 0, 4], [-1, 0, 12]];
    if (k === 2) return [[1, -1, 2], [-1, 1, 10]];
    return [[1, 1, 6], [-1, -1, 14]];
  }
  const h = HALF_DIAGONAL_HEADING[(d % 8) / 2];
  const v: Record<number, [number, number]> = { 15: [-1, -2], 1: [1, -2], 3: [2, -1], 5: [2, 1] };
  const [x, y] = v[h];
  return [[x, y, h], [-x, -y, opposite(h)]];
}

const DIRECTIONS: Record<RailType, number[]> = {
  'straight-rail': [0, 2, 4, 6],
  'half-diagonal-rail': [0, 2, 4, 6],
  'curved-rail-a': [0, 2, 4, 6, 8, 10, 12, 14],
  'curved-rail-b': [0, 2, 4, 6, 8, 10, 12, 14],
};

const sameEnd = (e: RailEnd, p: Point, [dx, dy, d]: End) => e.x === p.x + dx && e.y === p.y + dy && e.dir === d;

/** Blueprint entity for a rail piece. */
export function railEntity(piece: RailPiece): BlueprintEntityLike {
  for (const direction of DIRECTIONS[piece.type]) {
    const ends = railEnds(piece.type, direction);
    for (const [first, second] of [[ends[0], ends[1]], [ends[1], ends[0]]]) {
      const pos = { x: piece.a.x - first[0], y: piece.a.y - first[1] };
      if (sameEnd(piece.a, pos, first) && sameEnd(piece.b, pos, second))
        return direction ? { name: piece.type, position: pos, direction } : { name: piece.type, position: pos };
    }
  }
  throw new Error(`No blueprint form for ${piece.type} from (${piece.a.x}, ${piece.a.y})`);
}

/** Inverse of railEntity: the piece a blueprint rail entity describes. */
export function pieceFromEntity(e: BlueprintEntityLike, id = ''): RailPiece {
  const [a, b] = railEnds(e.name as RailType, e.direction ?? 0);
  return {
    id, type: e.name as RailType,
    a: { x: e.position.x + a[0], y: e.position.y + a[1], dir: a[2] },
    b: { x: e.position.x + b[0], y: e.position.y + b[1], dir: b[2] },
  };
}

/** Unit-ish step along a heading for the 8 headings signals use: (±1, 0), (0, ±1) or (±1, ±1). */
function step(dir: number): [number, number] {
  const a = (mod16(dir) * Math.PI) / 8;
  return [Math.round(Math.sin(a)), Math.round(-Math.cos(a))];
}

/** Blueprint entity for a signal at a straight or 45° joint. */
export function signalEntity(s: Signal): BlueprintEntityLike {
  if (s.dir % 2 !== 0) throw new Error('Signals at 22.5° joints are not supported yet');
  const [tx, ty] = step(s.dir);
  const [rx, ry] = [-ty, tx]; // right-hand side
  // Straight track: 1.5 to the right. 45° track: (1, 1) to the right. Then half a tile along.
  const side = s.dir % 4 === 0 ? 1.5 : 1;
  const position = { x: s.x + rx * side + tx * 0.5, y: s.y + ry * side + ty * 0.5 };
  const name = s.kind === 'chain' ? 'rail-chain-signal' : 'rail-signal';
  const direction = opposite(s.dir);
  return direction ? { name, position, direction } : { name, position };
}

/** Blueprint entity for a train stop at a straight joint, for trains travelling `dir`. */
export function trainStopEntity(joint: Point, dir: 0 | 4 | 8 | 12): BlueprintEntityLike {
  const [tx, ty] = step(dir);
  const [rx, ry] = [-ty, tx];
  const position = { x: joint.x + rx * 2 - tx, y: joint.y + ry * 2 - ty };
  return dir ? { name: 'train-stop', position, direction: dir } : { name: 'train-stop', position };
}
