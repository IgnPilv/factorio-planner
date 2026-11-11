# Factorio Map Viewer

Drop a Factorio save on a web page and explore it: every planet and space platform,
zoomable from the whole map down to single buildings, with the game's own icons.
Everything happens in the browser; nothing is uploaded.

Live site: https://ignpilv.github.io/factorio-planner/ (main). Every pull request also gets a
preview at `https://ignpilv.github.io/factorio-planner/pr-preview/pr-<number>/`, linked in a PR comment.

## How it works

A save's map data (`level.dat0..N` inside the zip) is Factorio's own binary format. It isn't
documented and changes with every game version, so a website can't reliably read buildings out
of it. Instead a small companion mod does the reading inside the game:

1. Install `map-viewer-export` (the site offers the zip; it's built from [`mod/`](mod/map-viewer-export)).
2. In game press **Ctrl + Alt + M** or type `/map-export`. The mod walks every charted chunk of
   every surface over a few ticks and records tiles, entities (position, direction, force, recipe)
   and prototype data (sizes, map colours, icon paths, read in `data-final-fixes.lua`).
3. The result (JSON, deflated and base64'd by `helpers.encode_string`) is kept in the mod's
   `storage`, so it is written into the next save's `script.dat`, and also to
   `script-output/map-viewer-export.txt`. The site finds it between two marker strings
   (`src/export/load.ts`). `/map-export-clear` drops it again.

The export format is described at the top of `mod/map-viewer-export/control.lua`; the decoder is
`src/export/format.ts`.

Icons: Wube's terms don't allow redistributing the game's art, so the site ships none. **Load
icons…** lets you pick your Factorio install folder; the browser reads only the icon files the map
uses (base, space-age, quality, elevated-rails, and installed mods when you pick your user data folder), and keeps them in IndexedDB (`src/icons.ts`).
Until then buildings are drawn in their map colours.

## Develop

```sh
npm install
npm run dev        # local dev server (try the demo map)
npm test           # unit tests, including the mod's Lua run against a fake game (fengari)
npm run build      # packs the mod into public/, type-checks and builds
```

## Layout

- `mod/map-viewer-export/` the companion Factorio mod
- `src/export/` finding and decoding the export (plus a demo map)
- `src/map/renderer.ts` canvas renderer: cached 1 px/tile region pictures zoomed out, per-entity drawing zoomed in
- `src/MapView.tsx`, `src/App.tsx` the page
- `scripts/build-mod.mjs` zips the mod for download
