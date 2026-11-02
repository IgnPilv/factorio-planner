# City blocks and 2.0 rails: what the planner checks

The **City blocks** tab tiles one block design 3x3 on a global grid and checks the
middle block against its neighbours. This note records the game rules behind those
checks and how the usual city-block advice holds up against Factorio 2.x data.

## Numbers from the game files (base 2.1.24)

| Thing | Prototype value | Meaning |
|---|---|---|
| Substation | `supply_area_distance = 9`, `maximum_wire_distance = 18`, 2x2 | Powers centre ±9 (18x18). Wires to poles whose centre is ≤ 18 away (the smaller reach of the two poles counts). |
| Big electric pole | supply 2, wire 32, 2x2 | Good for crossing a rail corridor. |
| Roboport | `logistics_radius = 25`, `construction_radius = 55`, 4x4 | 50x50 logistics zone, 110x110 construction zone. Two roboports join one network when their 50x50 squares touch or overlap (centres ≤ 50 apart on both axes). |
| Cargo wagon / locomotive | `joint_distance = 4`, `connection_distance = 3` | 7 tiles of track per car, so a 1-4 train is 34 tiles. |
| Rail signal, chain signal | 1x1 | Stand 1.5 tiles to the right of the track at a rail joint. |
| Train stop | 2x2 | Right-hand side of the track. |

## 2.0 rail geometry

Rail shapes are hard-coded in the engine, not in the prototype files. The planner
uses these facts (sources in `src/rails/geometry.ts`):

- Rails build on a 2x2 grid and every rail end lies on a whole-number point
  ([FFF-377](https://factorio.com/blog/post/fff-377)). North–south track centres are
  on odd x, east–west on odd y, 45° track ends on odd/odd points; no rail end is ever
  on an even/even point ([forum, boskid](https://forums.factorio.com/viewtopic.php?p=611478)).
- Four pieces: straight (2 tiles, or 2√2 diagonal), half-diagonal (22.5°, 2√5),
  curve-A (straight to 22.5°, ends a (1,5) vector apart) and curve-B (22.5° to 45°,
  ends (3,4) apart). Turn radius 13: a 90° turn is A-B-B-A and moves exactly 13x13;
  a 180° turn is 26 tiles between track centres
  ([wiki](https://wiki.factorio.com/Rail)).
- Each rail end connects to at most three pieces: left, straight, right.
- Signals go on the right-hand side; trains only drive with the signals. Junction
  rule: chain signal in, rail signal out.

The curve-B end point (3,4) is derived, not quoted: it is the only whole-number point
that keeps A+B on the radius-13 arc and matches every grid-parity rule above. The
unit tests check that a full circle of 8 A and 8 B pieces closes on itself.

## The advice, checked

| Claim | Verdict |
|---|---|
| Substation covers 18x18, wire reach 18 | Correct. |
| Substations "18 apart edge-to-edge" | Wrong: 18 apart **centre to centre** (a 16-tile gap between the 2x2 bodies). At 18 edge-to-edge (20 centre to centre) they would neither connect nor cover. |
| Roboport 50x50 logistics, 110x110 construction | Correct. |
| Roboports at most 50 apart centre to centre to connect | Correct. "48 tiles between logistics boundaries" is not a game rule. |
| Rails snap to a 2x2 grid, so block sizes must be even | Correct. Also: track centres must be on **odd** coordinates, so with grid lines on even coordinates the two tracks must be an odd distance from the line (track spacing 2, 6, 10 …). Spacing 4 needs the grid offset moved by 1. |
| 3x3 substations = 54x54 inner, 1 roboport in the centre | Power is exact. One roboport covers only 50x50, leaving a 2-tile rim (about 14% of the area) outside the logistics network. |
| 5x5 substations = 90x90 inner, 2x2 roboports | Correct; full logistics coverage. |
| Substation grids "connect perfectly" across blocks | Not across a rail corridor: the nearest substations of neighbouring blocks are 18 + corridor width apart. Put a pole between the tracks (a big pole fits in the 4-tile gap of a 6-spacing double track) or the blocks become separate grids. |
| 54-inner blocks are fine for 1-1 / 1-2 trains | Yes, and the checker shows why not 1-4: with 4-way junctions each junction reaches 18 tiles from its centre, so a 66 pitch leaves 30 tiles between junctions, less than a 34-tile 1-4 train. |
| Blueprint "snap to grid" with absolute position | Correct. Grid size = block pitch; the offset must keep rails on their parity. |
| 1-tile gap between logistics zones isolates networks | Correct: squares that touch connect, so they must be at least 1 tile apart. |
| 4-way vs T-junctions, stations inside the block | Design advice, not a mechanic. The checker reports junction block lengths and whether a station plus its radius-13 entry curve fits the inner side. |

## Blueprint export

The City blocks tab exports one grid cell as a blueprint string (snap to grid
pitch x pitch, absolute snapping). The cell starts a junction's reach before the
block's grid corner, so it holds that junction, the tracks on its top and left
edges, and the block's buildings; every cell is identical, so pasting it into each
cell builds the whole network.

How 2.0 blueprints store rails was worked out from the blueprints in the game's
own files (`base/prototypes/tips-and-tricks-simulations.lua`,
`factoriopedia-simulations.lua`). With the tables in `src/rails/blueprint.ts`, all
1,764 rail ends in those blueprints meet another rail end, apart from open ends at
the edges, and the planner's 180° turn produces exactly the entities of the game's
own loop:

- `straight-rail` direction 0 runs north–south, 4 east–west, 2 NE–SW, 6 NW–SE.
- `half-diagonal-rail` 0, 2, 4, 6 run along headings 15, 1, 3, 5 (22.5° steps).
- `curved-rail-a` / `curved-rail-b`: direction 0 curves left leaving north, 2 curves
  right; each +4 rotates 90° clockwise. Curve-A ends sit at (0, 2) and (∓1, −3) from
  the entity position, curve-B ends at (∓2, −2) and (±1, 2).
- Rail signals: 1.5 tiles right of the track and half a tile past the joint; the
  blueprint direction is opposite to the direction trains travel.
- Train stops: 2 tiles right of the track, direction = travel direction.

Not yet confirmed in game: how `position-relative-to-grid` lines the cell up
with the world grid. If a pasted cell lands off by a few tiles, the cell's contents
are still right; only the grid offset needs adjusting.

## Drive-through station

Ticking **Drive-through station** adds one to every block. Trains on the top
corridor's eastbound track turn right into the block (a 90° A-B-B-A turn), stop on
a straight platform running south, then turn left onto the bottom corridor's
eastbound track, crossing its westbound track on the level. The platform is
`pitch − 28` tiles long (74 for a 102 block).

Signals: a rail signal lets trains onto the platform and a chain signal lets them
leave, because the exit merges and crosses. Wherever the track after a rail signal
is shorter than the train, the planner turns that signal into a chain signal so a
waiting train stays before the junction instead of inside it. The checks report
whether the platform holds the train and whether the fork and merge stay clear of
the corner junctions. Buildings that would sit on the new track are moved a few
tiles aside.
