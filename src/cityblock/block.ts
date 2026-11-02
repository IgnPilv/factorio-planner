// City-block planner: a global grid of identical square blocks separated by
// double-track rail corridors with 4-way junctions. Builds the rails, signals,
// substations and roboports for a 3x3 patch of blocks and checks that the design
// works when tiled: rails on the grid, junction signalling, power and robot
// coverage, and whether neighbouring blocks share power and logistic networks.

import { gameData } from '../data';
import {
  checkRails, path, straightRun, trainLength, carPitch, TURN_90, footprintTiles,
  type RailEnd, type RailPiece,
} from '../rails/geometry';
import { analyseSignals, type Signal } from '../rails/signals';
import {
  canWire, components, constructionRect, coverage, isPole, isRoboport, logisticsRect, roboportsConnect,
  supplyRect, type Node, type Rect,
} from './network';

export interface BlockSpec {
  /** Distance between grid lines (rail corridor centres): the blueprint grid size. */
  pitch: number;
  /** Where the grid lines sit: lines at x = k·pitch + offset (same for y). */
  offset: number;
  /** Centre-to-centre distance of the two tracks in a corridor. */
  trackSpacing: number;
  /** Width of the corridor kept free for rails and signals, centred on the grid line. */
  corridor: number;
  /** Add 4-way junctions (all left and right turns) where corridors cross. */
  junctions: boolean;
  /** Add a drive-through train station inside every block. */
  station: boolean;
  /** Train used for station and block-length checks. */
  locomotives: number;
  wagons: number;
  /** Buildings of one block, centres relative to the block's top-left grid corner. */
  buildings: { name: string; x: number; y: number }[];
  /** How many blocks along each side to tile for the cross-block checks (odd). */
  tiles: number;
}

export const DEFAULT_SPEC: BlockSpec = {
  pitch: 100,
  offset: 0,
  trackSpacing: 6,
  corridor: 12,
  junctions: true,
  station: false,
  locomotives: 1,
  wagons: 4,
  buildings: [],
  tiles: 3,
};

/** Spread n buildings evenly across [a, a+w): centres rounded to whole tiles (2x2 and 4x4 buildings). */
function spread(a: number, w: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + Math.round(((i + 0.5) * w) / n));
}

/** An n x n grid of substations and an m x m grid of roboports filling the inner area. */
export function gridBuildings(spec: Pick<BlockSpec, 'pitch' | 'corridor'>, substations: number, roboports: number) {
  const a = spec.corridor / 2;
  const w = spec.pitch - spec.corridor;
  const out: BlockSpec['buildings'] = [];
  const s = spread(a, w, substations);
  for (const x of s) for (const y of s) out.push({ name: 'substation', x, y });
  const r = spread(a, w, roboports);
  for (const x of r) for (const y of r) out.push({ name: 'roboport', x, y });
  return out;
}

export interface Design {
  spec: BlockSpec;
  /** The tiled area: [x0, x1) x [y0, y1). */
  area: Rect;
  /** Inner (buildable) area of every block. */
  inner: Rect[];
  /** Index into `inner` of the middle block, the one the checks focus on. */
  centre: number;
  pieces: RailPiece[];
  signals: Signal[];
  nodes: Node[];
  /** Distance from a junction centre to its entry and exit signals. */
  junctionReach: number;
  /** Train stops: the rail joint the train front stops at, and the travel heading. */
  stops: { x: number; y: number; dir: 0 | 4 | 8 | 12; block: string }[];
  /** Rail signals turned into chain signals because the block after them is shorter than a train. */
  chained: string[];
  /** Ids of the station's own rail pieces. */
  stationPieces: Set<string>;
  /** Per block station layout, when enabled (relative to the block's grid corner). */
  station?: StationLayout;
}

/**
 * A drive-through station: trains on the top corridor's eastbound track turn right
 * into the block, run south along the platform, and turn left onto the bottom
 * corridor's eastbound track (crossing its westbound track on the level).
 */
export interface StationLayout {
  /** Fork on the top eastbound track, relative to the block corner. */
  forkX: number;
  /** Platform track x and its first and last joint (y), relative to the block corner. */
  platformX: number;
  platformY0: number;
  platformY1: number;
  /** Usable length from the platform entry signal to the stop. */
  platformLength: number;
  /** Rightmost x the station's signals reach on the bottom corridor. */
  reachX: number;
}

export function stationLayout(spec: BlockSpec, reach: number): StationLayout {
  const h = spec.trackSpacing / 2;
  // Fork one joint after the corner junction's exit signal (signals stay off fork joints).
  const forkX = reach + 2;
  const platformX = forkX + 13;
  const platformY0 = h + 13;
  const platformY1 = spec.pitch + h - 13;
  return { forkX, platformX, platformY0, platformY1, platformLength: platformY1 - 2 - platformY0, reachX: platformX + 21 };
}

const rot = (dx: number, dy: number, q: number): [number, number] => {
  for (let i = 0; i < q; i++) [dx, dy] = [-dy, dx];
  return [dx, dy];
};

/** Lay the rails, signals and buildings of a tiles x tiles patch. */
export function buildDesign(spec: BlockSpec): Design {
  const { pitch: P, offset: o, tiles: n } = spec;
  const h = spec.trackSpacing / 2;
  const lines = Array.from({ length: n + 1 }, (_, k) => k * P + o);
  const lo = o;
  const hi = n * P + o;
  const area = { x0: lo, y0: lo, x1: hi, y1: hi };
  const pieces: RailPiece[] = [];
  const signals: Signal[] = [];
  let sid = 0;

  // Straight tracks: right-hand traffic. Each run starts on the joint parity its heading needs.
  const even = (v: number) => (Math.abs(v % 2) === 0 ? v : v + 1);
  for (const L of lines) {
    const y0 = even(lo);
    const count = Math.floor((hi - y0) / 2);
    pieces.push(...straightRun({ x: L + h, y: y0 + count * 2, dir: 0 }, count)); // northbound, east side
    pieces.push(...straightRun({ x: L - h, y: y0, dir: 8 }, count)); // southbound, west side
    pieces.push(...straightRun({ x: y0, y: L + h, dir: 4 }, count)); // eastbound, south side
    pieces.push(...straightRun({ x: y0 + count * 2, y: L - h, dir: 12 }, count)); // westbound, north side
  }

  // Junctions: from each approach a right turn (13 + h before the centre) and a left turn (13 - h before).
  const reach = 13 + h + 2;
  if (spec.junctions) {
    for (const X of lines) for (const Y of lines) {
      for (let q = 0; q < 4; q++) {
        const dir = q * 4;
        const at = (dx: number, dy: number): RailEnd => {
          const [rx, ry] = rot(dx, dy, q);
          return { x: X + rx, y: Y + ry, dir };
        };
        // Only build turns whose both ends stay inside the patch.
        const right = path(at(h, h + 13), TURN_90);
        const left = path(at(h, 13 - h), TURN_90.map(() => -1 as const));
        for (const t of [right, left]) {
          const e = t[t.length - 1]?.b;
          const s = t[0]?.a;
          if (!e || !s) continue;
          const inside = (p: { x: number; y: number }) => p.x >= lo && p.x <= hi && p.y >= lo && p.y <= hi;
          if (inside(e) && inside(s)) pieces.push(...t);
        }
        // Chain signal on the approach before the first fork, rail signal on the exit after the last merge.
        const entry = at(h, reach);
        const exit = at(h, -reach);
        if (entry.y >= lo && entry.y <= hi && entry.x >= lo && entry.x <= hi)
          signals.push({ id: `s${sid++}`, kind: 'chain', x: entry.x, y: entry.y, dir });
        if (exit.y >= lo && exit.y <= hi && exit.x >= lo && exit.x <= hi)
          signals.push({ id: `s${sid++}`, kind: 'rail', x: exit.x, y: exit.y, dir });
      }
    }
  }

  // Drive-through station in every block.
  const stops: Design['stops'] = [];
  const stationPieces = new Set<string>();
  const st = spec.station ? stationLayout(spec, reach) : undefined;
  if (st) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const bx = lines[i];
      const by = lines[j];
      const block = `b${i}.${j}`;
      const X = bx + st.platformX;
      const y0 = by + st.platformY0;
      const y1 = by + st.platformY1;
      const own = [
        ...path({ x: bx + st.forkX, y: by + h, dir: 4 }, TURN_90),
        ...straightRun({ x: X, y: y0, dir: 8 }, (y1 - y0) / 2),
        ...path({ x: X, y: y1, dir: 8 }, TURN_90.map(() => -1 as const)),
      ];
      own.forEach((p) => stationPieces.add(p.id));
      pieces.push(...own);
      const sig = (kind: 'rail' | 'chain', x: number, y: number, dir: number) => signals.push({ id: `s${sid++}`, kind, x, y, dir });
      // The fork shares the corner junction's exit joint; trains are let onto the
      // platform by a rail signal and leave it through a chain signal, since the
      // way out merges and crosses the bottom corridor. Short blocks are turned
      // into chain signals below.
      sig('rail', X, y0, 8);
      sig('chain', X, y1, 8);
      sig('chain', X + 17, by + P - h, 12);
      sig('rail', X + 21, by + P + h, 4);
      stops.push({ x: X, y: y1 - 2, dir: 8, block });
    }
  }

  // A rail signal whose block is shorter than the train would let a waiting train
  // stick back into the junction behind it: make it a chain signal so trains wait
  // before the junction instead.
  const train = trainLength(spec.locomotives + spec.wagons, carPitch(
    gameData.entities['cargo-wagon']?.jointDistance, gameData.entities['cargo-wagon']?.connectionDistance));
  const chained: string[] = [];
  if (spec.junctions || st) {
    for (let pass = 0; pass < 2; pass++) {
      const ids = new Set(analyseSignals(pieces, signals, train).issues.map((i) => i.signalId).filter(Boolean));
      if (ids.size === 0) break;
      for (const sg of signals) if (ids.has(sg.id) && sg.kind === 'rail') {
        sg.kind = 'chain';
        chained.push(sg.id);
      }
    }
  }

  const inner: Rect[] = [];
  const nodes: Node[] = [];
  const c = spec.corridor / 2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const bx = lines[i];
    const by = lines[j];
    inner.push({ x0: bx + c, y0: by + c, x1: bx + P - c, y1: by + P - c });
    spec.buildings.forEach((b, k) => nodes.push({ id: `b${i}.${j}.${k}`, name: b.name, x: bx + b.x, y: by + b.y }));
  }
  const centre = Math.floor(n / 2) * n + Math.floor(n / 2);
  return { spec, area, inner, centre, pieces, signals, nodes, junctionReach: reach, stops, station: st, chained, stationPieces };
}

// ---------- checks ----------

export type Status = 'pass' | 'warn' | 'fail' | 'info';

export interface Check {
  id: string;
  group: 'Grid' | 'Rails' | 'Power' | 'Robots' | 'Trains';
  status: Status;
  title: string;
  detail: string;
}

export interface Analysis {
  checks: Check[];
  /** Tiles of the centre block's inner area without power. */
  powerGaps: Rect[];
  logisticsGaps: Rect[];
  /** Pole pairs that can be wired. */
  wires: [Node, Node][];
  /** Rail tiles that cut into an inner area. */
  railInInner: number;
  powerGroups: Node[][];
  robotGroups: Node[][];
}

const pct = (a: number, b: number) => (b === 0 ? '100%' : `${((100 * a) / b).toFixed(1)}%`);
const blockIndexOf = (id: string) => id.split('.').slice(0, 2).join('.');
const centreId = (n: number) => `b${Math.floor(n / 2)}.${Math.floor(n / 2)}`;

/** Footprint rectangle of a building centred at a node. */
function bodyRect(nd: Node): Rect {
  const e = gameData.entities[nd.name];
  const w = (e?.width ?? 1) / 2;
  const h = (e?.height ?? 1) / 2;
  return { x0: nd.x - w, y0: nd.y - h, x1: nd.x + w, y1: nd.y + h };
}

export function analyse(d: Design): Analysis {
  const { spec } = d;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const h = spec.trackSpacing / 2;
  const P = spec.pitch;
  const cars = spec.locomotives + spec.wagons;
  const train = trainLength(cars, carPitch(
    gameData.entities['cargo-wagon']?.jointDistance, gameData.entities['cargo-wagon']?.connectionDistance));

  // ----- Grid -----
  add({
    id: 'pitch-even', group: 'Grid', status: P % 2 === 0 ? 'pass' : 'fail',
    title: `Block pitch ${P} is ${P % 2 === 0 ? 'even' : 'odd'}`,
    detail: 'Rails build on a 2x2 grid, so blocks must repeat every even number of tiles or the next block\'s rails land off the grid.',
  });
  const rails = checkRails(d.pieces);
  const offGrid = rails.issues.filter((i) => i.message.includes('off the 2x2'));
  add({
    id: 'rail-grid', group: 'Grid', status: offGrid.length ? 'fail' : 'pass',
    title: offGrid.length ? `${offGrid.length} rail ends are off the rail grid` : 'All rails sit on the 2x2 rail grid',
    detail: offGrid.length
      ? `North–south track centres must be on odd x and east–west on odd y. With grid lines at offset ${spec.offset} and tracks ±${h} from them, ${(spec.offset + h) % 2 === 0 ? 'the tracks land on even coordinates: change the track spacing by 2 or move the grid offset by 1' : 'the junction curves miss the joints: check the offset'}.`
      : `Track centres are on odd coordinates and every curve end lands on a rail joint. Blueprint settings: snap to grid ${P}x${P}, absolute position, offset ${spec.offset}.`,
  });

  // ----- Rails -----
  const edge = (p: { x: number; y: number }) =>
    p.x <= d.area.x0 || p.x >= d.area.x1 || p.y <= d.area.y0 || p.y >= d.area.y1;
  const dead = rails.deadEnds.filter((e) => !edge(e));
  add({
    id: 'dead-ends', group: 'Rails', status: dead.length ? 'fail' : 'pass',
    title: dead.length ? `${dead.length} dead ends inside the patch` : 'No dead ends (tracks continue into the next blocks)',
    detail: dead.length ? dead.slice(0, 5).map((e) => `(${e.x}, ${e.y})`).join(', ') : 'Every rail end connects to another piece.',
  });
  if (spec.junctions) {
    const sig = analyseSignals(d.pieces, d.signals, train);
    const bad = sig.issues.filter((i) => i.severity !== 'info');
    add({
      id: 'signals', group: 'Rails', status: bad.length ? 'warn' : 'pass',
      title: bad.length ? `${bad.length} signal problems` : 'Junctions use chain signals in, rail signals out',
      detail: bad.length ? [...new Set(bad.map((i) => i.message))].join(' ')
        : `Each junction is one block reaching ${d.junctionReach} tiles from its centre.` +
          (d.chained.length ? ` In the 3x3 patch, ${d.chained.length} exits are chain signals because the track after them is shorter than the train, so trains wait before the junction instead of inside it.` : ''),
    });
    const between = P - 2 * d.junctionReach;
    add({
      id: 'block-length', group: 'Trains', status: between >= train ? 'pass' : between > 0 ? 'warn' : 'fail',
      title: between > 0
        ? `${between} tiles of track between junctions, the ${spec.locomotives}-${spec.wagons} train needs ${train}`
        : 'Junctions overlap: the pitch is too small for two junctions',
      detail: between >= train
        ? 'A train waiting at the next junction fits between them without blocking the one behind it.'
        : `A ${spec.locomotives}-${spec.wagons} train stopped at a junction would stick back into the previous one, so those exits are chain signals: trains wait before the junction instead, which costs throughput. A pitch of at least ${2 * d.junctionReach + train} avoids it.`,
    });
  }
  const occupied = new Set<string>();
  const junctionTiles = new Set<string>();
  for (const p of d.pieces) for (const k of footprintTiles(p)) {
    occupied.add(k);
    if (!d.stationPieces.has(p.id)) junctionTiles.add(k);
  }
  const innerC = d.inner[d.centre];
  let railInInner = 0;
  for (const k of junctionTiles) {
    const [x, y] = k.split(',').map(Number);
    if (x >= innerC.x0 && x < innerC.x1 && y >= innerC.y0 && y < innerC.y1) railInInner++;
  }
  const corridorFits = h + 1 + 2 <= spec.corridor / 2; // rail half-width 1, signal 1.5 out plus its tile
  add({
    id: 'corridor', group: 'Rails', status: !corridorFits ? 'warn' : railInInner ? 'info' : 'pass',
    title: !corridorFits
      ? `Corridor ${spec.corridor} is too narrow for tracks ${spec.trackSpacing} apart plus signals`
      : railInInner ? `Junction curves use ${railInInner} tiles of each block's inner area` : 'Rails stay inside the corridor',
    detail: !corridorFits
      ? `Signals stand 1.5 tiles outside each track, so the corridor needs at least ${2 * (h + 3)} tiles.`
      : railInInner
        ? `A radius-13 turn reaches ${13 + h} tiles past the corridor centre line, so junction curves cut the corners of every inner area (corridor half-width is ${spec.corridor / 2}). Keep those corner tiles free of buildings.`
        : 'Nothing in the inner area is rail.',
  });
  const blocked = d.nodes.filter((nd) => {
    const r = bodyRect(nd);
    for (let x = Math.floor(r.x0); x < r.x1; x++) for (let y = Math.floor(r.y0); y < r.y1; y++) if (occupied.has(`${x},${y}`)) return true;
    return false;
  });
  if (spec.buildings.length)
    add({
      id: 'buildings-on-rails', group: 'Rails', status: blocked.length ? 'fail' : 'pass',
      title: blocked.length ? `${blocked.length} buildings overlap rails` : 'No building sits on a rail',
      detail: blocked.length ? [...new Set(blocked.map((b) => b.name))].join(', ') + ' must move off the track.' : '',
    });

  // ----- Power -----
  const poles = d.nodes.filter(isPole);
  const centreNodes = d.nodes.filter((nd) => blockIndexOf(nd.id) === centreId(spec.tiles));
  const cov = coverage(innerC, poles.map(supplyRect).filter((r): r is Rect => !!r));
  const wires: [Node, Node][] = [];
  for (let i = 0; i < poles.length; i++) for (let j = i + 1; j < poles.length; j++) if (canWire(poles[i], poles[j])) wires.push([poles[i], poles[j]]);
  const powerGroups = components(poles, canWire);
  const centrePoles = centreNodes.filter(isPole);
  if (centrePoles.length === 0) {
    add({ id: 'power', group: 'Power', status: 'warn', title: 'No electric poles in the block', detail: 'Add substations to check coverage and wiring.' });
  } else {
    add({
      id: 'power-coverage', group: 'Power', status: cov.covered === cov.total ? 'pass' : 'warn',
      title: `Power covers ${pct(cov.covered, cov.total)} of the inner area`,
      detail: cov.covered === cov.total ? 'Every tile of the inner area is inside a supply area.'
        : `${cov.total - cov.covered} tiles have no power (shown in red). A substation powers centre ±9 tiles.`,
    });
    const inBlock = components(centrePoles, canWire);
    add({
      id: 'power-wired', group: 'Power', status: inBlock.length === 1 ? 'pass' : 'fail',
      title: inBlock.length === 1 ? 'All poles in the block connect' : `Poles in the block form ${inBlock.length} separate networks`,
      detail: 'Poles connect when their centres are at most the smaller wire reach apart (substation 18).',
    });
    const crosses = powerGroups.some((g) => new Set(g.map((nd) => blockIndexOf(nd.id))).size > 1);
    const gapAcross = minGap(centrePoles, poles.filter((p) => blockIndexOf(p.id) !== centreId(spec.tiles)));
    add({
      id: 'power-neighbours', group: 'Power', status: crosses ? 'pass' : 'warn',
      title: crosses ? 'Power connects across block borders' : 'Power does not reach the neighbouring blocks',
      detail: crosses
        ? 'The tiled blocks form one electric network.'
        : `The nearest poles in neighbouring blocks are ${gapAcross.toFixed(1)} tiles apart; a substation wire reaches 18. Add a pole in the corridor (between the tracks, or a big pole) or move the edge substations out.`,
    });
  }

  // ----- Robots -----
  const ports = d.nodes.filter(isRoboport);
  const centrePorts = centreNodes.filter(isRoboport);
  const robotGroups = components(ports, roboportsConnect);
  const lcov = coverage(innerC, ports.map(logisticsRect).filter((r): r is Rect => !!r));
  if (centrePorts.length === 0) {
    add({ id: 'robots', group: 'Robots', status: 'info', title: 'No roboports in the block', detail: 'Add roboports to check logistics coverage and networks.' });
  } else {
    const blockRect = { x0: innerC.x0 - spec.corridor / 2, y0: innerC.y0 - spec.corridor / 2, x1: innerC.x1 + spec.corridor / 2, y1: innerC.y1 + spec.corridor / 2 };
    const ccov = coverage(blockRect, ports.map(constructionRect).filter((r): r is Rect => !!r));
    add({
      id: 'logistics-coverage', group: 'Robots', status: lcov.covered === lcov.total ? 'pass' : 'warn',
      title: `Logistics area covers ${pct(lcov.covered, lcov.total)} of the inner area`,
      detail: lcov.covered === lcov.total ? 'Every tile of the inner area is inside a logistics (orange) zone.'
        : `${lcov.total - lcov.covered} tiles are outside the 50x50 logistics zones (shown in orange). Chests there are not in the network.`,
    });
    add({
      id: 'construction-coverage', group: 'Robots', status: ccov.covered === ccov.total ? 'pass' : 'warn',
      title: `Construction area covers ${pct(ccov.covered, ccov.total)} of the block including rails`,
      detail: 'A roboport\'s construction zone is 110x110.',
    });
    const inBlock = components(centrePorts, roboportsConnect);
    add({
      id: 'robots-connected', group: 'Robots', status: inBlock.length === 1 ? 'pass' : 'fail',
      title: inBlock.length === 1 ? 'Roboports in the block form one network' : `Roboports in the block form ${inBlock.length} networks`,
      detail: 'Two roboports connect when their 50x50 logistics squares touch or overlap: centres at most 50 apart on both axes.',
    });
    const crosses = robotGroups.some((g) => new Set(g.map((nd) => blockIndexOf(nd.id))).size > 1);
    const others = ports.filter((p) => blockIndexOf(p.id) !== centreId(spec.tiles));
    const sep = minAxisGap(centrePorts, others);
    add({
      id: 'robots-neighbours', group: 'Robots', status: 'info',
      title: crosses ? 'One global robot network across blocks' : 'Each block has its own robot network',
      detail: crosses
        ? 'Neighbouring roboports touch, so bots can fly across the whole map for one item. For isolated blocks the logistics squares must not touch.'
        : `Logistics zones of neighbouring blocks are ${sep} tiles apart, so blocks stay isolated and trains move goods between them. Bots for construction still only work inside their own network.`,
    });
  }

  // ----- Trains / stations -----
  if (d.station) {
    const st = d.station;
    const fits = st.platformLength >= train;
    add({
      id: 'station-fit', group: 'Trains', status: fits ? 'pass' : 'fail',
      title: `Station platform ${st.platformLength} tiles, the ${spec.locomotives}-${spec.wagons} train needs ${train}`,
      detail: fits
        ? 'The whole train stops between the platform entry signal and the stop, clear of both corridors.'
        : `Make the block at least ${P + train - st.platformLength} tiles or use a shorter train.`,
    });
    const clear = !spec.junctions || st.reachX + 2 <= P - d.junctionReach;
    add({
      id: 'station-junction', group: 'Trains', status: clear ? 'pass' : 'fail',
      title: clear ? 'Station fork and merge stay clear of the junctions' : 'Station merge runs into the next junction',
      detail: clear
        ? `The station joins the corridor ${st.forkX} tiles after one junction and leaves its last signal ${P - d.junctionReach - st.reachX} tiles before the next.`
        : `The station's exit signals reach ${st.reachX} tiles into the block but the next junction starts at ${P - d.junctionReach}. Use a pitch of at least ${st.reachX + 2 + d.junctionReach}.`,
    });
  } else {
    const innerSide = P - spec.corridor;
    const need = train + 13 + 2; // a radius-13 turn into the block plus a signal joint
    add({
      id: 'station-fit', group: 'Trains', status: innerSide >= need ? 'pass' : 'fail',
      title: `A ${spec.locomotives}-${spec.wagons} station needs about ${need} tiles, the inner side is ${innerSide}`,
      detail: `The train is ${train} tiles (${cars} cars at ${carPitch()} tiles each, minus the last gap). Turning off the corridor takes a radius-13 curve, about 13 tiles, before the platform can start. Tick "Station" to lay one out.`,
    });
  }

  return { checks, powerGaps: cov.gaps, logisticsGaps: lcov.gaps, wires, railInInner, powerGroups, robotGroups };
}

function minGap(a: Node[], b: Node[]) {
  let best = Infinity;
  for (const p of a) for (const q of b) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
  return best;
}

/** Smallest gap between logistics squares of two groups of roboports (along the separating axis). */
function minAxisGap(a: Node[], b: Node[]) {
  let best = Infinity;
  for (const p of a) for (const q of b) {
    const rp = logisticsRect(p)!;
    const rq = logisticsRect(q)!;
    const gx = Math.max(rq.x0 - rp.x1, rp.x0 - rq.x1);
    const gy = Math.max(rq.y0 - rp.y1, rp.y0 - rq.y1);
    best = Math.min(best, Math.max(gx, gy));
  }
  return best;
}

/** Move buildings that would sit on the block's rails sideways off the track (smallest shift first). */
export function avoidRails(spec: BlockSpec, buildings: BlockSpec['buildings']): BlockSpec['buildings'] {
  const d = buildDesign({ ...spec, buildings: [] });
  const k = Math.floor(spec.tiles / 2);
  const corner = k * spec.pitch + spec.offset;
  const occupied = new Set<string>();
  for (const p of d.pieces) for (const t of footprintTiles(p)) occupied.add(t);
  const hits = (b: { name: string; x: number; y: number }) => {
    const r = bodyRect({ id: '', name: b.name, x: corner + b.x, y: corner + b.y });
    for (let x = Math.floor(r.x0) - 1; x < r.x1 + 1; x++)
      for (let y = Math.floor(r.y0) - 1; y < r.y1 + 1; y++) if (occupied.has(`${x},${y}`)) return true;
    return false;
  };
  const shifts: [number, number][] = [];
  for (let s = 1; s <= 8; s++) shifts.push([s, 0], [-s, 0], [0, s], [0, -s]);
  return buildings.flatMap((b) => {
    if (!hits(b)) return [b];
    for (const [dx, dy] of shifts) {
      const m = { ...b, x: b.x + dx, y: b.y + dy };
      if (!hits(m)) return [m];
    }
    return [];
  });
}
