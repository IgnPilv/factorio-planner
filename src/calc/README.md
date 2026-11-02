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

- **Belts** have two lanes, each half the belt's throughput (7.5/s yellow);
  lanes are named as seen facing the way the belt moves, and every belt tile,
  underground and splitter is one node per lane.
  - A curve keeps each lane. A belt joining another from the side (when the
    target is also fed from behind, or from both sides) puts both its lanes
    onto the target's lane on its side, limited to that one lane's speed.
  - Side-loading an underground: only the half of the tile with belt on it
    takes items, the tunnel half blocks them (wiki, Belt transport system), so
    only the source lane over the open half gets through (the lane filter).
  - Inserters drop on the far lane, or on the belt's right lane when the belt
    runs toward or away from them (wiki, Inserters), and pick from either lane.
  - Drills drop on the near lane of a belt across their front (from the
    game's `vector_to_place_result`); along a belt the burner drill uses the
    lane on its left and the electric drill (dead centre) is assumed to use the
    belt's right lane.
  - Splitters keep lanes and split each lane on its own.
  - Reported belt utilization is the busier lane's share of a lane's speed.
  Belts ending in an empty tile are layout outputs; belts ending against a
  building or head-on into another belt stop.
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
  networks beside them. Within a 2.0 pipeline flow is instant whatever its
  length. Each machine connection moves at most 6000/s (the wiki notes about
  4200/s is usual in practice, so above that a warning is given), and a pump
  moves 1200/s one way between two pipelines. A pipeline spreading outside
  320×320 tiles (`default_pipeline_extent`) carries nothing, as in game, until a
  pump splits it.
- **Labs** research one technology: the chosen one (`labResearch`) or by
  default the most advanced the packs reaching the labs allow (most pack types,
  then infinite, then longest unit time; `researchChoices`). Each lab uses
  `amount × researching speed × (1 + speed bonus) / unit time` of each pack per
  second (speed bonus = modules, beacons and lab-speed research), and makes
  `(1 + lab productivity)` units per cycle. Inserters can take packs from one
  lab on to the next. Labs no longer count as layout outputs; the result's
  `research` gives units/s and packs/s.
- **Power**: no generators in the layout means power is assumed to come from
  outside. Otherwise poles join within wire reach and cover their supply area;
  uncovered machines get no power. A short network slows all its machines
  alike, as the game's power satisfaction does: every electric consumer on it
  is capped at the same share s, found by bisection so that demand with that cap
  equals the generation available. Electric inserters share it too: on a short
  network their capacity is scaled by s (`powerShare` on their transport
  state), and one no pole reaches moves nothing (`powerShare` 0, listed as an
  `unpowered` bottleneck). Inserters also draw power: one full arm turn
  (`energy_per_rotation`) per swing, a swing carrying a full hand, plus their
  drain (`powerW` on their transport state). Arm extension energy is left out;
  it is small for the usual pickup and drop distances.
  Every powered electric machine draws its drain whether it runs or not
  (idle, starved or without a recipe); the rest of its power scales with
  activity. Beacons draw their full power all the time, and a beacon no pole
  reaches (when the layout has poles) gives no effect. On a short network the
  satisfaction s scales everything alike, drains and beacons included.
  Power-plant parts only run as hard as demand needs.
- **Nuclear**: a reactor burns a uranium fuel cell every 200 s (40 MW) whether
  or not its heat is used, and stops when its spent cells aren't taken out.
  Reactors whose side midpoints meet (in line, touching) get +100% heat per
  such neighbour. Reactors, heat pipes and heat exchangers join into heat
  networks where their connection points meet (factorio-data positions; a heat
  exchanger connects only on its back). Each heat exchanger takes 10 MW and
  makes 103.09 steam/s at 500 °C. Heat pipe temperature drop and transfer limits
  aren't modelled: a network passes on all the heat its reactors make.
- **Chests** absorb whatever reaches them; a chest whose `recipe` names an
  item is an unlimited supply of it. Labs absorb science packs.
- Status: a machine below 99.9% is `output-blocked` when it could run faster
  with free disposal of its outputs, `starved` otherwise (with `missing`
  listing inputs that nothing delivers), `low-power` when its network is maxed.

## Summaries (`summary.ts`)

- `groupFlows(sim, ids?)`: net items/s of a set of buildings at the speed they actually run (outputs +, inputs −), their power draw, and how many run below full speed. The editor shows it for a multi-building selection.
- `bottlenecks(sim, entities)`: what holds the layout back, worst first. Machines are grouped by building, recipe and reason (nothing delivers an input, short of power, starved, output blocked), ranked by machine-equivalents of speed lost. Belts and inserters running at ≥99% are listed when they carry an input of a starved machine, since those are the likely cause. This is a heuristic: it matches by item, not by tracing the exact path.

## Filters and priorities

- **Inserter filters**: an allow list narrows what the inserter moves (intersected with what the target accepts); a deny list (`filterMode: 'blacklist'`) blocks the listed items.
- **Splitter output priority**: the priority side is filled first (an objective bonus of 1e-3 per item/s, below the 1e-2 for items leaving the layout); the other side only gets the overflow.
- **Splitter filter** (needs an output priority, as in 2.0): the filter item goes only to the priority side and every other item only to the other side. If that side is blocked, the item waits; it does not overflow.
- **Splitter input priority**: the priority input is emptied first.
- Sides without a priority are still balanced evenly (third solve). That solve keeps machine activity, outputs and priorities, but not the 1e-6 per-edge flow cost, so an even split along a longer path is allowed.
