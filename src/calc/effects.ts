import type { Effect, Entity, GameData, Recipe } from '../data/types';

export interface EffectTotals {
  speed: number;
  productivity: number;
  consumption: number;
  pollution: number;
}

export const NO_EFFECT: EffectTotals = { speed: 0, productivity: 0, consumption: 0, pollution: 0 };

/** A beacon reaching a machine, with the modules inside it. */
export interface BeaconInfluence {
  beacon: string;
  modules: string[];
}

/** 2.0 lower limits: speed, consumption and pollution can't go below -80%, productivity below 0. */
export const MIN_SPEED = -0.8;
export const MIN_CONSUMPTION = -0.8;
export const MIN_POLLUTION = -0.8;
/** Default productivity cap (+300%) unless the recipe sets its own. */
export const DEFAULT_MAX_PRODUCTIVITY = 3;

export function addEffects(a: EffectTotals, b: EffectTotals, scale = 1): EffectTotals {
  return {
    speed: a.speed + b.speed * scale,
    productivity: a.productivity + b.productivity * scale,
    consumption: a.consumption + b.consumption * scale,
    pollution: a.pollution + b.pollution * scale,
  };
}

/**
 * Why a module can't go into this machine for this recipe, or undefined if it can.
 * Mirrors the game: a module is refused if any of its effects is not allowed
 * by the machine, productivity is refused on recipes that don't allow it, and a
 * `limitation` list restricts it to listed recipes.
 */
export function moduleRejection(
  data: GameData,
  moduleName: string,
  machine: Entity | undefined,
  recipe: Recipe | undefined,
): string | undefined {
  const mod = data.modules[moduleName];
  if (!mod) return `Unknown module ${moduleName}`;
  const effects = (Object.keys(mod.effect) as Effect[]).filter((e) => (mod.effect[e] ?? 0) !== 0);
  // Only beneficial effects count against allowedEffects; side effects (e.g.
  // a prod module's consumption penalty) ride along with the main effect.
  const primary = effects.filter((e) => {
    const v = mod.effect[e] ?? 0;
    return e === 'consumption' || e === 'pollution' ? v < 0 : v > 0;
  });
  if (machine?.allowedEffects) {
    const bad = primary.find((e) => !machine.allowedEffects!.includes(e));
    if (bad) return `${machine.name} does not accept ${bad} modules`;
  }
  if ((mod.effect.productivity ?? 0) > 0 && recipe && !recipe.allowProductivity) {
    return `${recipe.name} does not allow productivity`;
  }
  if (mod.limitation && mod.limitation.length > 0 && recipe && !mod.limitation.includes(recipe.name)) {
    return `${moduleName} can't be used on ${recipe.name}`;
  }
  return undefined;
}

/** Sum the effects of modules; rejected modules are skipped and reported. */
export function moduleEffects(
  data: GameData,
  modules: readonly string[],
  machine: Entity | undefined,
  recipe: Recipe | undefined,
  warnings: string[] = [],
): EffectTotals {
  let total = NO_EFFECT;
  for (const name of modules) {
    const why = moduleRejection(data, name, machine, recipe);
    if (why) {
      warnings.push(why);
      continue;
    }
    const e = data.modules[name]!.effect;
    total = addEffects(total, {
      speed: e.speed ?? 0,
      productivity: e.productivity ?? 0,
      consumption: e.consumption ?? 0,
      pollution: e.pollution ?? 0,
    });
  }
  return total;
}

/** Per-beacon strength multiplier when `count` beacons reach one machine (2.0 profile). */
export function beaconProfile(beacon: Entity, count: number): number {
  if (count <= 0) return 0;
  const profile = beacon.profile;
  if (profile && profile.length > 0) return profile[Math.min(count, profile.length) - 1]!;
  return 1 / Math.sqrt(count);
}

/**
 * Total effect beacons transmit to one machine. In 2.0 each beacon gives
 * distribution effectivity × its modules × profile(n), where n is the number
 * of beacons reaching the machine; for the base beacon that is 1.5 × √n × module.
 */
export function beaconEffects(
  data: GameData,
  beacons: readonly BeaconInfluence[],
  machine: Entity | undefined,
  recipe: Recipe | undefined,
  warnings: string[] = [],
): EffectTotals {
  let total = NO_EFFECT;
  const n = beacons.length;
  for (const b of beacons) {
    const beacon = data.entities[b.beacon];
    if (!beacon) {
      warnings.push(`Unknown beacon ${b.beacon}`);
      continue;
    }
    // Beacons can't carry productivity modules in base 2.0 (allowedEffects on the beacon).
    const mods = moduleEffects(data, b.modules, beacon, undefined, warnings);
    // The receiving machine must accept the transmitted effects too.
    const filtered = filterAllowed(mods, machine);
    const strength = (beacon.distributionEffectivity ?? 1) * beaconProfile(beacon, n);
    total = addEffects(total, filtered, strength);
  }
  if (recipe && !recipe.allowProductivity) total = { ...total, productivity: 0 };
  return total;
}

function filterAllowed(e: EffectTotals, machine: Entity | undefined): EffectTotals {
  const allowed = machine?.allowedEffects;
  if (!allowed) return e;
  return {
    speed: allowed.includes('speed') ? e.speed : 0,
    productivity: allowed.includes('productivity') ? e.productivity : 0,
    consumption: allowed.includes('consumption') ? e.consumption : 0,
    pollution: allowed.includes('pollution') ? e.pollution : 0,
  };
}

/** Apply 2.0 limits. */
export function clampEffects(e: EffectTotals, maxProductivity = DEFAULT_MAX_PRODUCTIVITY): EffectTotals {
  return {
    speed: Math.max(MIN_SPEED, e.speed),
    productivity: Math.min(maxProductivity, Math.max(0, e.productivity)),
    consumption: Math.max(MIN_CONSUMPTION, e.consumption),
    pollution: Math.max(MIN_POLLUTION, e.pollution),
  };
}
