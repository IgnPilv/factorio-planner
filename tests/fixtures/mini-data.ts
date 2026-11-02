// A small hand-written slice of Factorio 2.0 base data with real numbers, so the
// engine can be tested before (and independently of) the extracted data file.
import type { Entity, GameData, Item, Module, Recipe, Resource, Technology } from '../../src/data/types';

const wiki = (n: string) => `https://wiki.factorio.com/${n}`;

function item(name: string, extra: Partial<Item> = {}): Item {
  return { name, type: 'item', displayName: name, wikiUrl: wiki(name), ...extra };
}
function fluid(name: string): Item {
  return { name, type: 'fluid', displayName: name, wikiUrl: wiki(name) };
}
function recipe(
  name: string,
  category: string,
  time: number,
  ingredients: [string, number, ('item' | 'fluid')?][],
  results: [string, number, ('item' | 'fluid')?][],
  extra: Partial<Recipe> = {},
): Recipe {
  return {
    name,
    displayName: name,
    category,
    time,
    ingredients: ingredients.map(([n, a, t]) => ({ name: n, amount: a, type: t ?? 'item' })),
    results: results.map(([n, a, t]) => ({ name: n, amount: a, type: t ?? 'item' })),
    allowProductivity: true,
    enabledByDefault: true,
    ...extra,
  };
}
function entity(name: string, kind: Entity['kind'], extra: Partial<Entity>): Entity {
  return { name, displayName: name, prototype: kind, kind, width: 3, height: 3, item: name, wikiUrl: wiki(name), ...extra };
}
function mod(name: string, category: string, tier: number, effect: Module['effect']): Module {
  return { name, displayName: name, category, tier, effect };
}
function tech(name: string, effects: Technology['effects'], extra: Partial<Technology> = {}): Technology {
  const unlocks = effects.flatMap((e) => (e.type === 'unlock-recipe' ? [e.recipe] : []));
  return {
    name,
    displayName: name,
    prerequisites: [],
    effects,
    unlocksRecipes: unlocks,
    affectsRates: effects.some((e) => e.type !== 'unlock-recipe'),
    wikiUrl: wiki(name),
    ...extra,
  };
}

const crafting = ['crafting', 'basic-crafting', 'advanced-crafting'];
const allEffects: Entity['allowedEffects'] = ['speed', 'productivity', 'consumption', 'pollution', 'quality'];

const items: Item[] = [
  item('iron-ore'),
  item('copper-ore'),
  item('coal', { fuelValue: 4e6, fuelCategory: 'chemical' }),
  item('stone'),
  item('iron-plate'),
  item('copper-plate'),
  item('steel-plate'),
  item('copper-cable'),
  item('iron-gear-wheel'),
  item('electronic-circuit'),
  item('automation-science-pack'),
  item('plastic-bar'),
  fluid('water'),
  fluid('steam'),
  fluid('crude-oil'),
  fluid('heavy-oil'),
  fluid('light-oil'),
  fluid('petroleum-gas'),
];

const recipes: Recipe[] = [
  recipe('iron-plate', 'smelting', 3.2, [['iron-ore', 1]], [['iron-plate', 1]]),
  recipe('copper-plate', 'smelting', 3.2, [['copper-ore', 1]], [['copper-plate', 1]]),
  recipe('steel-plate', 'smelting', 16, [['iron-plate', 5]], [['steel-plate', 1]], { enabledByDefault: false }),
  recipe('copper-cable', 'crafting', 0.5, [['copper-plate', 1]], [['copper-cable', 2]]),
  recipe('iron-gear-wheel', 'crafting', 0.5, [['iron-plate', 2]], [['iron-gear-wheel', 1]]),
  recipe('electronic-circuit', 'crafting', 0.5, [['iron-plate', 1], ['copper-cable', 3]], [['electronic-circuit', 1]]),
  recipe('automation-science-pack', 'crafting', 5, [['copper-plate', 1], ['iron-gear-wheel', 1]], [['automation-science-pack', 1]]),
  recipe(
    'advanced-oil-processing',
    'oil-processing',
    5,
    [['crude-oil', 100, 'fluid'], ['water', 50, 'fluid']],
    [['heavy-oil', 25, 'fluid'], ['light-oil', 45, 'fluid'], ['petroleum-gas', 55, 'fluid']],
    { enabledByDefault: false },
  ),
  recipe('heavy-oil-cracking', 'chemistry', 2, [['water', 30, 'fluid'], ['heavy-oil', 40, 'fluid']], [['light-oil', 30, 'fluid']], { enabledByDefault: false }),
  recipe('light-oil-cracking', 'chemistry', 2, [['water', 30, 'fluid'], ['light-oil', 30, 'fluid']], [['petroleum-gas', 20, 'fluid']], { enabledByDefault: false }),
  recipe('plastic-bar', 'chemistry', 1, [['petroleum-gas', 20, 'fluid'], ['coal', 1]], [['plastic-bar', 2]], { enabledByDefault: false }),
  // Buildings, so research can gate them.
  recipe('assembling-machine-1', 'crafting', 0.5, [['iron-plate', 9]], [['assembling-machine-1', 1]], { allowProductivity: false }),
  recipe('assembling-machine-2', 'crafting', 0.5, [['iron-plate', 20]], [['assembling-machine-2', 1]], { enabledByDefault: false, allowProductivity: false }),
  recipe('assembling-machine-3', 'crafting', 0.5, [['iron-plate', 20]], [['assembling-machine-3', 1]], { enabledByDefault: false, allowProductivity: false }),
  recipe('electric-furnace', 'crafting', 5, [['steel-plate', 10]], [['electric-furnace', 1]], { enabledByDefault: false, allowProductivity: false }),
  recipe('beacon', 'crafting', 15, [['electronic-circuit', 20]], [['beacon', 1]], { enabledByDefault: false, allowProductivity: false }),
];

const entities: Entity[] = [
  entity('assembling-machine-1', 'assembler', { craftingSpeed: 0.5, categories: crafting, moduleSlots: 0, energySource: 'electric', energyUsage: 75e3, drain: 2.5e3, allowedEffects: allEffects }),
  entity('assembling-machine-2', 'assembler', { craftingSpeed: 0.75, categories: [...crafting, 'crafting-with-fluid'], moduleSlots: 2, energySource: 'electric', energyUsage: 150e3, drain: 5e3, allowedEffects: allEffects }),
  entity('assembling-machine-3', 'assembler', { craftingSpeed: 1.25, categories: [...crafting, 'crafting-with-fluid'], moduleSlots: 4, energySource: 'electric', energyUsage: 375e3, drain: 12.5e3, allowedEffects: allEffects }),
  entity('stone-furnace', 'furnace', { width: 2, height: 2, craftingSpeed: 1, categories: ['smelting'], moduleSlots: 0, energySource: 'burner', energyUsage: 90e3, effectivity: 1 }),
  entity('electric-furnace', 'furnace', { craftingSpeed: 2, categories: ['smelting'], moduleSlots: 2, energySource: 'electric', energyUsage: 180e3, drain: 6e3, allowedEffects: allEffects }),
  entity('chemical-plant', 'chemical-plant', { craftingSpeed: 1, categories: ['chemistry'], moduleSlots: 3, energySource: 'electric', energyUsage: 210e3, drain: 7e3, allowedEffects: allEffects }),
  entity('oil-refinery', 'refinery', { width: 5, height: 5, craftingSpeed: 1, categories: ['oil-processing'], moduleSlots: 3, energySource: 'electric', energyUsage: 420e3, drain: 14e3, allowedEffects: allEffects }),
  entity('electric-mining-drill', 'mining-drill', { miningSpeed: 0.5, categories: ['basic-solid'], moduleSlots: 3, energySource: 'electric', energyUsage: 90e3, allowedEffects: allEffects }),
  entity('pumpjack', 'mining-drill', { miningSpeed: 1, categories: ['basic-fluid'], moduleSlots: 2, energySource: 'electric', energyUsage: 90e3, allowedEffects: allEffects }),
  entity('offshore-pump', 'offshore-pump', { width: 1, height: 2, pumpingSpeed: 1200, fluid: 'water', energySource: 'void' }),
  entity('boiler', 'boiler', { width: 3, height: 2, energySource: 'burner', energyUsage: 1.8e6, effectivity: 1, temperature: 165 }),
  entity('steam-engine', 'generator', { width: 3, height: 5, powerOutput: 900e3, fluidUsage: 30, temperature: 165 }),
  entity('beacon', 'beacon', {
    moduleSlots: 2,
    energySource: 'electric',
    energyUsage: 480e3,
    distributionEffectivity: 1.5,
    supplyAreaDistance: 3,
    allowedEffects: ['speed', 'consumption', 'pollution'],
  }),
  entity('lab', 'lab', { craftingSpeed: 1, researchingSpeed: 1, moduleSlots: 2, energySource: 'electric', energyUsage: 60e3, allowedEffects: allEffects }),
];

const modules: Module[] = [
  mod('speed-module', 'speed', 1, { speed: 0.2, consumption: 0.5, quality: -0.1 }),
  mod('speed-module-3', 'speed', 3, { speed: 0.5, consumption: 0.7, quality: -0.25 }),
  mod('productivity-module', 'productivity', 1, { productivity: 0.04, consumption: 0.4, pollution: 0.05, speed: -0.05 }),
  mod('productivity-module-3', 'productivity', 3, { productivity: 0.1, consumption: 0.8, pollution: 0.1, speed: -0.15 }),
  mod('efficiency-module', 'efficiency', 1, { consumption: -0.3 }),
  mod('efficiency-module-3', 'efficiency', 3, { consumption: -0.5 }),
];

const resources: Resource[] = [
  { name: 'iron-ore', displayName: 'Iron ore', category: 'basic-solid', miningTime: 1, results: [{ name: 'iron-ore', type: 'item', amount: 1 }], infinite: false },
  { name: 'copper-ore', displayName: 'Copper ore', category: 'basic-solid', miningTime: 1, results: [{ name: 'copper-ore', type: 'item', amount: 1 }], infinite: false },
  { name: 'coal', displayName: 'Coal', category: 'basic-solid', miningTime: 1, results: [{ name: 'coal', type: 'item', amount: 1 }], infinite: false },
  { name: 'crude-oil', displayName: 'Crude oil', category: 'basic-fluid', miningTime: 1, results: [{ name: 'crude-oil', type: 'fluid', amount: 10 }], infinite: true },
];

const technologies: Technology[] = [
  tech('automation-2', [{ type: 'unlock-recipe', recipe: 'assembling-machine-2' }]),
  tech('automation-3', [{ type: 'unlock-recipe', recipe: 'assembling-machine-3' }]),
  tech('steel-processing', [{ type: 'unlock-recipe', recipe: 'steel-plate' }]),
  tech('advanced-material-processing-2', [{ type: 'unlock-recipe', recipe: 'electric-furnace' }]),
  tech('advanced-oil-processing', [
    { type: 'unlock-recipe', recipe: 'advanced-oil-processing' },
    { type: 'unlock-recipe', recipe: 'heavy-oil-cracking' },
    { type: 'unlock-recipe', recipe: 'light-oil-cracking' },
  ]),
  tech('plastics', [{ type: 'unlock-recipe', recipe: 'plastic-bar' }]),
  tech('effect-transmission', [{ type: 'unlock-recipe', recipe: 'beacon' }]),
  tech('mining-productivity-1', [{ type: 'mining-drill-productivity-bonus', modifier: 0.1 }]),
  tech('mining-productivity-3', [{ type: 'mining-drill-productivity-bonus', modifier: 0.1 }], { maxLevel: 'infinite' }),
  tech('steel-plate-productivity', [{ type: 'change-recipe-productivity', recipe: 'steel-plate', modifier: 0.1 }], { maxLevel: 'infinite' }),
];

const byName = <T extends { name: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.name, x]));

export const miniData: GameData = {
  version: 'test-2.0',
  items: byName(items),
  recipes: byName(recipes),
  entities: byName(entities),
  modules: byName(modules),
  technologies: byName(technologies),
  resources: byName(resources),
};
