// Runs the companion mod's Lua (data-final-fixes.lua and control.lua) in a Lua VM
// against a fake game, then reads the export back with the website's loader.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from 'fengari';
import { strToU8, zlibSync, zipSync } from 'fflate';
import { decodeEncoded, findExport, loadBytes } from '../src/export/load';
import { FIELDS } from '../src/export/format';

const modDir = new URL('../mod/map-viewer-export/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, modDir), 'utf8');
const fakeSrc = readFileSync(new URL('./fixtures/fake-factorio.lua', import.meta.url), 'utf8');

function newState() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  // helpers.encode_string = deflate + base64, done in JS.
  lua.lua_pushjsfunction(L, (Ls: unknown) => {
    const s = to_jsstring(lua.lua_tostring(Ls, 1));
    const b64 = Buffer.from(zlibSync(strToU8(s))).toString('base64');
    lua.lua_pushstring(Ls, to_luastring(b64));
    return 1;
  });
  lua.lua_setglobal(L, to_luastring('js_encode'));
  return L;
}

function run(L: unknown, code: string, name: string) {
  if (lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring(name)) !== lua.LUA_OK
    || lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0) !== lua.LUA_OK) {
    throw new Error(`${name}: ${to_jsstring(lua.lua_tostring(L, -1))}`);
  }
}

function global(L: unknown, expr: string): string | undefined {
  run(L, `__out = ${expr}`, 'get');
  lua.lua_getglobal(L, to_luastring('__out'));
  const v = lua.lua_isstring(L, -1) ? to_jsstring(lua.lua_tostring(L, -1)) : undefined;
  lua.lua_pop(L, 1);
  return v;
}

const scenario = `
fake = (function() ${fakeSrc} end)()
local E = fake.entity
fake.setup({
  { name = "nauvis", index = 1, planet = "nauvis",
    chunks = { {0, 0}, {-1, 0}, {5, 5} },
    tile = function(x, y) if x >= 4 and x < 8 and y >= 0 and y < 2 then return "water" end return "grass-1" end,
    entities = {
      E("assembling-machine-2", 2.5, 2.5, { recipe = "iron-gear-wheel" }),
      E("transport-belt", 10.5, 3.5, { direction = 4 }),
      E("tree-01", -3.3, 7.6, { force = 3 }),
      E("character", 1, 1),
      E("biter-spawner", -1.5, 20.5, { force = 2 }),
      E("locomotive", 12, 12, { orientation = 0.25 }),
      E("transport-belt", 170.5, 170.5),
    } },
  { name = "platform-1", index = 2, platform = "Express",
    chunks = { {0, 0} },
    tile = function(x, y) if x < 10 and y < 10 then return "space-platform-foundation" end return "empty-space" end,
    entities = { E("space-platform-hub", 4, 4) } },
}, { nauvis = { ["0,0"] = true, ["-1,0"] = true } })
`;

describe('companion mod', () => {
  it('collects icon paths into a mod-data prototype', () => {
    const L = newState();
    run(L, `
      data = { raw = {
        item = { ["iron-plate"] = { icon = "__base__/graphics/icons/iron-plate.png" } },
        recipe = { ["barrel"] = { icons = { { icon = "__base__/graphics/icons/barrel.png" }, { icon = "x" } } } },
        ["noise-expression"] = { foo = { expression = "1" } },
      } }
      function data:extend(list) for _, p in ipairs(list) do self.raw[p.type] = self.raw[p.type] or {}; self.raw[p.type][p.name] = p end end
    `, 'setup');
    run(L, read('data.lua'), 'data.lua');
    run(L, read('data-final-fixes.lua'), 'data-final-fixes.lua');
    expect(global(L, 'data.raw["mod-data"]["map-viewer-export-icons"].data.item["iron-plate"]')).toBe('__base__/graphics/icons/iron-plate.png');
    expect(global(L, 'data.raw["mod-data"]["map-viewer-export-icons"].data.recipe.barrel')).toBe('__base__/graphics/icons/barrel.png');
    expect(global(L, 'tostring(data.raw["mod-data"]["map-viewer-export-icons"].data["noise-expression"])')).toBe('nil');
    expect(global(L, 'data.raw["custom-input"]["map-viewer-export"].key_sequence')).toBe('CONTROL + ALT + M');
  });

  it('exports every surface over several ticks and the site reads it back', () => {
    const L = newState();
    run(L, scenario, 'scenario');
    run(L, `prototypes.mod_data["map-viewer-export-icons"] = { data = {
      ["assembling-machine"] = { ["assembling-machine-2"] = "__base__/graphics/icons/assembling-machine-2.png" },
      item = { ["transport-belt"] = "__base__/graphics/icons/transport-belt.png", ["iron-gear-wheel"] = "__base__/graphics/icons/iron-gear-wheel.png" },
    } }`, 'icons');
    run(L, read('control.lua'), 'control.lua');
    run(L, 'fake.commands["map-export"]({ player_index = 1 })', 'command');
    expect(global(L, 'tostring(storage.job ~= nil)')).toBe('true');
    run(L, 'fake.run_ticks(50)', 'ticks');
    expect(global(L, 'tostring(storage.job)')).toBe('nil');

    const stored = global(L, 'storage.export')!;
    const file = global(L, 'fake.files["map-viewer-export.txt"].data');
    expect(file).toBe(stored);
    expect(global(L, 'fake.printed[#fake.printed][2]')).toContain('Done');

    const map = decodeEncoded(findExport(strToU8(stored))!);
    expect(map.gameVersion).toBe('2.1.24');
    expect(map.surfaces.map((s) => s.name)).toEqual(['nauvis', 'platform-1']);

    const nauvis = map.surfaces[0];
    // Only charted chunks: (5,5) was generated but never charted.
    expect([...nauvis.chunks.keys()].sort()).toEqual(['-1,0', '0,0']);
    const tiles = (name: string) => map.tiles.findIndex((t) => t.name === name);
    const c0 = nauvis.chunks.get('0,0')!;
    expect(c0.tiles[0 * 32 + 4]).toBe(tiles('water'));
    expect(c0.tiles[1 * 32 + 7]).toBe(tiles('water'));
    expect(c0.tiles[2 * 32 + 4]).toBe(tiles('grass-1'));
    expect(nauvis.chunks.get('-1,0')!.tiles.every((t) => t === tiles('grass-1'))).toBe(true);
    expect(map.tiles[tiles('water')].color).toEqual([51, 83, 95]);

    const names = Array.from(nauvis.proto, (p) => map.protos[p].name);
    // The character is skipped; the belt in uncharted chunk (5,5) isn't visited.
    expect(names.sort()).toEqual(['assembling-machine-2', 'biter-spawner', 'locomotive', 'transport-belt', 'tree-01']);
    // The spawner straddles chunks 0 and -1 but is exported once.
    expect(names.filter((n) => n === 'biter-spawner')).toHaveLength(1);

    const find = (name: string) => Array.from(nauvis.proto).findIndex((p) => map.protos[p].name === name);
    const am = find('assembling-machine-2');
    expect([nauvis.x[am], nauvis.y[am]]).toEqual([2.5, 2.5]);
    expect(map.recipes[nauvis.recipe[am] - 1].name).toBe('iron-gear-wheel');
    expect(map.recipes[nauvis.recipe[am] - 1].icon).toBe('__base__/graphics/icons/iron-gear-wheel.png');
    expect(map.protos[nauvis.proto[am]].icon).toBe('__base__/graphics/icons/assembling-machine-2.png');
    const belt = find('transport-belt');
    expect(nauvis.dir[belt]).toBe(4);
    expect(map.protos[nauvis.proto[belt]].icon).toBe('__base__/graphics/icons/transport-belt.png');
    expect(map.protos[nauvis.proto[belt]].own).toEqual([204, 179, 0]);
    expect(nauvis.dir[find('locomotive')]).toBe(16);
    const tree = find('tree-01');
    expect([nauvis.x[tree], nauvis.y[tree]]).toEqual([-3.25, 7.625]);
    expect(map.forces.get(nauvis.force[find('biter-spawner')])).toBe('enemy');

    const platform = map.surfaces[1];
    expect(platform.kind).toBe('platform');
    expect(platform.platform).toBe('Express');
    expect(platform.count).toBe(1);

    // The same export found inside a save's script.dat.
    const save = zipSync({
      'my-save/level.dat0': zlibSync(new Uint8Array([2, 0, 1, 0, 24, 0, 1, 0, 0, 0])),
      'my-save/script.dat': new Uint8Array([...strToU8('\x04junk'), ...strToU8(stored), 0, 1, 2]),
    });
    const res = loadBytes(save);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.save?.version).toBe('2.1.24');
      expect(res.map.surfaces[0].count).toBe(nauvis.count);
    }
  });

  it('keeps exporting after a save and load mid-way', () => {
    const L = newState();
    run(L, scenario, 'scenario');
    run(L, read('control.lua'), 'control.lua');
    run(L, 'fake.commands["map-export"]({ player_index = 1 })', 'command');
    // Simulate a load: handlers are gone until on_load registers them again.
    run(L, 'fake.handlers = {}; fake.on_load()', 'reload');
    run(L, 'fake.run_ticks(50)', 'ticks');
    const map = decodeEncoded(findExport(strToU8(global(L, 'storage.export')!))!);
    expect(map.surfaces[0].count / 1).toBe(5);
    expect(FIELDS).toBe(6);
  });
});
