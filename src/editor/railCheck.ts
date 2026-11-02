// Checks for the track in a layout: dead ends, signals and train stops that
// don't stand beside track, and the junction signalling rules from
// src/rails/signals.ts (chain signal in, rail signal out).

import { checkRails, opposite, type Point } from '../rails/geometry';
import { analyseSignals, type Signal } from '../rails/signals';
import { ENTITIES } from './catalog';
import type { Layout, PlacedEntity } from './model';
import { railPiece, signalAt, signalFacing, trainStopAt } from './rails';

export interface RailCheckIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Map point (tile units) to mark. */
  at: Point;
  /** The building it is about, if any. */
  entityId?: string;
}

export interface RailCheck {
  pieces: number;
  signals: number;
  blocks: number;
  deadEnds: Point[];
  issues: RailCheckIssue[];
}

const STEP: Record<number, [number, number]> = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };

/** The rail joint and travel heading a signal building stands for. */
export function signalOf(e: PlacedEntity): Signal {
  const travel = opposite(signalFacing(e));
  const kind = e.name === 'rail-chain-signal' ? 'chain' : 'rail';
  const cx = e.x + 0.5, cy = e.y + 0.5;
  if (e.diagonal) {
    // 45° track: one tile right and half a tile along on each axis.
    const [fx, fy] = DIAG[travel]!;
    const [rx, ry] = [-fy, fx];
    return { id: e.id, kind, x: cx - rx - fx * 0.5, y: cy - ry - fy * 0.5, dir: travel };
  }
  const [fx, fy] = STEP[travel]!;
  const [rx, ry] = [-fy, fx];
  return { id: e.id, kind, x: cx - rx * 1.5 - fx * 0.5, y: cy - ry * 1.5 - fy * 0.5, dir: travel };
}

const DIAG: Record<number, [number, number]> = { 2: [1, -1], 6: [1, 1], 10: [-1, 1], 14: [-1, -1] };

export function checkLayoutRails(layout: Layout): RailCheck | null {
  const rails = layout.rails ?? [];
  const signalEnts = layout.entities.filter((e) => ENTITIES[e.name]?.kind === 'rail-signal');
  const stops = layout.entities.filter((e) => ENTITIES[e.name]?.kind === 'train-stop');
  if (!rails.length && !signalEnts.length && !stops.length) return null;

  const pieces = rails.map((r) => railPiece(r));
  const net = checkRails(pieces);
  const issues: RailCheckIssue[] = net.issues.map((i) => ({ severity: i.severity, message: i.message, at: i.at ?? { x: 0, y: 0 } }));

  // Signals: must guard track beside them, the way they face.
  const placed: Signal[] = [];
  for (const e of signalEnts) {
    const found = signalAt(rails, e.x, e.y, e.direction);
    const d = found && signalFacing(found);
    if (d === signalFacing(e)) placed.push(signalOf(e));
    else
      issues.push({
        severity: 'error',
        entityId: e.id,
        at: { x: e.x + 0.5, y: e.y + 0.5 },
        message: d === null ? 'Signal is not beside a rail joint' : 'Signal faces the wrong way for the track beside it (trains drive on the right)',
      });
  }
  for (const s of stops) {
    const p = trainStopAt(rails, s.x + 1, s.y + 1, s.direction);
    if (!p || p.x !== s.x || p.y !== s.y || p.direction !== s.direction)
      issues.push({ severity: 'error', entityId: s.id, at: { x: s.x + 1, y: s.y + 1 }, message: 'Train stop is not beside straight track on its right' });
  }

  const report = analyseSignals(pieces, placed);
  for (const i of report.issues)
    issues.push({ severity: i.severity, message: i.message, at: i.at ?? { x: 0, y: 0 }, entityId: i.signalId });

  return { pieces: pieces.length, signals: signalEnts.length, blocks: report.blocks.length, deadEnds: net.deadEnds.map((e) => ({ x: e.x, y: e.y })), issues };
}
