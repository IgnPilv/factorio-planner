-- Icon paths are not readable at runtime, so collect them here (after every
-- other mod has run) and hand them to control.lua through a mod-data prototype.
-- Shape: icons[prototype type][prototype name] = "__mod__/graphics/....png"

local icons = {}
for type_name, protos in pairs(data.raw) do
  if type(protos) == "table" then
    local by_name
    for name, proto in pairs(protos) do
      if type(proto) == "table" then
        local path = proto.icon
        if not path and type(proto.icons) == "table" and type(proto.icons[1]) == "table" then
          path = proto.icons[1].icon
        end
        if type(path) == "string" then
          by_name = by_name or {}
          by_name[name] = path
        end
      end
    end
    if by_name then icons[type_name] = by_name end
  end
end

data:extend({
  {
    type = "mod-data",
    name = "map-viewer-export-icons",
    data = icons,
  },
})
