// Roboport coverage for the layout editor: logistics (50x50) and construction
// (110x110) zones, and which roboports join one logistic network. The game rules
// live in src/cityblock/network.ts; this file maps placed buildings onto them.

import { components, constructionRect, logisticsRect, roboportsConnect, type Node } from '../cityblock/network';
import { ENTITIES } from './catalog';
import { entityRect, type PlacedEntity } from './model';
import type { ViewOverlay } from './renderer';

export const isRoboportName = (name: string) => ENTITIES[name]?.kind === 'roboport';

/** A placed building as a centre point. */
export function nodeOf(e: Pick<PlacedEntity, 'id' | 'name' | 'x' | 'y' | 'direction'>): Node {
  const r = entityRect(e as PlacedEntity);
  return { id: e.id, name: e.name, x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export interface RobotReport {
  roboports: Node[];
  /** Pairs of roboports whose networks join. */
  links: [Node, Node][];
  /** Logistic networks, largest first. */
  networks: Node[][];
}

export function analyseRobots(entities: readonly PlacedEntity[]): RobotReport {
  const roboports = entities.filter((e) => isRoboportName(e.name)).map(nodeOf);
  const links: [Node, Node][] = [];
  for (let i = 0; i < roboports.length; i++)
    for (let j = i + 1; j < roboports.length; j++) if (roboportsConnect(roboports[i], roboports[j])) links.push([roboports[i], roboports[j]]);
  return { roboports, links, networks: components(roboports, roboportsConnect) };
}

export const LOGISTICS_COLOR = 0xffa726;
export const CONSTRUCTION_COLOR = 0x5ec8ff;
const PREVIEW_COLOR = 0x9be37a;

/** Areas and link lines for roboports; `preview` is a roboport in hand or selected. */
export function robotOverlay(report: RobotReport, preview?: Node | null): Pick<ViewOverlay, 'areas' | 'lines' | 'dots'> {
  const areas: NonNullable<ViewOverlay['areas']> = [];
  const lines: NonNullable<ViewOverlay['lines']> = [];
  const dots: NonNullable<ViewOverlay['dots']> = [];
  const all = preview ? [...report.roboports.filter((r) => r.id !== preview.id), preview] : report.roboports;
  // Construction zones first (largest, faintest), then logistics zones on top.
  for (const n of all) {
    const c = constructionRect(n);
    if (c) areas.push({ ...c, color: n === preview ? PREVIEW_COLOR : CONSTRUCTION_COLOR, alpha: 0.04, outline: 1.5 });
  }
  for (const n of all) {
    const l = logisticsRect(n);
    if (l) areas.push({ ...l, color: n === preview ? PREVIEW_COLOR : LOGISTICS_COLOR, alpha: 0.1, outline: 2 });
  }
  for (const [a, b] of report.links) lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: LOGISTICS_COLOR, width: 2.5 });
  if (preview)
    for (const r of report.roboports)
      if (r.id !== preview.id && roboportsConnect(r, preview)) lines.push({ x1: preview.x, y1: preview.y, x2: r.x, y2: r.y, color: PREVIEW_COLOR, width: 3 });
  for (const n of all) dots.push({ x: n.x, y: n.y, color: n === preview ? PREVIEW_COLOR : LOGISTICS_COLOR, r: 4 });
  return { areas, lines, dots };
}
