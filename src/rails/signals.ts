// Rail signals and blocks, following the game's rules (wiki "Rail signal"):
// - A signal stands on the right-hand side of the track and controls trains
//   driving in that direction; a pair opposite each other allows both ways.
// - Signals cut the track into blocks. Rails that cross or join belong to one
//   block unless a signal separates them.
// - A chain signal shows what the next signal ahead shows, so the usual rule for
//   junctions is "chain signal in, rail signal out": a train only enters the
//   junction when it can also leave it.
// - An automatic train will not drive against signals that are only on the left.
//   https://wiki.factorio.com/Rail_signal

import { centreLine, headingVector, mod16, opposite, pieceLength, type Point, type RailPiece } from './geometry';

export interface Signal {
  id: string;
  kind: 'rail' | 'chain';
  /** The rail joint the signal belongs to (a shared end point of two pieces). */
  x: number;
  y: number;
  /** Travel heading (0-15) of the trains it controls. */
  dir: number;
}

/** Where the signal is drawn: 1.5 tiles to the right of the joint. */
export function signalPosition(s: Signal): Point {
  const h = headingVector(s.dir);
  return { x: s.x - h.y * 1.5, y: s.y + h.x * 1.5 };
}

const key = (x: number, y: number) => `${x},${y}`;

interface Joint {
  at: Point;
  /** Pieces touching this point, with the heading pointing out of each piece. */
  ends: { piece: RailPiece; dir: number }[];
}

function joints(pieces: RailPiece[]): Map<string, Joint> {
  const m = new Map<string, Joint>();
  for (const p of pieces)
    for (const e of [p.a, p.b]) {
      const k = key(e.x, e.y);
      if (!m.has(k)) m.set(k, { at: { x: e.x, y: e.y }, ends: [] });
      m.get(k)!.ends.push({ piece: p, dir: e.dir });
    }
  return m;
}

function segmentsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

/** Pairs of pieces whose centre lines cross (a level crossing; the game merges their blocks). */
export function crossings(pieces: RailPiece[]): [RailPiece, RailPiece][] {
  const lines = pieces.map((p) => centreLine(p, 8));
  const box = lines.map((l) => ({
    x0: Math.min(...l.map((p) => p.x)), x1: Math.max(...l.map((p) => p.x)),
    y0: Math.min(...l.map((p) => p.y)), y1: Math.max(...l.map((p) => p.y)),
  }));
  const out: [RailPiece, RailPiece][] = [];
  for (let i = 0; i < pieces.length; i++)
    for (let j = i + 1; j < pieces.length; j++) {
      const A = box[i];
      const B = box[j];
      if (A.x1 < B.x0 || B.x1 < A.x0 || A.y1 < B.y0 || B.y1 < A.y0) continue;
      let hit = false;
      for (let s = 0; s < lines[i].length - 1 && !hit; s++)
        for (let t = 0; t < lines[j].length - 1 && !hit; t++)
          hit = segmentsCross(lines[i][s], lines[i][s + 1], lines[j][t], lines[j][t + 1]);
      if (hit) out.push([pieces[i], pieces[j]]);
    }
  return out;
}

export interface Block {
  id: number;
  pieces: RailPiece[];
  length: number;
  /** Has a fork, merge or crossing inside it. */
  isJunction: boolean;
}

export interface SignalIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  at?: Point;
  signalId?: string;
}

export interface SignalReport {
  blocks: Block[];
  blockOf: Map<string, number>;
  issues: SignalIssue[];
}

/** Split the network into signal blocks and check the junction signalling rules. */
export function analyseSignals(pieces: RailPiece[], signals: Signal[], minBlockLength = 0): SignalReport {
  const js = joints(pieces);
  const signalled = new Set(signals.map((s) => key(s.x, s.y)));
  const idx = new Map(pieces.map((p, i) => [p.id, i]));
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => (parent[find(a)] = find(b));

  // Pieces meeting at an unsignalled joint share a block.
  for (const [k, j] of js) {
    if (signalled.has(k)) continue;
    for (let i = 1; i < j.ends.length; i++) union(idx.get(j.ends[0].piece.id)!, idx.get(j.ends[i].piece.id)!);
  }
  const cross = crossings(pieces);
  for (const [a, b] of cross) union(idx.get(a.id)!, idx.get(b.id)!);

  // Junction joints: more than two pieces meet, or crossings.
  const junctionPieces = new Set<string>();
  for (const j of js.values()) if (j.ends.length > 2) j.ends.forEach((e) => junctionPieces.add(e.piece.id));
  for (const [a, b] of cross) {
    junctionPieces.add(a.id);
    junctionPieces.add(b.id);
  }

  const groups = new Map<number, RailPiece[]>();
  pieces.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(p);
  });
  const blocks: Block[] = [];
  const blockOf = new Map<string, number>();
  for (const list of groups.values()) {
    const id = blocks.length;
    blocks.push({
      id, pieces: list,
      length: list.reduce((s, p) => s + pieceLength(p), 0),
      isJunction: list.some((p) => junctionPieces.has(p.id)),
    });
    list.forEach((p) => blockOf.set(p.id, id));
  }

  const issues: SignalIssue[] = [];
  for (const s of signals) {
    const j = js.get(key(s.x, s.y));
    if (!j) {
      issues.push({ severity: 'error', message: 'Signal is not at a rail joint', at: s, signalId: s.id });
      continue;
    }
    // The block a train enters when passing this signal: the piece whose end here points back against travel.
    const ahead = j.ends.find((e) => e.dir === opposite(s.dir));
    const behind = j.ends.find((e) => e.dir === mod16(s.dir));
    if (!ahead || !behind) {
      issues.push({ severity: 'error', message: 'Signal faces a direction no track runs in', at: s, signalId: s.id });
      continue;
    }
    const into = blocks[blockOf.get(ahead.piece.id)!];
    const from = blocks[blockOf.get(behind.piece.id)!];
    if (into.isJunction && s.kind === 'rail')
      issues.push({ severity: 'warning', at: s, signalId: s.id,
        message: 'Rail signal in front of a junction: use a chain signal so trains only enter when they can leave' });
    if (s.kind === 'rail' && !into.isJunction && from.isJunction && minBlockLength > 0 && into.length < minBlockLength)
      issues.push({ severity: 'warning', at: s, signalId: s.id,
        message: `Block after this junction exit is ${into.length.toFixed(1)} tiles, shorter than the train (${minBlockLength}); a waiting train would block the junction` });
  }
  return { blocks, blockOf, issues };
}
