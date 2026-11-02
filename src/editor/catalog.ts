// Building catalog for the layout editor: the placeable buildings from the
// generated game data, plus editor-only presentation (colours, hotbar groups).

import { gameData } from '../data';
import type { Entity, EntityKind } from '../data/types';

export const ENTITIES: Record<string, Entity> = gameData.entities;

/** Kinds whose direction matters (or whose footprint changes when rotated). */
const ROTATABLE: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'belt', 'underground-belt', 'splitter', 'inserter', 'mining-drill', 'offshore-pump', 'pump',
  'boiler', 'generator', 'assembler', 'chemical-plant', 'refinery', 'storage-tank', 'pipe-to-ground',
  'steam-turbine', 'heat-exchanger', 'rail-signal', 'train-stop', 'combinator', 'gate',
]);
export const isRotatable = (ent: Entity) => ROTATABLE.has(ent.kind) || ent.width !== ent.height;

/** Placeholder fill colours, used until sprites are wired in. */
const KIND_COLOR: Partial<Record<EntityKind, number>> = {
  belt: 0xd8b13a, inserter: 0xc9a227, pipe: 0x6c7a89, pole: 0x8a5a2b, chest: 0x9b7653,
  assembler: 0x7d8a96, furnace: 0xa0603a, 'mining-drill': 0x8f7a3a, 'offshore-pump': 0x4f7fa8,
  boiler: 0x8a8a8a, generator: 0x6e6e6e, 'chemical-plant': 0x4f8f5a, refinery: 0x7a6a5a,
  centrifuge: 0x5a8a5a, lab: 0x9fb5c9, beacon: 0x7a5fa8, 'solar-panel': 0x2f4f7f,
  accumulator: 0x5f6f5f, 'storage-tank': 0x777f88, 'rocket-silo': 0x55606a,
  'underground-belt': 0xb8912a, splitter: 0xd8b13a, 'pipe-to-ground': 0x5c6a79, pump: 0x5a7a9a,
  reactor: 0x4a7a4a, 'heat-exchanger': 0x9a6a5a, 'steam-turbine': 0x7a7a7a,
  'rail-signal': 0x4f9a4f, 'train-stop': 0xa04a3a,
  radar: 0x6a7a6a, lamp: 0xd8d080, wall: 0x9a9a8a, gate: 0x8a9aaa, turret: 0x8a6a4a,
  combinator: 0x5a7a5a, circuit: 0x6a6a8a, 'heat-pipe': 0xa05a3a,
};
const NAME_COLOR: Record<string, number> = {
  'fast-transport-belt': 0xc8463b, 'express-transport-belt': 0x3b8bd0,
  'burner-inserter': 0x7a6a4a, 'long-handed-inserter': 0xb5452f, 'fast-inserter': 0x3a7fc0,
  'assembling-machine-1': 0x8a8f7a, 'assembling-machine-3': 0x5f7f9f,
  'steel-furnace': 0x8a5a4a, 'electric-furnace': 0x9a4a3a, 'pumpjack': 0x6a5a7a,
  'medium-electric-pole': 0x8f8f8f, 'big-electric-pole': 0x6f6f6f, substation: 0x5a6a5a,
  'iron-chest': 0x8a8f96, 'steel-chest': 0x9aa3ab, 'burner-mining-drill': 0x6f5f3a,
  'fast-underground-belt': 0xc8463b, 'express-underground-belt': 0x3b8bd0,
  'fast-splitter': 0xc8463b, 'express-splitter': 0x3b8bd0, 'bulk-inserter': 0x4a9a4a,
  'active-provider-chest': 0x9a4a8a, 'passive-provider-chest': 0xb04a4a, 'storage-chest': 0xb09a3a,
  'buffer-chest': 0x4a9a4a, 'requester-chest': 0x3a6ab0, 'rail-chain-signal': 0x3a7fc0,
};
export const entityColor = (ent: Entity) => NAME_COLOR[ent.name] ?? KIND_COLOR[ent.kind] ?? 0x888888;

/** Short label drawn on the building until icons are in. */
export function shortLabel(ent: Entity): string {
  const words = ent.displayName.replace(/machine /i, '').split(/[\s-]+/);
  if (ent.width * ent.height <= 1) return '';
  return words.map((w) => (/^\d$/.test(w) ? w : w[0].toUpperCase())).join('');
}

/** Palette groups, in the order the game's crafting menu roughly uses. */
const GROUPS: { title: string; kinds: EntityKind[] }[] = [
  { title: 'Belts', kinds: ['belt', 'underground-belt', 'splitter'] },
  { title: 'Inserters and storage', kinds: ['inserter', 'chest', 'storage-tank'] },
  { title: 'Water and fluids', kinds: ['offshore-pump', 'pipe', 'pipe-to-ground', 'pump'] },
  { title: 'Power', kinds: ['pole', 'boiler', 'generator', 'solar-panel', 'accumulator', 'reactor', 'heat-pipe', 'heat-exchanger', 'steam-turbine'] },
  { title: 'Robots', kinds: ['roboport'] },
  { title: 'Trains', kinds: ['rail-signal', 'train-stop'] },
  { title: 'Mining and smelting', kinds: ['mining-drill', 'furnace'] },
  { title: 'Circuits and lamps', kinds: ['combinator', 'circuit', 'lamp'] },
  { title: 'Defense', kinds: ['wall', 'gate', 'turret', 'radar'] },
  { title: 'Production', kinds: ['assembler', 'refinery', 'chemical-plant', 'centrifuge', 'lab', 'beacon', 'rocket-silo'] },
];

export const HOTBAR_GROUPS: { title: string; names: string[] }[] = (() => {
  const all = Object.values(ENTITIES);
  const used = new Set<string>();
  const groups = GROUPS.map((g) => {
    const names = all
      .filter((e) => g.kinds.includes(e.kind))
      .sort((a, b) => g.kinds.indexOf(a.kind) - g.kinds.indexOf(b.kind) || a.name.localeCompare(b.name, 'en', { numeric: true }))
      .map((e) => e.name);
    names.forEach((n) => used.add(n));
    return { title: g.title, names };
  });
  // Locomotives and wagons stand on track rather than being built, so they are not in the palette.
  const rest = all.filter((e) => !used.has(e.name) && e.kind !== 'rolling-stock').map((e) => e.name);
  if (rest.length) groups.push({ title: 'Other', names: rest });
  return groups.filter((g) => g.names.length);
})();
