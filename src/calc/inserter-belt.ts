// Inserter throughput when a belt is involved. Chest-to-chest is a clean
// formula (whole hand per arm cycle); belts are not, so these come from
// measurements on the Factorio wiki's Inserters page.
//
// - Chest/machine -> belt: the wiki's 2.0 measurements (inserters dropping on
//   an empty belt), normal quality. Used as measured.
// - Belt -> chest/machine: the wiki only has 1.1 measurements (perpendicular
//   belt, items on the far lane moving at belt speed). DERIVED: we take the
//   1.1 figure and scale it by how much faster the arm cycles in 2.0 than in
//   1.1 for that inserter. Treat these as estimates.
//
// Hand sizes between measured points are interpolated linearly; above the
// largest measured hand the largest measurement is used.

import type { Entity } from '../data/types';

type BeltTier = 0 | 1 | 2; // transport, fast, express

/** [hand size, [yellow, red, blue] items/s] */
type Table = Record<string, [number, [number, number, number]][]>;

/** Wiki "Chest to belt", 2.0, normal quality (first value of each cell). */
const CHEST_TO_BELT: Table = {
  'burner-inserter': [[1, [0.78, 0.78, 0.78]], [2, [1.57, 1.57, 1.57]], [3, [2.15, 2.25, 2.3]]],
  inserter: [[1, [0.85, 0.85, 0.85]], [2, [1.7, 1.7, 1.7]], [3, [2.3, 2.45, 2.5]]],
  'long-handed-inserter': [[1, [1.2, 1.2, 1.2]], [2, [2.33, 2.33, 2.33]], [3, [3.1, 3.35, 3.45]]],
  'fast-inserter': [[1, [2.5, 2.5, 2.5]], [2, [4.8, 4.8, 4.8]], [3, [5.62, 6.42, 6.9]]],
  'bulk-inserter': [[2, [4.8, 4.8, 4.8]], [4, [6, 7.5, 8.27]], [12, [6.93, 11.23, 14.4]]],
};

/** Wiki "Belt to chest (perpendicular)", 1.1, items at belt speed. */
const BELT_TO_CHEST_1_1: Table = {
  'burner-inserter': [[1, [0.6, 0.65, 0.5]], [2, [1.11, 1.2, 1.13]], [3, [1.61, 1.61, 1.65]]],
  inserter: [[1, [0.94, 0.94, 0.94]], [2, [1.67, 1.67, 1.5]], [3, [2.5, 2.25, 2.33]]],
  'long-handed-inserter': [[1, [1.18, 1.18, 1.25]], [2, [2.2, 2.31, 2.4]], [3, [3.21, 3.21, 3.46]]],
  'fast-inserter': [[1, [2.5, 2.31, 2.5]], [2, [4.5, 4.29, 5]], [3, [6.43, 6, 6.43]]],
  // 1.1's stack inserter is 2.0's bulk inserter.
  'bulk-inserter': [[2, [4.5, 4.29, 5]], [4, [7.5, 7.5, 8]], [12, [7.5, 11.25, 15]]],
};

/** 1.1 chest-to-chest arm cycles per second, to scale 1.1 belt figures to 2.0. */
const CYCLES_1_1: Record<string, number> = {
  'burner-inserter': 0.6,
  inserter: 0.83,
  'long-handed-inserter': 1.15,
  'fast-inserter': 2.31,
  'bulk-inserter': 2.31,
};

export function beltTier(belt: Entity): BeltTier {
  const t = belt.beltThroughput ?? 15;
  return t <= 15 ? 0 : t <= 30 ? 1 : 2;
}

function lookup(table: Table, inserter: string, hand: number, tier: BeltTier): number | undefined {
  const rows = table[inserter];
  if (!rows) return undefined;
  const first = rows[0]!;
  if (hand <= first[0]) return (first[1][tier] * hand) / first[0];
  for (let i = 1; i < rows.length; i++) {
    const [h1, v1] = rows[i]!;
    const [h0, v0] = rows[i - 1]!;
    if (hand <= h1) return v0[tier] + ((v1[tier] - v0[tier]) * (hand - h0)) / (h1 - h0);
  }
  return rows[rows.length - 1]![1][tier];
}

/** Items/s dropping onto a belt (measured, 2.0). Undefined if not in the table. */
export function chestToBelt(inserter: Entity, hand: number, belt: Entity): number | undefined {
  return lookup(CHEST_TO_BELT, inserter.name, hand, beltTier(belt));
}

/**
 * Items/s taking from a belt (derived from 1.1 measurements scaled to 2.0 arm
 * speed). `cycles20` is the 2.0 chest-to-chest arm cycles per second.
 */
export function beltToChest(inserter: Entity, hand: number, belt: Entity, cycles20: number): number | undefined {
  const v = lookup(BELT_TO_CHEST_1_1, inserter.name, hand, beltTier(belt));
  const c11 = CYCLES_1_1[inserter.name];
  if (v === undefined || !c11) return undefined;
  return (v * cycles20) / c11;
}
