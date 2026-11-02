#!/usr/bin/env node
// Builds data/nauvis.json from Wube's official prototype files.
//
//   git clone --depth 1 https://github.com/wube/factorio-data .factorio-data
//   npm run extract-data -- .factorio-data
//
// The Lua files are read as text (see lua-tables.mjs); nothing is executed.
import fs from 'node:fs';
import path from 'node:path';
import { readPrototypes } from './lua-tables.mjs';

const root = process.argv[2] ?? '.factorio-data';
const outFile = process.argv[3] ?? 'data/nauvis.json';
const protoDir = path.join(root, 'base', 'prototypes');

const FILES = [
  'item.lua', 'fluid.lua', 'recipe.lua', 'technology.lua',
  'entity/entities.lua', 'entity/mining-drill.lua', 'entity/transport-belts.lua', 'entity/resources.lua',
];

const raw = {};
for (const f of FILES) {
  const src = fs.readFileSync(path.join(protoDir, f), 'utf8');
  for (const p of readPrototypes(src)) {
    // Ingredient/product entries ({type="item", name=..., amount=...}) also have type and name.
    if ('amount' in p || 'amount_min' in p || 'probability' in p) continue;
    const group = (raw[p.type] ??= {});
    if (!group[p.name] || Object.keys(p).length > Object.keys(group[p.name]).length) group[p.name] = p;
  }
}
// Ores are built by a helper function in resources.lua, so their tables have no `type`.
{
  const src = fs.readFileSync(path.join(protoDir, 'entity/resources.lua'), 'utf8');
  for (const p of readPrototypes(src, { untyped: true })) {
    if (!p.type && typeof p.mining_time === 'number' && !raw.resource?.[p.name]) {
      (raw.resource ??= {})[p.name] = {
        type: 'resource', name: p.name, category: p.category ?? 'basic-solid',
        minable: { mining_time: p.mining_time, result: p.name },
      };
    }
  }
}
const version = JSON.parse(fs.readFileSync(path.join(root, 'base', 'info.json'), 'utf8')).version;

// ---------- helpers ----------
const UNITS = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
function energy(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const m = /^([\d.]+)\s*([kKMGT]?)[WJ]$/.exec(v.trim());
  return m ? Number(m[1]) * UNITS[m[2]] : undefined;
}
function displayName(name) {
  const s = name.replace(/-/g, ' ');
  return s[0].toUpperCase() + s.slice(1);
}
const wikiUrl = (name) => 'https://wiki.factorio.com/' + encodeURIComponent(displayName(name).replace(/ /g, '_'));
const round = (x, d = 6) => (x === undefined ? undefined : Math.round(x * 10 ** d) / 10 ** d);
function footprint(p) {
  if (p.tile_width && p.tile_height) return [p.tile_width, p.tile_height];
  const box = p.collision_box;
  if (!Array.isArray(box) || !Array.isArray(box[0])) return [1, 1];
  const w = box[1][0] - box[0][0];
  const h = box[1][1] - box[0][1];
  return [Math.max(1, Math.ceil(w - 0.25)), Math.max(1, Math.ceil(h - 0.25))];
}
const arr = (v) => (Array.isArray(v) ? v : v === undefined ? undefined : typeof v === 'object' ? Object.values(v) : [v]);
function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
function product(r) {
  // Accepts {type,name,amount|amount_min/amount_max,probability} or ["name", n].
  if (Array.isArray(r)) return { name: r[0], type: 'item', amount: r[1] ?? 1 };
  let amount = r.amount ?? ((r.amount_min ?? 0) + (r.amount_max ?? 0)) / 2;
  if (r.extra_count_fraction) amount += r.extra_count_fraction;
  return clean({
    name: r.name, type: r.type === 'fluid' ? 'fluid' : 'item', amount,
    probability: r.probability !== undefined && r.probability !== 1 ? r.probability : undefined,
    temperature: r.temperature,
    ignoredByProductivity: r.ignored_by_productivity || undefined,
  });
}

// ---------- items & fluids ----------
const ITEM_TYPES = ['item', 'module', 'tool', 'capsule', 'ammo', 'gun', 'armor', 'repair-tool',
  'item-with-entity-data', 'rail-planner'];
const items = {};
for (const t of ITEM_TYPES) {
  for (const p of Object.values(raw[t] ?? {})) {
    if (p.parameter || p.subgroup === 'parameters') continue;
    items[p.name] = clean({
      name: p.name, type: 'item', displayName: displayName(p.name), stackSize: p.stack_size,
      hidden: p.hidden || undefined,
      placeResult: typeof p.place_result === 'string' ? p.place_result : undefined,
      fuelValue: energy(p.fuel_value), fuelCategory: p.fuel_value ? (p.fuel_category ?? 'chemical') : undefined,
      subgroup: p.subgroup, order: p.order, icon: p.icon, wikiUrl: wikiUrl(p.name),
    });
  }
}
for (const p of Object.values(raw.fluid ?? {})) {
  if (p.hidden || p.parameter) continue;
  items[p.name] = clean({
    name: p.name, type: 'fluid', displayName: displayName(p.name),
    fuelValue: energy(p.fuel_value), subgroup: p.subgroup ?? 'fluid', order: p.order, icon: p.icon,
    wikiUrl: wikiUrl(p.name),
  });
}

// ---------- recipes ----------
const recipes = {};
for (const p of Object.values(raw.recipe ?? {})) {
  if (p.hidden || p.parameter || p.category === 'parameters') continue;
  const ingredients = (arr(p.ingredients) ?? []).map((i) =>
    Array.isArray(i) ? { name: i[0], type: 'item', amount: i[1] } : { name: i.name, type: i.type === 'fluid' ? 'fluid' : 'item', amount: i.amount });
  const results = (arr(p.results) ?? []).map(product);
  recipes[p.name] = clean({
    name: p.name, displayName: displayName(p.name),
    category: p.category ?? arr(p.categories)?.[0] ?? 'crafting',
    categories: arr(p.categories) ?? [p.category ?? 'crafting'],
    time: p.energy_required ?? 0.5, ingredients, results,
    allowProductivity: !!p.allow_productivity, enabledByDefault: p.enabled !== false,
    subgroup: p.subgroup ?? (results.length === 1 ? items[results[0].name]?.subgroup : undefined),
    order: p.order, maximumProductivity: p.maximum_productivity,
  });
}

// ---------- entities ----------
const placedBy = {};
for (const it of Object.values(items)) if (it.placeResult) placedBy[it.placeResult] ??= it.name;

const KIND_BY_TYPE = {
  furnace: 'furnace', 'mining-drill': 'mining-drill', 'offshore-pump': 'offshore-pump', pump: 'pump',
  boiler: 'boiler', generator: 'generator', 'solar-panel': 'solar-panel', accumulator: 'accumulator',
  reactor: 'reactor', beacon: 'beacon', 'transport-belt': 'belt', 'underground-belt': 'underground-belt',
  splitter: 'splitter', inserter: 'inserter', pipe: 'pipe', 'pipe-to-ground': 'pipe-to-ground',
  'storage-tank': 'storage-tank', 'electric-pole': 'pole', container: 'chest', 'logistic-container': 'chest',
  lab: 'lab', 'rocket-silo': 'rocket-silo', 'assembling-machine': 'assembler',
};
function kindOf(p) {
  if (p.type === 'assembling-machine') {
    if (p.name === 'chemical-plant') return 'chemical-plant';
    if (p.name === 'oil-refinery') return 'refinery';
    if (p.name === 'centrifuge') return 'centrifuge';
    return 'assembler';
  }
  if (p.type === 'boiler' && p.name === 'heat-exchanger') return 'heat-exchanger';
  if (p.type === 'generator' && p.name === 'steam-turbine') return 'steam-turbine';
  return KIND_BY_TYPE[p.type];
}
const CRAFTERS = new Set(['assembling-machine', 'furnace', 'rocket-silo']);

const entities = {};
for (const [type, group] of Object.entries(raw)) {
  for (const p of Object.values(group)) {
    const kind = kindOf(p);
    const item = placedBy[p.name];
    if (!kind || !item || p.hidden) continue;
    const [width, height] = footprint(p);
    const es = p.energy_source ?? {};
    const energySource = es.type;
    let energyUsage = energy(p.energy_usage ?? p.energy_consumption ?? p.consumption);
    let drain = energy(es.drain);
    if (drain === undefined && energySource === 'electric' && CRAFTERS.has(type) && energyUsage) drain = energyUsage / 30;
    const e = {
      name: p.name, displayName: displayName(p.name), prototype: type, kind, width, height, item,
      icon: p.icon, wikiUrl: wikiUrl(p.name),
      energySource, energyUsage, drain: drain ? round(drain) : undefined,
      effectivity: es.effectivity !== undefined && es.effectivity !== 1 ? es.effectivity : undefined,
      moduleSlots: p.module_slots || undefined,
      // Prototypes that omit allowed_effects accept every effect.
      allowedEffects: p.module_slots ? (arr(p.allowed_effects) ?? ['consumption', 'speed', 'productivity', 'pollution']) : undefined,
    };
    if (CRAFTERS.has(type)) {
      e.craftingSpeed = p.crafting_speed;
      e.categories = arr(p.crafting_categories);
      if (p.effect_receiver?.base_effect?.productivity) e.baseProductivity = p.effect_receiver.base_effect.productivity;
      if (type === 'rocket-silo') { e.energyUsage = energy(p.active_energy_usage) ?? e.energyUsage; e.drain = undefined; }
    }
    switch (type) {
      case 'mining-drill':
        e.miningSpeed = p.mining_speed;
        e.categories = arr(p.resource_categories);
        e.miningArea = Math.round((p.resource_searching_radius ?? 0) * 2);
        break;
      case 'offshore-pump':
        e.pumpingSpeed = round(p.pumping_speed * 60);
        e.fluid = 'water';
        break;
      case 'pump':
        e.pumpingSpeed = round(p.pumping_speed * 60);
        break;
      case 'boiler':
        e.temperature = p.target_temperature;
        break;
      case 'generator': {
        e.fluidUsage = round(p.fluid_usage_per_tick * 60);
        e.temperature = p.maximum_temperature;
        // Steam heat capacity is 200 J/unit/°C from 15 °C.
        e.powerOutput = round(e.fluidUsage * (p.maximum_temperature - 15) * 200 * (p.effectivity ?? 1));
        break;
      }
      case 'solar-panel':
        e.powerOutput = energy(p.production);
        break;
      case 'reactor':
        e.powerOutput = energy(p.consumption);
        break;
      case 'beacon':
        e.distributionEffectivity = p.distribution_effectivity;
        e.profile = arr(p.profile);
        e.supplyAreaDistance = p.supply_area_distance;
        e.allowedEffects = arr(p.allowed_effects);
        break;
      case 'transport-belt': case 'underground-belt': case 'splitter':
        e.beltThroughput = round(p.speed * 480, 4);
        if (p.max_distance) e.maxDistance = p.max_distance;
        break;
      case 'inserter':
        e.rotationSpeed = p.rotation_speed;
        if (p.bulk) e.inserterStackSize = 'bulk';
        break;
      case 'pipe-to-ground': {
        const conns = arr(p.fluid_box?.pipe_connections) ?? [];
        e.maxDistance = conns.map((c) => c.max_underground_distance).find((x) => x) ?? undefined;
        break;
      }
      case 'storage-tank':
        e.fluidCapacity = p.fluid_box?.volume;
        break;
      case 'electric-pole':
        e.supplyAreaDistance = p.supply_area_distance;
        e.wireReach = p.maximum_wire_distance;
        break;
      case 'container': case 'logistic-container':
        e.inventorySize = p.inventory_size;
        break;
      case 'lab':
        e.researchingSpeed = p.researching_speed ?? 1;
        e.inputs = arr(p.inputs);
        break;
    }
    if (e.inserterStackSize === 'bulk') { delete e.inserterStackSize; e.bulk = true; }
    entities[p.name] = clean(e);
  }
}

// ---------- modules ----------
const modules = {};
for (const p of Object.values(raw.module ?? {})) {
  modules[p.name] = clean({
    name: p.name, displayName: displayName(p.name), category: p.category, tier: p.tier,
    effect: clean({ ...p.effect }), limitation: arr(p.limitation),
  });
}

// ---------- technologies ----------
const RATE_EFFECTS = new Set(['mining-drill-productivity-bonus', 'change-recipe-productivity', 'laboratory-speed',
  'laboratory-productivity', 'inserter-stack-size-bonus', 'bulk-inserter-capacity-bonus', 'belt-stack-size-bonus']);
const technologies = {};
for (const p of Object.values(raw.technology ?? {})) {
  if (p.hidden) continue;
  const effects = (arr(p.effects) ?? []).map((ef) => {
    if (ef.type === 'unlock-recipe') return { type: 'unlock-recipe', recipe: ef.recipe };
    if (ef.type === 'change-recipe-productivity') return { type: ef.type, recipe: ef.recipe, modifier: ef.change };
    if (RATE_EFFECTS.has(ef.type)) return { type: ef.type, modifier: ef.modifier };
    return clean({ type: 'other', name: ef.type, modifier: typeof ef.modifier === 'number' ? ef.modifier : undefined });
  });
  const u = p.unit;
  technologies[p.name] = clean({
    name: p.name, displayName: displayName(p.name), prerequisites: arr(p.prerequisites) ?? [], effects,
    unlocksRecipes: effects.filter((x) => x.type === 'unlock-recipe').map((x) => x.recipe),
    maxLevel: p.max_level, icon: p.icon, wikiUrl: wikiUrl(p.name.replace(/-\d+$/, '')),
    cost: u ? clean({ count: u.count, countFormula: u.count_formula, time: u.time,
      ingredients: (arr(u.ingredients) ?? []).map((i) => ({ name: i[0], type: 'item', amount: i[1] })) }) : undefined,
    affectsRates: effects.some((x) => RATE_EFFECTS.has(x.type)),
  });
}

// ---------- resources ----------
const resources = {};
for (const p of Object.values(raw.resource ?? {})) {
  const m = p.minable ?? {};
  const results = m.results ? arr(m.results).map(product) : [{ name: m.result, type: 'item', amount: m.count ?? 1 }];
  resources[p.name] = clean({
    name: p.name, displayName: displayName(p.name), category: p.category ?? 'basic-solid', miningTime: m.mining_time,
    results, requiredFluid: m.required_fluid, fluidAmount: m.fluid_amount, infinite: !!p.infinite,
  });
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const out = { version, items: sortKeys(items), recipes: sortKeys(recipes), entities: sortKeys(entities),
  modules: sortKeys(modules), technologies: sortKeys(technologies), resources: sortKeys(resources) };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
console.log(`Factorio ${version}: ${Object.keys(items).length} items/fluids, ${Object.keys(recipes).length} recipes, `
  + `${Object.keys(entities).length} buildings, ${Object.keys(modules).length} modules, `
  + `${Object.keys(technologies).length} technologies, ${Object.keys(resources).length} resources -> ${outFile}`);
