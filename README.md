# Factorio Planner

A browser app to lay out Factorio factories on a grid and calculate production rates.
Scope for v1: base game, Nauvis only, greenfield start. Rates account for machine speed,
modules, beacons and toggleable research.

Game data comes from Wube's official prototype files
([wube/factorio-data](https://github.com/wube/factorio-data)), the same source the
[Factorio wiki](https://wiki.factorio.com) infoboxes are built from.

## Develop

```sh
npm install
npm run dev        # local dev server
npm test           # unit tests
npm run build      # type-check and production build
```

## Layout

- `src/data/` shared game-data types (`types.ts`) and loaders
- `src/calc/` rate engine (pure TypeScript)
- `src/editor/` grid layout editor
- `src/ui/` app shell and panels
- `scripts/` data extraction from the game files
