// A small made-up map so the viewer can be tried without the game:
// a patch of Nauvis with ore, trees, water and a little smelting line,
// and a tiny space platform.

import { decodeExport, type MapExport, type RawExport } from './format';

type RGB = [number, number, number];

export function demoRaw(): RawExport {
  const tiles: { name: string; color: RGB }[] = [
    { name: 'grass-1', color: [55, 83, 22] },
    { name: 'dry-dirt', color: [94, 75, 49] },
    { name: 'water', color: [51, 83, 95] },
    { name: 'stone-path', color: [70, 70, 70] },
    { name: 'concrete', color: [60, 60, 60] },
    { name: 'empty-space', color: [0, 0, 0] },
    { name: 'space-platform-foundation', color: [80, 80, 90] },
  ];
  const ents: RawExport['entities'] = [];
  const idx = new Map<string, number>();
  const proto = (name: string, type: string, w: number, h: number, color: RGB, icon?: string) => {
    if (!idx.has(name)) {
      ents.push({ name, type, w, h, color, friendly_color: color, enemy_color: [200, 40, 40], icon });
      idx.set(name, ents.length);
    }
    return idx.get(name)!;
  };
  const icon = (n: string) => `__base__/graphics/icons/${n}.png`;
  const P = {
    iron: proto('iron-ore', 'resource', 1, 1, [104, 132, 146], icon('iron-ore')),
    copper: proto('copper-ore', 'resource', 1, 1, [203, 97, 53], icon('copper-ore')),
    tree: proto('tree-01', 'tree', 1, 1, [40, 90, 30]),
    drill: proto('electric-mining-drill', 'mining-drill', 3, 3, [0, 140, 210], icon('electric-mining-drill')),
    belt: proto('transport-belt', 'transport-belt', 1, 1, [214, 180, 0], icon('transport-belt')),
    inserter: proto('inserter', 'inserter', 1, 1, [0, 140, 210], icon('inserter')),
    furnace: proto('stone-furnace', 'furnace', 2, 2, [0, 140, 210], icon('stone-furnace')),
    assembler: proto('assembling-machine-2', 'assembling-machine', 3, 3, [0, 140, 210], icon('assembling-machine-2')),
    pole: proto('medium-electric-pole', 'electric-pole', 1, 1, [0, 140, 210], icon('medium-electric-pole')),
    rail: proto('straight-rail', 'straight-rail', 2, 2, [140, 140, 140], icon('rail')),
    nest: proto('biter-spawner', 'unit-spawner', 5, 5, [200, 40, 40], icon('biter-spawner')),
    hub: proto('space-platform-hub', 'space-platform-hub', 8, 8, [0, 140, 210]),
  };
  const recipes = [
    { name: 'iron-plate', icon: icon('iron-plate') },
    { name: 'iron-gear-wheel', icon: icon('iron-gear-wheel') },
  ];

  // Deterministic noise so the demo looks the same every time.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const n2 = (x: number, y: number) => Math.sin(x * 0.07 + Math.sin(y * 0.05) * 2) + Math.cos(y * 0.06 - Math.sin(x * 0.04) * 2);

  const R = 4; // chunks from the centre on Nauvis
  const chunks: (number | string)[] = [];
  const list: number[] = [];
  const add = (p: number, x: number, y: number, dir = 0, force = 1, recipe = 0) =>
    list.push(p, Math.round(x * 8), Math.round(y * 8), dir, force, recipe);

  for (let cy = -R; cy < R; cy++)
    for (let cx = -R; cx < R; cx++) {
      const runs: string[] = [];
      for (let ty = 0; ty < 32; ty++)
        for (let tx = 0; tx < 32; tx++) {
          const x = cx * 32 + tx, y = cy * 32 + ty;
          const v = n2(x, y);
          let t = v > 1.3 ? 2 : v > 0.4 ? 1 : 0;
          if (Math.abs(y - 4) <= 1 && x > -60 && x < 60) t = 4;
          runs.push(String(t));
          if (t === 0 && v < -0.6 && rand() < 0.35) add(P.tree, x + 0.5, y + 0.5, 0, 3);
        }
      chunks.push(cx, cy, runs.join(','));
    }
  for (let y = -50; y < -30; y++) for (let x = -50; x < -26; x++) add(P.iron, x + 0.5, y + 0.5, 0, 3);
  for (let y = 30; y < 46; y++) for (let x = 40; x < 60; x++) add(P.copper, x + 0.5, y + 0.5, 0, 3);
  // Drills on iron, a belt down to a furnace row and a gear assembler.
  for (let i = 0; i < 4; i++) add(P.drill, -47.5 + i * 6, -40.5, 8);
  for (let y = -38; y <= 2; y++) add(P.belt, -36.5, y + 0.5, 8);
  for (let x = -36; x <= 20; x++) add(P.belt, x + 0.5, 2.5, 4);
  for (let i = 0; i < 8; i++) {
    add(P.inserter, -30.5 + i * 4, 1.5, 0);
    add(P.furnace, -30 + i * 4, -1, 0, 1, 1);
  }
  add(P.assembler, 24.5, 2.5, 0, 1, 2);
  for (let x = -40; x <= 30; x += 7) add(P.pole, x + 0.5, 5.5);
  for (let x = -60; x < 60; x += 2) add(P.rail, x + 1, 9, 4);
  add(P.nest, 90.5, -90.5, 0, 2);

  // A small platform: foundation square in empty space.
  const pchunks: (number | string)[] = [];
  const plist: number[] = [];
  for (let cy = -1; cy < 1; cy++)
    for (let cx = -1; cx < 1; cx++) {
      const runs: string[] = [];
      for (let ty = 0; ty < 32; ty++)
        for (let tx = 0; tx < 32; tx++) {
          const x = cx * 32 + tx, y = cy * 32 + ty;
          runs.push(Math.abs(x) < 12 && Math.abs(y) < 16 ? '6' : '5');
        }
      pchunks.push(cx, cy, runs.join(','));
    }
  plist.push(P.hub, 0, 0, 0, 1, 0);

  return {
    format: 1,
    game_version: '2.1.24',
    mods: { base: '2.1.24' },
    tick: 1234567,
    player_force: 1,
    tiles,
    entities: ents,
    recipes,
    forces: [{ index: 1, name: 'player' }, { index: 2, name: 'enemy' }, { index: 3, name: 'neutral' }],
    surfaces: [
      { name: 'nauvis', index: 1, planet: 'nauvis', chunks, entities: list },
      { name: 'platform-1', index: 2, platform: 'Demo platform', chunks: pchunks, entities: plist },
    ],
  };
}

export const demoMap = (): MapExport => decodeExport(demoRaw());
