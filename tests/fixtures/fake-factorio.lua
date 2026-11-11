-- A tiny stand-in for the Factorio runtime API, enough to run the mod's
-- control.lua in tests. Only what the mod uses is faked.

local fake = { handlers = {}, commands = {}, printed = {}, files = {} }

local function json(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then
    if v == math.floor(v) then return string.format("%d", v) end
    return string.format("%.17g", v)
  end
  if t == "string" then
    return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
  end
  if t == "table" then
    local n = #v
    local count = 0
    for _ in pairs(v) do count = count + 1 end
    if count == 0 then return "{}" end
    local out = {}
    if n == count then
      for i = 1, n do out[i] = json(v[i]) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    for _, k in ipairs(keys) do out[#out + 1] = json(k) .. ":" .. json(v[k] ~= nil and v[k] or v[tonumber(k)]) end
    return "{" .. table.concat(out, ",") .. "}"
  end
  error("cannot encode " .. t)
end
fake.json = json

defines = { events = { on_tick = 0 }, direction = { north = 0, east = 4, south = 8, west = 12 } }
storage = {}

script = {
  active_mods = { base = "2.1.24", ["space-age"] = "2.1.24", ["map-viewer-export"] = "0.1.0" },
  on_event = function(event, fn) fake.handlers[event] = fn end,
  on_load = function(fn) fake.on_load = fn end,
}
commands = { add_command = function(name, _, fn) fake.commands[name] = fn end }
helpers = {
  table_to_json = json,
  encode_string = function(s) return js_encode(s) end,
  write_file = function(name, data, append, player) fake.files[name] = { data = data, player = player } end,
}

local function proto_entity(name, type, w, h, color)
  return { name = name, type = type, tile_width = w, tile_height = h, map_color = color,
           friendly_map_color = { r = 0, g = 0.5, b = 1 }, enemy_map_color = { r = 1, g = 0, b = 0 },
           items_to_place_this = { { name = name, count = 1 } } }
end

prototypes = {
  entity = {
    ["assembling-machine-2"] = proto_entity("assembling-machine-2", "assembling-machine", 3, 3, nil),
    ["transport-belt"] = proto_entity("transport-belt", "transport-belt", 1, 1, { r = 0.8, g = 0.7, b = 0 }),
    ["tree-01"] = proto_entity("tree-01", "tree", 1, 1, { r = 0.1, g = 0.4, b = 0.1 }),
    ["biter-spawner"] = proto_entity("biter-spawner", "unit-spawner", 5, 5, nil),
    ["character"] = proto_entity("character", "character", 1, 1, nil),
    ["space-platform-hub"] = proto_entity("space-platform-hub", "space-platform-hub", 8, 8, nil),
    ["locomotive"] = proto_entity("locomotive", "locomotive", 2, 6, nil),
  },
  tile = {
    ["grass-1"] = { name = "grass-1", map_color = { r = 55, g = 83, b = 22, a = 255 } },
    ["water"] = { name = "water", map_color = { r = 51, g = 83, b = 95, a = 255 } },
    ["space-platform-foundation"] = { name = "space-platform-foundation", map_color = { r = 80, g = 80, b = 90 } },
    ["empty-space"] = { name = "empty-space", map_color = { r = 0, g = 0, b = 0 } },
  },
  item = {
    ["assembling-machine-2"] = { name = "assembling-machine-2", type = "item" },
    ["transport-belt"] = { name = "transport-belt", type = "item" },
    ["iron-gear-wheel"] = { name = "iron-gear-wheel", type = "item" },
  },
  recipe = {
    ["iron-gear-wheel"] = { name = "iron-gear-wheel", main_product = { type = "item", name = "iron-gear-wheel" } },
  },
  mod_data = {},
}

local function make_force(index, name, charted)
  return {
    index = index, name = name, valid = true,
    is_chunk_charted = function(surface, pos)
      return charted[surface.name] and charted[surface.name][pos[1] .. "," .. pos[2]] or false
    end,
  }
end

-- surface spec: { name, index, planet, platform, chunks = { {x,y}, ... }, tile = function(x,y) -> name, entities = {...} }
local function make_surface(spec)
  local s = { name = spec.name, index = spec.index, valid = true }
  s.planet = spec.planet and { name = spec.planet } or nil
  s.platform = spec.platform and { name = spec.platform } or nil
  s.get_chunks = function()
    local i = 0
    return function()
      i = i + 1
      local c = spec.chunks[i]
      if not c then return nil end
      return { x = c[1], y = c[2], area = { left_top = { x = c[1] * 32, y = c[2] * 32 }, right_bottom = { x = c[1] * 32 + 32, y = c[2] * 32 + 32 } } }
    end
  end
  s.get_tile = function(x, y) return { name = spec.tile(x, y) } end
  s.count_tiles_filtered = function(f)
    local a = f.area
    local n = 0
    for y = a[1][2], a[2][2] - 1 do
      for x = a[1][1], a[2][1] - 1 do
        if not f.name or spec.tile(x, y) == f.name then n = n + 1 end
      end
    end
    return n
  end
  s.find_entities_filtered = function(f)
    local a = f.area
    local out = {}
    for _, e in ipairs(spec.entities) do
      local p = prototypes.entity[e.name]
      local hw, hh = p.tile_width / 2, p.tile_height / 2
      if e.position.x + hw > a[1][1] and e.position.x - hw < a[2][1] and e.position.y + hh > a[1][2] and e.position.y - hh < a[2][2] then
        out[#out + 1] = e
      end
    end
    return out
  end
  return s
end

function fake.entity(name, x, y, opts)
  opts = opts or {}
  local p = prototypes.entity[name]
  return {
    name = name, type = p.type, position = { x = x, y = y }, direction = opts.direction or 0,
    orientation = opts.orientation or 0, force_index = opts.force or 1,
    get_recipe = function() if opts.recipe then return { name = opts.recipe }, nil end return nil end,
  }
end

function fake.setup(surfaces, charted)
  local list, by_index = {}, {}
  for _, spec in ipairs(surfaces) do
    local s = make_surface(spec)
    list[s.name] = s
    by_index[s.index] = s
  end
  local forces = {
    player = make_force(1, "player", charted),
    enemy = make_force(2, "enemy", {}),
    neutral = make_force(3, "neutral", {}),
  }
  local player = { index = 1, valid = true, force = forces.player, print = function(m) fake.printed[#fake.printed + 1] = m end }
  game = {
    tick = 1000,
    surfaces = list,
    forces = forces,
    get_surface = function(i) return by_index[i] end,
    get_player = function(i) if i == 1 then return player end end,
    print = function(m) fake.printed[#fake.printed + 1] = m end,
  }
end

function fake.run_ticks(max)
  for _ = 1, max do
    local h = fake.handlers[defines.events.on_tick]
    if not h then return end
    game.tick = game.tick + 1
    h({ tick = game.tick })
  end
end

return fake
