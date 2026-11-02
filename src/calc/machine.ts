import type { Entity, GameData, Recipe, Resource } from '../data/types';
import {
  addEffects,
  beaconEffects,
  clampEffects,
  DEFAULT_MAX_PRODUCTIVITY,
  moduleEffects,
  type BeaconInfluence,
  type EffectTotals,
} from './effects';
import { researchBonuses, type ResearchBonuses, type ResearchState } from './research';
import type { Flow } from './flow';

/** Pseudo-item used for electric power in flows and the solver, measured in watts (J/s). */
export const ELECTRICITY = 'electricity';

/** Water heat capacity: 200 J per unit per °C. Water enters boilers at 15 °C. */
export const FLUID_HEAT_CAPACITY = 200;
export const WATER_START_TEMPERATURE = 15;
/** Nauvis solar output averaged over a day, as a fraction of peak. */
export const SOLAR_AVERAGE = 0.7;

export interface MachineSetup {
  /** Entity prototype name, e.g. "assembling-machine-2". */
  entity: string;
  /** Recipe for crafting machines; for drills the resource name. */
  recipe?: string;
  modules?: string[];
  beacons?: BeaconInfluence[];
}

/** Steady-state rates of one machine running at 100%. */
export interface EntityRate {
  /** Crafts (or mining operations) per second. */
  craftsPerSecond: number;
  speedBonus: number;
  productivityBonus: number;
  consumptionBonus: number;
  pollutionBonus: number;
  /** Net electric draw in W (negative for generators). */
  powerW: number;
  /** Fuel energy burned per second in W (burner machines and boilers). */
  fuelW: number;
  inputs: Flow[];
  outputs: Flow[];
  /** Number of beacons affecting this machine. */
  beacons: number;
  warnings: string[];
}

function emptyRate(warnings: string[] = []): EntityRate {
  return {
    craftsPerSecond: 0,
    speedBonus: 0,
    productivityBonus: 0,
    consumptionBonus: 0,
    pollutionBonus: 0,
    powerW: 0,
    fuelW: 0,
    inputs: [],
    outputs: [],
    beacons: 0,
    warnings,
  };
}

/** Power use for an active machine: base × (1 + consumption) plus drain for electric machines. */
function powerFor(entity: Entity, consumption: number): { powerW: number; fuelW: number } {
  const active = (entity.energyUsage ?? 0) * (1 + consumption);
  switch (entity.energySource) {
    case 'electric':
      return { powerW: active + (entity.drain ?? 0), fuelW: 0 };
    case 'burner':
      return { powerW: 0, fuelW: active / (entity.effectivity ?? 1) };
    default:
      return { powerW: 0, fuelW: 0 };
  }
}

/** Effects of modules + beacons on a machine, clamped to game limits. */
export function machineEffects(
  data: GameData,
  entity: Entity,
  recipe: Recipe | undefined,
  modules: readonly string[],
  beacons: readonly BeaconInfluence[],
  extraProductivity: number,
  warnings: string[],
): EffectTotals {
  const slots = entity.moduleSlots ?? 0;
  if (modules.length > slots) {
    warnings.push(`${entity.name} has ${slots} module slots, ${modules.length} modules given`);
  }
  const used = modules.slice(0, slots);
  let e = moduleEffects(data, used, entity, recipe, warnings);
  e = addEffects(e, beaconEffects(data, beacons, entity, recipe, warnings));
  const canProd = !recipe || recipe.allowProductivity;
  e = { ...e, productivity: (canProd ? e.productivity + extraProductivity : 0) + (entity.baseProductivity ?? 0) };
  const max = recipe?.maximumProductivity ?? DEFAULT_MAX_PRODUCTIVITY;
  return clampEffects(e, max);
}

function scaleProducts(
  products: { name: string; amount: number; probability?: number; ignoredByProductivity?: number }[],
  crafts: number,
  productivity: number,
): Flow[] {
  return products.map((p) => {
    const base = p.amount * (p.probability ?? 1);
    const ignored = Math.min(p.ignoredByProductivity ?? 0, p.amount) * (p.probability ?? 1);
    const amount = ignored + (base - ignored) * (1 + productivity);
    return { name: p.name, perSecond: crafts * amount };
  });
}

/**
 * Rate of one machine at full speed. Handles crafting machines and furnaces,
 * mining drills (recipe = resource name), offshore pumps, boilers, generators,
 * labs, beacons and solar panels.
 */
export function machineRate(
  data: GameData,
  setup: MachineSetup,
  research: ResearchState | ResearchBonuses = {},
): EntityRate {
  const bonuses = 'unlockedRecipes' in research ? (research as ResearchBonuses) : researchBonuses(data, research);
  const warnings: string[] = [];
  const entity = data.entities[setup.entity];
  if (!entity) return emptyRate([`Unknown entity ${setup.entity}`]);
  const modules = setup.modules ?? [];
  const beacons = setup.beacons ?? [];

  switch (entity.kind) {
    case 'assembler':
    case 'furnace':
    case 'chemical-plant':
    case 'refinery':
    case 'centrifuge':
    case 'rocket-silo':
      return craftingRate(data, entity, setup, bonuses, modules, beacons, warnings);
    case 'mining-drill':
      return miningRate(data, entity, setup, bonuses, modules, beacons, warnings);
    case 'offshore-pump': {
      const rate = emptyRate(warnings);
      const fluid = entity.fluid ?? 'water';
      const speed = entity.pumpingSpeed ?? 0;
      rate.craftsPerSecond = speed;
      rate.outputs = [{ name: fluid, perSecond: speed }];
      Object.assign(rate, powerFor(entity, 0));
      return rate;
    }
    case 'boiler': {
      const rate = emptyRate(warnings);
      const out = boilerSteamPerSecond(entity);
      rate.craftsPerSecond = out;
      rate.inputs = [{ name: 'water', perSecond: out }];
      rate.outputs = [{ name: 'steam', perSecond: out }];
      rate.fuelW = (entity.energyUsage ?? 0) / (entity.effectivity ?? 1);
      if (entity.energySource === 'electric') {
        rate.powerW = rate.fuelW;
        rate.fuelW = 0;
      }
      return rate;
    }
    case 'generator':
    case 'steam-turbine': {
      const rate = emptyRate(warnings);
      const usage = entity.fluidUsage ?? 0;
      rate.craftsPerSecond = usage;
      rate.inputs = usage > 0 ? [{ name: 'steam', perSecond: usage }] : [];
      rate.powerW = -(entity.powerOutput ?? entity.energyUsage ?? 0);
      rate.outputs = [{ name: ELECTRICITY, perSecond: -rate.powerW }];
      return rate;
    }
    case 'solar-panel': {
      const rate = emptyRate(warnings);
      rate.powerW = -(entity.powerOutput ?? 0) * SOLAR_AVERAGE;
      rate.outputs = [{ name: ELECTRICITY, perSecond: -rate.powerW }];
      return rate;
    }
    case 'lab': {
      const rate = emptyRate(warnings);
      const e = machineEffects(data, entity, undefined, modules, beacons, bonuses.labProductivity, warnings);
      rate.speedBonus = e.speed + bonuses.labSpeed;
      rate.productivityBonus = e.productivity;
      rate.consumptionBonus = e.consumption;
      rate.pollutionBonus = e.pollution;
      rate.beacons = beacons.length;
      Object.assign(rate, powerFor(entity, e.consumption));
      return rate;
    }
    case 'beacon': {
      const rate = emptyRate(warnings);
      Object.assign(rate, powerFor(entity, 0));
      return rate;
    }
    default: {
      // Belts, inserters, pipes, poles, chests: only power (inserters) matters here.
      const rate = emptyRate(warnings);
      if (entity.energySource === 'electric' && entity.drain) rate.powerW = entity.drain;
      return rate;
    }
  }
}

/** Machine categories a recipe can be crafted in (2.1 allows several). */
export function recipeCategories(recipe: Recipe): string[] {
  return recipe.categories?.length ? recipe.categories : [recipe.category];
}

/** Steam units per second a boiler makes at full fuel use. */
export function boilerSteamPerSecond(entity: Entity): number {
  const target = entity.temperature ?? 165;
  const perUnit = (target - WATER_START_TEMPERATURE) * FLUID_HEAT_CAPACITY;
  return ((entity.energyUsage ?? 0) * (entity.effectivity ?? 1)) / perUnit;
}

function craftingRate(
  data: GameData,
  entity: Entity,
  setup: MachineSetup,
  bonuses: ResearchBonuses,
  modules: readonly string[],
  beacons: readonly BeaconInfluence[],
  warnings: string[],
): EntityRate {
  const rate = emptyRate(warnings);
  rate.beacons = beacons.length;
  const recipe = setup.recipe ? data.recipes[setup.recipe] : undefined;
  if (!recipe) {
    if (setup.recipe) warnings.push(`Unknown recipe ${setup.recipe}`);
    // An idle machine still draws its drain.
    if (entity.energySource === 'electric') rate.powerW = entity.drain ?? 0;
    return rate;
  }
  if (entity.categories && !recipeCategories(recipe).some((c) => entity.categories!.includes(c))) {
    warnings.push(`${entity.name} can't craft ${recipe.name} (category ${recipe.category})`);
  }
  if (!bonuses.unlockedRecipes.has(recipe.name)) {
    warnings.push(`${recipe.name} is not researched`);
  }
  const extraProd = bonuses.recipeProductivity[recipe.name] ?? 0;
  const e = machineEffects(data, entity, recipe, modules, beacons, extraProd, warnings);
  const crafts = ((entity.craftingSpeed ?? 1) * (1 + e.speed)) / recipe.time;
  rate.craftsPerSecond = crafts;
  rate.speedBonus = e.speed;
  rate.productivityBonus = e.productivity;
  rate.consumptionBonus = e.consumption;
  rate.pollutionBonus = e.pollution;
  rate.inputs = recipe.ingredients.map((i) => ({ name: i.name, perSecond: crafts * i.amount }));
  rate.outputs = scaleProducts(recipe.results, crafts, e.productivity);
  Object.assign(rate, powerFor(entity, e.consumption));
  return rate;
}

function miningRate(
  data: GameData,
  entity: Entity,
  setup: MachineSetup,
  bonuses: ResearchBonuses,
  modules: readonly string[],
  beacons: readonly BeaconInfluence[],
  warnings: string[],
): EntityRate {
  const rate = emptyRate(warnings);
  rate.beacons = beacons.length;
  const resource: Resource | undefined = setup.recipe ? data.resources[setup.recipe] : undefined;
  if (!resource) {
    if (setup.recipe) warnings.push(`Unknown resource ${setup.recipe}`);
    else warnings.push(`${entity.name} has no resource under it`);
    if (entity.energySource === 'electric') rate.powerW = entity.drain ?? 0;
    return rate;
  }
  if (entity.categories && !entity.categories.includes(resource.category)) {
    warnings.push(`${entity.name} can't mine ${resource.name}`);
  }
  const e = machineEffects(data, entity, undefined, modules, beacons, bonuses.miningProductivity, warnings);
  const speed = entity.miningSpeed ?? entity.craftingSpeed ?? 1;
  const ops = (speed * (1 + e.speed)) / resource.miningTime;
  rate.craftsPerSecond = ops;
  rate.speedBonus = e.speed;
  rate.productivityBonus = e.productivity;
  rate.consumptionBonus = e.consumption;
  rate.pollutionBonus = e.pollution;
  rate.outputs = scaleProducts(resource.results, ops, e.productivity);
  if (resource.requiredFluid && resource.fluidAmount) {
    // Prototype fluid_amount is per 10 mining operations.
    rate.inputs = [{ name: resource.requiredFluid, perSecond: (ops * resource.fluidAmount) / 10 }];
  }
  Object.assign(rate, powerFor(entity, e.consumption));
  return rate;
}

