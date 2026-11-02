// Building catalog used by the layout editor.
//
// Until the generated game data (data/nauvis.json) lands, this is a small
// hand-written stand-in typed against the shared contract in src/data/types.ts,
// so swapping to the real data is only a change of import. Footprints are the
// Factorio 2.0 base-game sizes, width x height when facing north.

import type { Entity, EntityKind } from '../data/types';

const wiki = (displayName: string) =>
  `https://wiki.factorio.com/${displayName.replace(/ /g, '_')}`;

function e(name: string, displayName: string, kind: EntityKind, prototype: string, width: number, height: number): Entity {
  return { name, displayName, kind, prototype, width, height, item: name, icon: `__base__/graphics/icons/${name}.png`, wikiUrl: wiki(displayName) };
}

const LIST: Entity[] = [
  e('transport-belt', 'Transport belt', 'belt', 'transport-belt', 1, 1),
  e('fast-transport-belt', 'Fast transport belt', 'belt', 'transport-belt', 1, 1),
  e('express-transport-belt', 'Express transport belt', 'belt', 'transport-belt', 1, 1),
  e('burner-inserter', 'Burner inserter', 'inserter', 'inserter', 1, 1),
  e('inserter', 'Inserter', 'inserter', 'inserter', 1, 1),
  e('long-handed-inserter', 'Long-handed inserter', 'inserter', 'inserter', 1, 1),
  e('fast-inserter', 'Fast inserter', 'inserter', 'inserter', 1, 1),
  e('pipe', 'Pipe', 'pipe', 'pipe', 1, 1),
  e('small-electric-pole', 'Small electric pole', 'pole', 'electric-pole', 1, 1),
  e('medium-electric-pole', 'Medium electric pole', 'pole', 'electric-pole', 1, 1),
  e('big-electric-pole', 'Big electric pole', 'pole', 'electric-pole', 2, 2),
  e('substation', 'Substation', 'pole', 'electric-pole', 2, 2),
  e('wooden-chest', 'Wooden chest', 'chest', 'container', 1, 1),
  e('iron-chest', 'Iron chest', 'chest', 'container', 1, 1),
  e('steel-chest', 'Steel chest', 'chest', 'container', 1, 1),
  e('storage-tank', 'Storage tank', 'storage-tank', 'storage-tank', 3, 3),
  e('burner-mining-drill', 'Burner mining drill', 'mining-drill', 'mining-drill', 2, 2),
  e('electric-mining-drill', 'Electric mining drill', 'mining-drill', 'mining-drill', 3, 3),
  e('pumpjack', 'Pumpjack', 'mining-drill', 'mining-drill', 3, 3),
  e('offshore-pump', 'Offshore pump', 'offshore-pump', 'offshore-pump', 1, 2),
  e('stone-furnace', 'Stone furnace', 'furnace', 'furnace', 2, 2),
  e('steel-furnace', 'Steel furnace', 'furnace', 'furnace', 2, 2),
  e('electric-furnace', 'Electric furnace', 'furnace', 'furnace', 3, 3),
  e('assembling-machine-1', 'Assembling machine 1', 'assembler', 'assembling-machine', 3, 3),
  e('assembling-machine-2', 'Assembling machine 2', 'assembler', 'assembling-machine', 3, 3),
  e('assembling-machine-3', 'Assembling machine 3', 'assembler', 'assembling-machine', 3, 3),
  e('oil-refinery', 'Oil refinery', 'refinery', 'assembling-machine', 5, 5),
  e('chemical-plant', 'Chemical plant', 'chemical-plant', 'assembling-machine', 3, 3),
  e('centrifuge', 'Centrifuge', 'centrifuge', 'assembling-machine', 3, 3),
  e('boiler', 'Boiler', 'boiler', 'boiler', 3, 2),
  e('steam-engine', 'Steam engine', 'generator', 'generator', 3, 5),
  e('solar-panel', 'Solar panel', 'solar-panel', 'solar-panel', 3, 3),
  e('accumulator', 'Accumulator', 'accumulator', 'accumulator', 2, 2),
  e('lab', 'Lab', 'lab', 'lab', 3, 3),
  e('beacon', 'Beacon', 'beacon', 'beacon', 3, 3),
  e('rocket-silo', 'Rocket silo', 'rocket-silo', 'rocket-silo', 9, 9),
];

export const ENTITIES: Record<string, Entity> = Object.fromEntries(LIST.map((x) => [x.name, x]));

/** Kinds whose direction matters (or whose footprint changes when rotated). */
const ROTATABLE: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'belt', 'underground-belt', 'splitter', 'inserter', 'mining-drill', 'offshore-pump', 'pump',
  'boiler', 'generator', 'assembler', 'chemical-plant', 'refinery', 'storage-tank', 'pipe-to-ground',
  'steam-turbine', 'heat-exchanger',
]);
export const isRotatable = (ent: Entity) => ROTATABLE.has(ent.kind) || ent.width !== ent.height;

/** Placeholder fill colours, used until sprites are wired in. */
const KIND_COLOR: Partial<Record<EntityKind, number>> = {
  belt: 0xd8b13a, inserter: 0xc9a227, pipe: 0x6c7a89, pole: 0x8a5a2b, chest: 0x9b7653,
  assembler: 0x7d8a96, furnace: 0xa0603a, 'mining-drill': 0x8f7a3a, 'offshore-pump': 0x4f7fa8,
  boiler: 0x8a8a8a, generator: 0x6e6e6e, 'chemical-plant': 0x4f8f5a, refinery: 0x7a6a5a,
  centrifuge: 0x5a8a5a, lab: 0x9fb5c9, beacon: 0x7a5fa8, 'solar-panel': 0x2f4f7f,
  accumulator: 0x5f6f5f, 'storage-tank': 0x777f88, 'rocket-silo': 0x55606a,
};
const NAME_COLOR: Record<string, number> = {
  'fast-transport-belt': 0xc8463b, 'express-transport-belt': 0x3b8bd0,
  'burner-inserter': 0x7a6a4a, 'long-handed-inserter': 0xb5452f, 'fast-inserter': 0x3a7fc0,
  'assembling-machine-1': 0x8a8f7a, 'assembling-machine-3': 0x5f7f9f,
  'steel-furnace': 0x8a5a4a, 'electric-furnace': 0x9a4a3a, 'pumpjack': 0x6a5a7a,
  'medium-electric-pole': 0x8f8f8f, 'big-electric-pole': 0x6f6f6f, substation: 0x5a6a5a,
  'iron-chest': 0x8a8f96, 'steel-chest': 0x9aa3ab, 'burner-mining-drill': 0x6f5f3a,
};
export const entityColor = (ent: Entity) => NAME_COLOR[ent.name] ?? KIND_COLOR[ent.kind] ?? 0x888888;

/** Short label drawn on the building until icons are in. */
export function shortLabel(ent: Entity): string {
  const words = ent.displayName.replace(/machine /i, '').split(/[\s-]+/);
  if (ent.width * ent.height <= 1) return '';
  return words.map((w) => (/^\d$/.test(w) ? w : w[0].toUpperCase())).join('');
}

export const HOTBAR_GROUPS: { title: string; names: string[] }[] = [
  { title: 'Logistics', names: ['transport-belt', 'fast-transport-belt', 'express-transport-belt', 'burner-inserter', 'inserter', 'long-handed-inserter', 'fast-inserter', 'pipe', 'wooden-chest', 'iron-chest', 'steel-chest', 'storage-tank'] },
  { title: 'Power and water', names: ['offshore-pump', 'boiler', 'steam-engine', 'small-electric-pole', 'medium-electric-pole', 'big-electric-pole', 'substation', 'solar-panel', 'accumulator'] },
  { title: 'Production', names: ['burner-mining-drill', 'electric-mining-drill', 'pumpjack', 'stone-furnace', 'steel-furnace', 'electric-furnace', 'assembling-machine-1', 'assembling-machine-2', 'assembling-machine-3', 'oil-refinery', 'chemical-plant', 'centrifuge', 'lab', 'beacon', 'rocket-silo'] },
];
