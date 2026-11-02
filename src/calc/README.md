# Rate engine (`src/calc`)

Pure TypeScript, no UI. Everything takes the `GameData` from `src/data` and a
`ResearchState` (`{ techName: levelsResearched }`).

| Function | Use |
| --- | --- |
| `machineRate(data, { entity, recipe, modules, beacons }, research)` | One machine at full speed: crafts/s, inputs/outputs per second, power (W), fuel (W), bonuses, warnings. For drills `recipe` is the resource name. Handles offshore pumps, boilers, steam engines, solar, labs, beacons. |
| `computeLayoutRates(layout, data, research)` | Same, for every placed entity in an editor layout, keyed by entity id. Beacons are found from positions. `layoutTotals()` sums them. |
| `solveFactory(data, { targets, research, recipeFor, machineFor, modules, beacons, imports, includePower })` | Calculator: machine counts, raw resources, water, power plant, surplus. Linear program (yalps), so oil cracking and other multi-output chains balance. |
| `simulateLayout(layout, data, research)` | Steady state of a built layout: each machine's actual activity and status (working, starved, output-blocked, low-power, no-power, no-recipe, idle) with the inputs nothing delivers; flow and utilization of every belt, underground, splitter and inserter; what leaves the layout; power demand vs generation. See below. |
| `inserterThroughput(entity, bonuses)` | Items/s an inserter moves chest to chest. |
| `researchBonuses`, `availableRecipes`, `availableEntities`, `allResearched` | Research toggles: bonuses and what's unlocked. |

Game rules used (Factorio 2.0/2.1):

- crafts/s = crafting speed × (1 + speed) / recipe time; outputs × (1 + productivity), inputs not.
- Power = energy usage × (1 + consumption) + drain. Speed, consumption and pollution floor at −80%, productivity at 0 and caps at the recipe's maximum (+300% default).
- Beacons: each gives distribution effectivity × modules × profile(n), so the base beacon totals 1.5 × √n × module.
- Mining productivity research applies to drills; recipe productivity research to its recipe.
- Boilers: steam/s = power / ((165 − 15) × 200 J), and 1 water makes 10 steam (2.0), so 1 offshore pump : 200 boilers : 400 engines.

## Steady-state layout model

Per-second averages, not a tick simulation. The layout becomes a flow network
and a linear program finds the most it can sustain: machines run at some
fraction of full speed, items are conserved at every machine, belt tile,
splitter and chest, and nothing moves faster than its limit.

- **Belts**: each tile moves at most its throughput (15/s yellow). A belt
  joining another from the side fills one lane only (half), unless it's a
  plain curve. Belts ending in an empty tile are layout outputs; belts ending
  against a building or head-on into another belt stop.
- **Undergrounds** pair up along a line (upstream = entrance) within their
  max distance. **Splitters** take from behind both halves and pass on through
  both fronts, half each way; the overflow goes to the other side only when
  one side can't take more (a final balancing solve keeps the best total and
  makes splits as even as possible).
- **Inserters** move items from the tile behind to the tile in front (2 tiles
  for long-handed), only items the target machine needs, at hand × 60 /
  ticks per turn, where ticks per turn = 1 / rotation speed truncated and
  rounded down to even: the 2.0 wiki's 76/70/48/24 ticks and 0.79, 0.86,
  1.25, 2.5 items/s. Capacity research adds to the hand. With a belt on
  either side, `inserter-belt.ts` uses the wiki's measurements instead:
  dropping on a belt uses the 2.0 chest-to-belt table as measured; taking
  from a belt is **derived** from the wiki's 1.1 belt-to-chest table, scaled
  by how much faster each inserter's arm cycles in 2.0. Hand sizes between
  measured points are interpolated.
- **Drills** drop onto the tile beyond the middle of their front edge
  (belt, machine or chest). Burner machines need fuel (coal by default)
  inserted like any other input.
- **Fluids**: pipes, pipe-to-ground pairs, tanks, pumps, offshore pumps,
  boilers and engines that touch form networks; other machines plug into
  networks beside them. 2.0 pipelines have no length-based limit; each
  machine connection moves at most 6000/s, a pump moves 1200/s one way
  between two pipelines, and a pipeline wider than 250 tiles gets a warning
  (it stops flowing in game).
- **Power**: no generators in the layout means power is assumed to come from
  outside. Otherwise poles join within wire reach and cover their supply area;
  uncovered machines get no power, and a short network slows its machines.
  Power-plant parts only run as hard as demand needs.
- **Chests** absorb whatever reaches them; a chest whose `recipe` names an
  item is an unlimited supply of it. Labs absorb science packs.
- Status: a machine below 99.9% is `output-blocked` when it could run faster
  with free disposal of its outputs, `starved` otherwise (with `missing`
  listing inputs that nothing delivers), `low-power` when its network is maxed.

## Summaries (`summary.ts`)

- `groupFlows(sim, ids?)`: net items/s of a set of buildings at the speed they actually run (outputs +, inputs −), their power draw, and how many run below full speed. The editor shows it for a multi-building selection.
- `bottlenecks(sim, entities)`: what holds the layout back, worst first. Machines are grouped by building, recipe and reason (nothing delivers an input, short of power, starved, output blocked), ranked by machine-equivalents of speed lost. Belts and inserters running at ≥99% are listed when they carry an input of a starved machine, since those are the likely cause. This is a heuristic: it matches by item, not by tracing the exact path.
