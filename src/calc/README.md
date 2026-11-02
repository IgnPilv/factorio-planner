# Rate engine (`src/calc`)

Pure TypeScript, no UI. Everything takes the `GameData` from `src/data` and a
`ResearchState` (`{ techName: levelsResearched }`).

| Function | Use |
| --- | --- |
| `machineRate(data, { entity, recipe, modules, beacons }, research)` | One machine at full speed: crafts/s, inputs/outputs per second, power (W), fuel (W), bonuses, warnings. For drills `recipe` is the resource name. Handles offshore pumps, boilers, steam engines, solar, labs, beacons. |
| `computeLayoutRates(layout, data, research)` | Same, for every placed entity in an editor layout, keyed by entity id. Beacons are found from positions. `layoutTotals()` sums them. |
| `solveFactory(data, { targets, research, recipeFor, machineFor, modules, beacons, imports, includePower })` | Calculator: machine counts, raw resources, water, power plant, surplus. Linear program (yalps), so oil cracking and other multi-output chains balance. |
| `researchBonuses`, `availableRecipes`, `availableEntities`, `allResearched` | Research toggles: bonuses and what's unlocked. |

Game rules used (Factorio 2.0/2.1):

- crafts/s = crafting speed × (1 + speed) / recipe time; outputs × (1 + productivity), inputs not.
- Power = energy usage × (1 + consumption) + drain. Speed, consumption and pollution floor at −80%, productivity at 0 and caps at the recipe's maximum (+300% default).
- Beacons: each gives distribution effectivity × modules × profile(n), so the base beacon totals 1.5 × √n × module.
- Mining productivity research applies to drills; recipe productivity research to its recipe.
- Boilers: steam/s = power / ((165 − 15) × 200 J); 1 pump : 20 boilers : 40 engines.
