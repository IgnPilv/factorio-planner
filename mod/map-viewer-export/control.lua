-- Map Viewer Export
--
-- Walks every surface (planets and space platforms) a chunk at a time, over
-- several ticks, and records tiles and entities. The result is JSON, deflated
-- and base64-encoded by the game, wrapped in two marker strings and
--   * kept in `storage`, so it travels inside the next save file
--     (the website finds it in the save's script.dat), and
--   * written to script-output/map-viewer-export.txt.
--
-- Format (version 1), all positions in 1/8 tiles:
--   tiles      = { {name, color}, ... }        tile palette, referenced 0-based
--   entities   = { {name, type, w, h, color, friendly_color, enemy_color, icon}, ... }
--   recipes    = { {name, icon}, ... }
--   forces     = { {index, name}, ... }
--   surfaces   = { {name, index, planet, platform, chunks, entities}, ... }
--     chunks   = flat { cx, cy, "tile runs", ... }  runs: "idx" or "idx*count",
--                comma separated, row by row (y outer, x inner), 1024 tiles
--     entities = flat { proto, x, y, dir, force, recipe, ... } 6 numbers each;
--                proto/recipe are 1-based (recipe 0 = none); dir is
--                defines.direction (0-15), or orientation * 64 for vehicles

local MARK_START = "FACTORIO-MAP-VIEWER-EXPORT-1:"
local MARK_END = ":END-FACTORIO-MAP-VIEWER-EXPORT"
local OUTPUT_FILE = "map-viewer-export.txt"
local CHUNKS_PER_TICK = 24
local FIELDS = 6

-- Short-lived or purely visual entities that don't belong on a map.
local SKIP_TYPES = {
  ["arrow"] = true, ["artillery-flare"] = true, ["artillery-projectile"] = true,
  ["beam"] = true, ["character"] = true, ["character-corpse"] = true, ["corpse"] = true,
  ["rail-remnants"] = true, ["deconstructible-tile-proxy"] = true, ["entity-ghost"] = true,
  ["tile-ghost"] = true, ["explosion"] = true, ["fire"] = true, ["stream"] = true,
  ["highlight-box"] = true, ["item-request-proxy"] = true, ["lightning"] = true,
  ["particle-source"] = true, ["projectile"] = true, ["rocket-silo-rocket"] = true,
  ["rocket-silo-rocket-shadow"] = true, ["smoke-with-trigger"] = true,
  ["speech-bubble"] = true, ["sticker"] = true, ["unit"] = true, ["spider-leg"] = true,
  ["combat-robot"] = true, ["construction-robot"] = true, ["logistic-robot"] = true,
  ["capture-robot"] = true, ["cargo-pod"] = true, ["fish"] = true,
}

local CRAFTERS = { ["assembling-machine"] = true, ["furnace"] = true, ["rocket-silo"] = true }

-- Free-rotating entities: store orientation instead of direction.
local VEHICLES = {
  ["car"] = true, ["spider-vehicle"] = true, ["locomotive"] = true, ["cargo-wagon"] = true,
  ["infinity-cargo-wagon"] = true, ["fluid-wagon"] = true, ["artillery-wagon"] = true,
}

local function message(job, text)
  local player = job and job.player_index and game.get_player(job.player_index)
  if player and player.valid then player.print(text) else game.print(text) end
end

local function intern(list, lookup, name)
  local i = lookup[name]
  if not i then
    i = #list + 1
    list[i] = name
    lookup[name] = i
  end
  return i
end

-- ---- walking the map -------------------------------------------------------

local function chunk_list(surface, force)
  local list = {}
  local platform = surface.platform ~= nil
  for chunk in surface.get_chunks() do
    if platform or force.is_chunk_charted(surface, { chunk.x, chunk.y }) then
      list[#list + 1] = chunk.x
      list[#list + 1] = chunk.y
    end
  end
  return list
end

local function tile_runs(job, surface, x0, y0)
  local area = { { x0, y0 }, { x0 + 32, y0 + 32 } }
  local first = surface.get_tile(x0, y0).name
  local total = surface.count_tiles_filtered({ area = area })
  if total == 1024 and surface.count_tiles_filtered({ area = area, name = first }) == 1024 then
    return (intern(job.tiles, job.tile_lookup, first) - 1) .. "*1024"
  end
  local parts, n = {}, 0
  local prev, run = nil, 0
  for y = y0, y0 + 31 do
    for x = x0, x0 + 31 do
      local idx = intern(job.tiles, job.tile_lookup, surface.get_tile(x, y).name) - 1
      if idx == prev then
        run = run + 1
      else
        if prev then
          n = n + 1
          parts[n] = run > 1 and (prev .. "*" .. run) or tostring(prev)
        end
        prev, run = idx, 1
      end
    end
  end
  n = n + 1
  parts[n] = run > 1 and (prev .. "*" .. run) or tostring(prev)
  return table.concat(parts, ",")
end

local function round8(v)
  return math.floor(v * 8 + 0.5)
end

local function record_entities(job, surface, out, x0, y0)
  local list = out.entities
  local n = #list
  local x1, y1 = x0 + 32, y0 + 32
  for _, e in pairs(surface.find_entities_filtered({ area = { { x0, y0 }, { x1, y1 } } })) do
    local t = e.type
    if not SKIP_TYPES[t] then
      local p = e.position
      -- An entity overlapping several chunks is found once per chunk; keep it in the
      -- chunk that holds its centre.
      if p.x >= x0 and p.x < x1 and p.y >= y0 and p.y < y1 then
        local dir
        if VEHICLES[t] then
          dir = math.floor(e.orientation * 64 + 0.5) % 64
        else
          dir = e.direction or 0
        end
        local recipe = 0
        if CRAFTERS[t] then
          local r = e.get_recipe()
          if r then recipe = intern(job.recipes, job.recipe_lookup, r.name) end
        end
        list[n + 1] = intern(job.protos, job.proto_lookup, e.name)
        list[n + 2] = round8(p.x)
        list[n + 3] = round8(p.y)
        list[n + 4] = dir
        list[n + 5] = e.force_index
        list[n + 6] = recipe
        n = n + FIELDS
      end
    end
  end
end

-- ---- prototype tables --------------------------------------------------------

local function color(c)
  if not c then return nil end
  return { c.r or 0, c.g or 0, c.b or 0 }
end

local function item_icon(icons, name)
  local item = prototypes.item[name]
  if not item then return nil end
  return icons[item.type] and icons[item.type][name]
end

local function product_icon(icons, product)
  if not product then return nil end
  if product.type == "fluid" then return icons.fluid and icons.fluid[product.name] end
  return item_icon(icons, product.name)
end

local function load_icons()
  local md = prototypes.mod_data["map-viewer-export-icons"]
  return (md and md.data) or {}
end

local function prototype_tables(job)
  local icons = load_icons()

  local tiles = {}
  for i, name in ipairs(job.tiles) do
    local proto = prototypes.tile[name]
    tiles[i] = { name = name, color = color(proto and proto.map_color) }
  end

  local entities = {}
  for i, name in ipairs(job.protos) do
    local proto = prototypes.entity[name]
    local row = { name = name }
    if proto then
      row.type = proto.type
      row.w = proto.tile_width
      row.h = proto.tile_height
      row.color = color(proto.map_color)
      row.friendly_color = color(proto.friendly_map_color)
      row.enemy_color = color(proto.enemy_map_color)
      row.icon = icons[proto.type] and icons[proto.type][name]
      if not row.icon and proto.items_to_place_this and proto.items_to_place_this[1] then
        row.icon = item_icon(icons, proto.items_to_place_this[1].name)
      end
    end
    entities[i] = row
  end

  local recipes = {}
  for i, name in ipairs(job.recipes) do
    local proto = prototypes.recipe[name]
    local icon = icons.recipe and icons.recipe[name]
    if not icon and proto then
      icon = product_icon(icons, proto.main_product) or product_icon(icons, proto.products and proto.products[1])
    end
    recipes[i] = { name = name, icon = icon }
  end

  local forces = {}
  for _, force in pairs(game.forces) do
    forces[#forces + 1] = { index = force.index, name = force.name }
  end

  return tiles, entities, recipes, forces
end

-- ---- the job -----------------------------------------------------------------

local on_tick

local function start_surface(job)
  while job.surface_pos <= #job.surface_indices do
    local surface = game.get_surface(job.surface_indices[job.surface_pos])
    local force = game.forces[job.force_name]
    if surface and surface.valid and force then
      local chunks = chunk_list(surface, force)
      if #chunks > 0 then
        job.chunks = chunks
        job.chunk_pos = 1
        job.current = {
          name = surface.name,
          index = surface.index,
          planet = surface.planet and surface.planet.name or nil,
          platform = surface.platform and surface.platform.name or nil,
          chunks = {},
          entities = {},
        }
        message(job, { "", "[Map Viewer] Exporting ", surface.name, " (", #chunks / 2, " chunks)..." })
        return true
      end
    end
    job.surface_pos = job.surface_pos + 1
  end
  return false
end

local function finish(job)
  local tiles, entities, recipes, forces = prototype_tables(job)
  local export = {
    format = 1,
    game_version = script.active_mods["base"],
    mods = script.active_mods,
    tick = game.tick,
    player_force = game.forces[job.force_name] and game.forces[job.force_name].index or 1,
    tiles = tiles,
    entities = entities,
    recipes = recipes,
    forces = forces,
    surfaces = job.done,
  }
  local json = helpers.table_to_json(export)
  local encoded = helpers.encode_string(json)
  if not encoded then
    storage.job = nil
    script.on_event(defines.events.on_tick, nil)
    message(job, "[Map Viewer] Export failed: the game could not compress the map data.")
    return
  end
  storage.export = MARK_START .. encoded .. MARK_END
  storage.job = nil
  script.on_event(defines.events.on_tick, nil)
  helpers.write_file(OUTPUT_FILE, storage.export, false, job.player_index)

  local count = 0
  for _, s in ipairs(job.done) do count = count + #s.entities / FIELDS end
  message(job, { "",
    "[Map Viewer] Done: ", #job.done, " surfaces, ", count, " entities. ",
    "Save the game and drop the save .zip on the Map Viewer website ",
    "(or use script-output/", OUTPUT_FILE, ")." })
end

on_tick = function()
  local job = storage.job
  if not job then
    script.on_event(defines.events.on_tick, nil)
    return
  end
  local budget = CHUNKS_PER_TICK
  while budget > 0 do
    if not job.current and not start_surface(job) then
      finish(job)
      return
    end
    local surface = game.get_surface(job.current.index)
    if not (surface and surface.valid) then
      job.current = nil
      job.surface_pos = job.surface_pos + 1
    elseif job.chunk_pos > #job.chunks then
      job.done[#job.done + 1] = job.current
      job.current = nil
      job.surface_pos = job.surface_pos + 1
    else
      local cx, cy = job.chunks[job.chunk_pos], job.chunks[job.chunk_pos + 1]
      job.chunk_pos = job.chunk_pos + 2
      local x0, y0 = cx * 32, cy * 32
      local out = job.current
      local c = out.chunks
      c[#c + 1] = cx
      c[#c + 1] = cy
      c[#c + 1] = tile_runs(job, surface, x0, y0)
      record_entities(job, surface, out, x0, y0)
      budget = budget - 1
    end
  end
end

local function start(player_index)
  if storage.job then
    message(storage.job, "[Map Viewer] An export is already running.")
    return
  end
  local player = player_index and game.get_player(player_index)
  local force = player and player.force or game.forces["player"]
  local indices = {}
  for _, surface in pairs(game.surfaces) do indices[#indices + 1] = surface.index end
  table.sort(indices)
  storage.job = {
    player_index = player_index,
    force_name = force.name,
    surface_indices = indices,
    surface_pos = 1,
    done = {},
    tiles = {}, tile_lookup = {},
    protos = {}, proto_lookup = {},
    recipes = {}, recipe_lookup = {},
  }
  script.on_event(defines.events.on_tick, on_tick)
end

script.on_event("map-viewer-export", function(event) start(event.player_index) end)

commands.add_command("map-export", "Export the map for the Map Viewer website.", function(cmd)
  start(cmd.player_index)
end)

commands.add_command("map-export-clear", "Forget the last Map Viewer export (makes saves smaller).", function(cmd)
  storage.export = nil
  local player = cmd.player_index and game.get_player(cmd.player_index)
  if player then player.print("[Map Viewer] Cleared the stored export.") end
end)

script.on_load(function()
  if storage.job then script.on_event(defines.events.on_tick, on_tick) end
end)
