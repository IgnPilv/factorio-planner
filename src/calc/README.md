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
- Boilers: steam/s = power / ((165 − 15) × 200 J); 1 pump : 20 boilers : 40 engines.

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
  both fronts (even split isn't forced; the solver may route unevenly).
- **Inserters** move items from the tile behind to the tile in front (2 tiles
  for long-handed), only items the target machine needs, at
  hand × 60 / (2 × ceil(0.5 / rotation speed)) items/s: the wiki's
  chest-to-chest figures (0.83, 1.2, 2.31/s). Capacity research adds to the
  hand. Belt pickup can be a little slower in game; not modelled yet.
- **Drills** drop onto the tile beyond the middle of their front edge
  (belt, machine or chest). Burner machines need fuel (coal by default)
  inserted like any other input.
- **Fluids**: pipes, pipe-to-ground pairs, tanks, pumps, offshore pumps,
  boilers and engines that touch form networks; other machines plug into
  networks beside them. Pipe throughput isn't limited.
- **Power**: no generators in the layout means power is assumed to come from
  outside. Otherwise poles join within wire reach and cover their supply area;
  uncovered machines get no power, and a short network slows its machines.
  Power-plant parts only run as hard as demand needs.
- **Chests** absorb whatever reaches them; a chest whose `recipe` names an
  item is an unlimited supply of it. Labs absorb science packs.
- Status: a machine below 99.9% is `output-blocked` when it could run faster
  with free disposal of its outputs, `starved` otherwise (with `missing`
  listing inputs that nothing delivers), `low-power` when its network is maxed.
