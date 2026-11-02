# Factorio Planner

A browser app to lay out Factorio factories on a grid and calculate production rates.
Scope for v1: base game, Nauvis only, greenfield start. Rates account for machine speed,
modules, beacons and toggleable research.

Game data comes from Wube's official prototype files
([wube/factorio-data](https://github.com/wube/factorio-data)), the same source the
[Factorio wiki](https://wiki.factorio.com) infoboxes are built from.

Live site: https://ignpilv.github.io/factorio-planner/ (main). Every pull request also gets a
preview at `https://ignpilv.github.io/factorio-planner/pr-preview/pr-<number>/`, linked in a PR comment.

## Develop

```sh
npm install
npm run dev        # local dev server
npm test           # unit tests
npm run build      # type-check and production build
```

## Game data

`data/nauvis.json` is generated from the game's prototype files and committed, so the app needs
no network access to game data. To refresh it for a new Factorio release:

```sh
git clone --depth 1 https://github.com/wube/factorio-data .factorio-data
npm run extract-data -- .factorio-data
npm test
```

The extractor reads the Lua files as text and never runs them. Types for the generated file are
in `src/data/types.ts`.

Icons: Wube's terms don't allow redistributing the game's art, and factorio-data has no
graphics, so the site ships no icons. The **Icons** button lets you pick your own Factorio
install; the browser reads only the icon files listed in `nauvis.json` (`icon` paths), crops
the full-size mip level and keeps them in IndexedDB (`src/data/icons.ts`). Nothing is
uploaded. Until then, lists fall back to wiki images and the grid to coloured blocks.

## Layout

- `src/data/` shared game-data types (`types.ts`) and loaders
- `src/calc/` rate engine (pure TypeScript)
- `src/editor/` grid layout editor
- `src/ui/` app shell and panels
- `scripts/` data extraction from the game files
