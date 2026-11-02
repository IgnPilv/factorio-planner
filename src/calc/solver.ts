import { solve, type Coefficients, type Constraint } from 'yalps';
import type { Entity, EntityKind, GameData, Recipe } from '../data/types';
import type { BeaconInfluence } from './effects';
import { sumFlows, type Flow } from './flow';
import { ELECTRICITY, machineRate, recipeCategories, type EntityRate } from './machine';
import { researchBonuses, type ResearchBonuses, type ResearchState } from './research';

/** Beacons around every machine of one recipe in the calculator. */
export interface BeaconSetup {
  beacon: string;
  /** Beacons reaching each machine. */
  count: number;
  /** Modules in each beacon. */
  modules: string[];
  /**
   * Beacons built per machine, for power. Beacons are usually shared, so this
   * defaults to count / 4 (a typical row layout); set it to count for unshared.
   */
  powerShare?: number;
}

export interface SolveOptions {
  /** What to make, per second. */
  targets: Flow[];
  research?: ResearchState;
  /**
   * Item -> recipe name to make it with, or "import" to treat it as a raw input.
   * Without a choice, every unlocked recipe for the item is offered to the
   * solver, which picks the mix needing the fewest mines.
   */
  recipeFor?: Record<string, string>;
  /** Recipe, resource or category name -> entity to use. */
  machineFor?: Record<string, string>;
  /** Recipe or resource name -> modules in each machine. */
  modules?: Record<string, string[]>;
  /** Recipe or resource name -> beacons around each machine. */
  beacons?: Record<string, BeaconSetup>;
  /** Extra recipes the solver may use alongside the chosen ones. */
  extraRecipes?: string[];
  /** Items to take as inputs instead of making them. */
  imports?: string[];
  /** Solve electricity with steam power (pump, boilers, engines, coal). Default true. */
  includePower?: boolean;
  /** Fuel for boilers and burner machines. Default "coal". */
  fuel?: string;
  /** Default false: use any recipe/machine, warning when it is not researched. */
  onlyResearched?: boolean;
}

export type ProcessKind = 'recipe' | 'mine' | 'pump' | 'boiler' | 'generator';

export interface SolvedProcess {
  id: string;
  kind: ProcessKind;
  /** Recipe, resource or fluid name. */
  name: string;
  entity: string;
  /** Machines needed (fractional; round up to build). */
  machines: number;
  /** One machine at full speed. */
  perMachine: EntityRate;
  /** Totals for all machines, including electricity (W) and fuel. */
  inputs: Flow[];
  outputs: Flow[];
  powerW: number;
  modules: string[];
  beacons?: BeaconSetup;
}

export interface SolveResult {
  ok: boolean;
  processes: SolvedProcess[];
  /** Raw resources extracted (ores, crude oil, water). */
  resources: Flow[];
  /** Items taken as inputs because nothing makes them, or by choice. */
  imports: Flow[];
  /** By-products made beyond what's needed. */
  surplus: Flow[];
  /** Electric demand in W of every machine in the plan (including the mines feeding the power plant). */
  powerDemandW: number;
  warnings: string[];
}

const CRAFTER_KINDS: EntityKind[] = ['assembler', 'furnace', 'chemical-plant', 'refinery', 'centrifuge', 'rocket-silo'];
const IMPORT_COST = 1e4;
const MACHINE_COST = 1e-3;

interface Process {
  id: string;
  kind: ProcessKind;
  name: string;
  entity: string;
  rate: EntityRate;
  /** Net flow per machine, including power and fuel. */
  net: Map<string, number>;
  cost: number;
  modules: string[];
  beacons?: BeaconSetup;
}

export function solveFactory(data: GameData, options: SolveOptions): SolveResult {
  const warnings: string[] = [];
  const research = options.research ?? {};
  const bonuses = researchBonuses(data, research);
  const includePower = options.includePower ?? true;
  const fuel = options.fuel ?? 'coal';
  const imports = new Set(options.imports ?? []);
  const processes = new Map<string, Process>();
  const importables = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [];

  const enqueue = (item: string) => {
    if (!seen.has(item)) {
      seen.add(item);
      queue.push(item);
    }
  };

  const ctx: BuildContext = { data, options, bonuses, warnings, fuel };

  const addProcess = (p: Process | undefined) => {
    if (!p || processes.has(p.id)) return;
    processes.set(p.id, p);
    for (const [name, v] of p.net) if (v < 0) enqueue(name);
  };

  for (const t of options.targets) enqueue(t.name);
  for (const r of options.extraRecipes ?? []) {
    const recipe = data.recipes[r];
    if (recipe) addProcess(recipeProcess(ctx, recipe));
    else warnings.push(`Unknown recipe ${r}`);
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    const choice = options.recipeFor?.[item];
    if (imports.has(item) || choice === 'import') {
      importables.add(item);
      continue;
    }
    if (item === ELECTRICITY && !includePower) {
      importables.add(item);
      continue;
    }
    const producers = producersFor(ctx, item, choice);
    if (producers.length > 0) producers.forEach(addProcess);
    else importables.add(item);
  }

  // Linear program: machines per process >= 0, net production of each item >= demand.
  const demand = new Map<string, number>();
  for (const t of options.targets) demand.set(t.name, (demand.get(t.name) ?? 0) + t.perSecond);
  const items = new Set<string>([...demand.keys(), ...importables]);
  for (const p of processes.values()) for (const k of p.net.keys()) items.add(k);

  const constraints: Record<string, Constraint> = {};
  for (const item of items) constraints[item] = { min: demand.get(item) ?? 0 };
  const variables: Record<string, Coefficients> = {};
  for (const p of processes.values()) {
    const c: Record<string, number> = { cost: p.cost };
    for (const [k, v] of p.net) c[k] = v;
    variables[p.id] = c;
  }
  for (const item of importables) {
    variables[`import:${item}`] = { [item]: 1, cost: imports.has(item) || item === ELECTRICITY ? 1e-6 : IMPORT_COST };
  }
  const solution = solve({ direction: 'minimize', objective: 'cost', constraints, variables });
  if (solution.status !== 'optimal') {
    return {
      ok: false,
      processes: [],
      resources: [],
      imports: [],
      surplus: [],
      powerDemandW: 0,
      warnings: [...warnings, `Solver: ${solution.status}`],
    };
  }

  const values = new Map(solution.variables);
  const solved: SolvedProcess[] = [];
  const net = new Map<string, number>();
  const importFlows: Flow[] = [];
  let powerDemandW = 0;
  for (const p of processes.values()) {
    const machines = values.get(p.id) ?? 0;
    if (machines <= 1e-9) continue;
    const inputs: Flow[] = [];
    const outputs: Flow[] = [];
    for (const [k, v] of p.net) {
      net.set(k, (net.get(k) ?? 0) + v * machines);
      (v < 0 ? inputs : outputs).push({ name: k, perSecond: Math.abs(v) * machines });
    }
    const powerW = (p.net.get(ELECTRICITY) ?? 0) < 0 ? -p.net.get(ELECTRICITY)! * machines : 0;
    powerDemandW += powerW;
    solved.push({
      id: p.id,
      kind: p.kind,
      name: p.name,
      entity: p.entity,
      machines,
      perMachine: p.rate,
      inputs,
      outputs,
      powerW,
      modules: p.modules,
      beacons: p.beacons,
    });
  }
  for (const item of importables) {
    const v = values.get(`import:${item}`) ?? 0;
    if (v > 1e-9) {
      importFlows.push({ name: item, perSecond: v });
      net.set(item, (net.get(item) ?? 0) + v);
      if (!imports.has(item) && options.recipeFor?.[item] !== 'import' && item !== ELECTRICITY) {
        warnings.push(`Nothing makes ${item}; counted as an input`);
      }
    }
  }

  const surplus: Flow[] = [];
  for (const [k, v] of net) {
    const extra = v - (demand.get(k) ?? 0);
    if (extra > 1e-4 && k !== ELECTRICITY) surplus.push({ name: k, perSecond: extra });
  }
  const resources = sumFlows(
    solved.filter((p) => p.kind === 'mine' || p.kind === 'pump').flatMap((p) => p.outputs),
  );

  return { ok: true, processes: solved, resources, imports: importFlows, surplus, powerDemandW, warnings: dedupe(warnings) };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

interface BuildContext {
  data: GameData;
  options: SolveOptions;
  bonuses: ResearchBonuses;
  warnings: string[];
  fuel: string;
}

function producersFor(ctx: BuildContext, item: string, choice: string | undefined): Process[] {
  const { data } = ctx;
  const one = (p: Process | undefined) => (p ? [p] : []);
  if (choice) {
    const recipe = data.recipes[choice];
    if (recipe) return one(recipeProcess(ctx, recipe));
    ctx.warnings.push(`Unknown recipe ${choice} for ${item}`);
  }
  if (item === ELECTRICITY) return one(generatorProcess(ctx));
  const resource = Object.values(data.resources).find((r) => r.results.some((p) => p.name === item));
  if (resource) return one(mineProcess(ctx, resource.name));
  const pump = pickEntity(ctx, item, (e) => e.kind === 'offshore-pump' && (e.fluid ?? 'water') === item, 'pumpingSpeed');
  if (pump) return [pumpProcess(ctx, pump, item)];
  if (item === 'steam') {
    const boiler = pickEntity(ctx, 'boiler', (e) => e.kind === 'boiler', 'energyUsage');
    if (boiler) return [boilerProcess(ctx, boiler)];
  }
  return candidateRecipes(ctx, item).flatMap((r) => one(recipeProcess(ctx, r)));
}

/**
 * Recipes the solver may use to make an item when the user hasn't picked one:
 * every unlocked recipe (the solver then picks the mix that needs the least
 * raw resources, e.g. advanced oil processing plus cracking). If none is
 * unlocked, the simplest locked one, with a warning.
 * Barrel, recycling and self-consuming recipes (kovarex) are left out.
 */
export function candidateRecipes(
  ctx: { data: GameData; bonuses: ResearchBonuses; warnings: string[]; options?: SolveOptions },
  item: string,
): Recipe[] {
  const all = Object.values(ctx.data.recipes).filter(
    (r) =>
      r.results.some((p) => p.name === item) &&
      r.category !== 'recycling' &&
      !/barrel/.test(r.name) &&
      !r.ingredients.some((i) => i.name === item),
  );
  if (all.length === 0) return [];
  const unlocked = all.filter((r) => ctx.bonuses.unlockedRecipes.has(r.name));
  if (unlocked.length > 0) return unlocked;
  if (ctx.options?.onlyResearched) return [];
  const score = (r: Recipe) => (r.name === item ? 0 : 1) * 100 + r.results.length * 10 + r.ingredients.length;
  const fallback = [...all].sort((a, b) => score(a) - score(b))[0]!;
  ctx.warnings.push(`${fallback.name} is not researched yet`);
  return [fallback];
}

function entityAvailable(ctx: BuildContext, e: Entity): boolean {
  const item = e.item ?? e.name;
  const makers = Object.values(ctx.data.recipes).filter((r) => r.results.some((p) => p.name === item));
  return makers.length === 0 || makers.some((r) => ctx.bonuses.unlockedRecipes.has(r.name));
}

/** Pick the best entity matching `filter`: user choice, else fastest unlocked (electric wins ties). */
function pickEntity(
  ctx: BuildContext,
  key: string,
  filter: (e: Entity) => boolean,
  speedField: 'craftingSpeed' | 'miningSpeed' | 'pumpingSpeed' | 'energyUsage',
  keys: string[] = [],
): Entity | undefined {
  for (const k of [key, ...keys]) {
    const chosen = ctx.options.machineFor?.[k];
    if (chosen) {
      const e = ctx.data.entities[chosen];
      if (e) return e;
      ctx.warnings.push(`Unknown building ${chosen}`);
    }
  }
  const candidates = Object.values(ctx.data.entities).filter(filter);
  if (candidates.length === 0) return undefined;
  const rank = (e: Entity) => (e[speedField] ?? 0) + (e.energySource === 'electric' ? 1e-6 : 0);
  candidates.sort((a, b) => rank(b) - rank(a));
  const available = candidates.filter((e) => entityAvailable(ctx, e));
  if (available[0]) return available[0];
  if (ctx.options.onlyResearched) return undefined;
  // Nothing researched yet: assume the earliest (slowest) tier.
  const earliest = candidates[candidates.length - 1]!;
  ctx.warnings.push(`${earliest.name} is not researched yet`);
  return earliest;
}

function beaconInfluences(setup: BeaconSetup | undefined): BeaconInfluence[] {
  if (!setup) return [];
  return Array.from({ length: setup.count }, () => ({ beacon: setup.beacon, modules: setup.modules }));
}

function makeProcess(
  ctx: BuildContext,
  id: string,
  kind: ProcessKind,
  name: string,
  entity: Entity,
  rate: EntityRate,
  modules: string[],
  beacons: BeaconSetup | undefined,
  cost: number,
): Process {
  const net = new Map<string, number>();
  const add = (k: string, v: number) => net.set(k, (net.get(k) ?? 0) + v);
  for (const o of rate.outputs) add(o.name, o.perSecond);
  for (const i of rate.inputs) add(i.name, -i.perSecond);
  let power = Math.max(0, rate.powerW);
  if (beacons && beacons.count > 0) {
    const b = ctx.data.entities[beacons.beacon];
    power += (b?.energyUsage ?? 0) * (beacons.powerShare ?? beacons.count / 4);
  }
  if (power > 0) add(ELECTRICITY, -power);
  if (rate.fuelW > 0) {
    const fuelValue = ctx.data.items[ctx.fuel]?.fuelValue;
    if (fuelValue) add(ctx.fuel, -rate.fuelW / fuelValue);
    else ctx.warnings.push(`${ctx.fuel} has no fuel value`);
  }
  for (const w of rate.warnings) ctx.warnings.push(`${name}: ${w}`);
  return { id, kind, name, entity: entity.name, rate, net, cost: cost + MACHINE_COST, modules, beacons };
}

function recipeProcess(ctx: BuildContext, recipe: Recipe): Process | undefined {
  const entity = pickEntity(
    ctx,
    recipe.name,
    (e) => CRAFTER_KINDS.includes(e.kind) && recipeCategories(recipe).some((c) => (e.categories ?? []).includes(c)),
    'craftingSpeed',
    recipeCategories(recipe),
  );
  if (!entity) {
    ctx.warnings.push(`No building can craft ${recipe.name}`);
    return undefined;
  }
  const modules = ctx.options.modules?.[recipe.name] ?? [];
  const beacons = ctx.options.beacons?.[recipe.name];
  const rate = machineRate(ctx.data, { entity: entity.name, recipe: recipe.name, modules, beacons: beaconInfluences(beacons) }, ctx.bonuses);
  return makeProcess(ctx, `recipe:${recipe.name}`, 'recipe', recipe.name, entity, rate, modules, beacons, 0);
}

function mineProcess(ctx: BuildContext, resourceName: string): Process | undefined {
  const resource = ctx.data.resources[resourceName]!;
  const entity = pickEntity(
    ctx,
    resource.name,
    (e) => e.kind === 'mining-drill' && (e.categories ?? []).includes(resource.category),
    'miningSpeed',
    [resource.category],
  );
  if (!entity) {
    ctx.warnings.push(`No drill can mine ${resource.name}`);
    return undefined;
  }
  const modules = ctx.options.modules?.[resource.name] ?? [];
  const beacons = ctx.options.beacons?.[resource.name];
  const rate = machineRate(ctx.data, { entity: entity.name, recipe: resource.name, modules, beacons: beaconInfluences(beacons) }, ctx.bonuses);
  // Cost: one per drill, so the solver prefers recipe mixes that need fewer mines.
  return makeProcess(ctx, `mine:${resource.name}`, 'mine', resource.name, entity, rate, modules, beacons, 1);
}

function pumpProcess(ctx: BuildContext, entity: Entity, fluid: string): Process {
  const rate = machineRate(ctx.data, { entity: entity.name }, ctx.bonuses);
  // Water is nearly free; a tiny cost keeps the solver from overbuilding pumps.
  const extracted = rate.outputs.reduce((s, o) => s + o.perSecond, 0) * 1e-3;
  return makeProcess(ctx, `pump:${fluid}`, 'pump', fluid, entity, rate, [], undefined, extracted);
}

function boilerProcess(ctx: BuildContext, entity: Entity): Process {
  const rate = machineRate(ctx.data, { entity: entity.name }, ctx.bonuses);
  return makeProcess(ctx, `boiler:${entity.name}`, 'boiler', 'steam', entity, rate, [], undefined, 0);
}

function generatorProcess(ctx: BuildContext): Process | undefined {
  const entity = pickEntity(ctx, ELECTRICITY, (e) => e.kind === 'generator' && (e.fluidUsage ?? 0) > 0, 'energyUsage');
  if (!entity) return undefined;
  const rate = machineRate(ctx.data, { entity: entity.name }, ctx.bonuses);
  return makeProcess(ctx, `generator:${entity.name}`, 'generator', ELECTRICITY, entity, rate, [], undefined, 0);
}
