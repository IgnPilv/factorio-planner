import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ENTITIES, HOTBAR_GROUPS, entityColor, isRotatable } from './catalog';
import {
  anchorForCursor,
  autoOrientOffshore,
  brushTiles,
  buildOccupancy,
  canPlace,
  clipboardAt,
  copyToClipboard,
  entitiesInBox,
  pasteClipboard,
  rotateClipboard,
  rotateGroup,
  type Clipboard,
  lineTiles,
  newId,
  parseLayout,
  removeEntities,
  rotateEntity,
  setWater,
  starterLayout,
  tileKey,
  updateEntity,
  addRails,
  layoutOccupancy,
  railsInBox,
  clipboardRailsAt,
  type Direction,
  type Layout,
  type PlacedEntity,
} from './model';
import { MachineSettings } from './MachineSettings';
import { BlueprintDialog, type BlueprintDialogMode } from './BlueprintDialog';
import { LibraryDialog } from './LibraryDialog';
import { loadDesigns, saveDesigns, type Design } from '../blueprint/library';
import { computeLayoutRates, simulateLayout, type ResearchState, type SteadyStateResult } from '../calc';
import { gameData } from '../data';
import { Bottlenecks, FlowState, MachineRates, SelectionFlows, PowerSummary, ProductionSummary, QuickSearch, SimSummary } from './Panels';
import { analysePower, poleInfo } from './power';
import { analyseRobots, isRoboportName, nodeOf, robotOverlay } from './robots';
import { computeUnlocks, entityUnlocked, recipeUnlocked } from './unlocks';
import type { SearchHit } from './search';
import { buildBadges, buildViewOverlay, type ViewMode } from './views';
import { GridRenderer } from './renderer';
import { entityContents } from './contents';
import { checkLayoutRails, type RailCheck } from './railCheck';
import { planRail, railFromPiece, railStartAt, signalAt, trainStopAt } from './rails';
import { newId as railId } from './model';
import type { RailEnd } from '../rails/geometry';
import { GameIcon, useIconsVersion } from '../ui/GameIcon';
import './editor.css';

export type Tool =
  | { kind: 'select' }
  | { kind: 'build'; name: string; recipe?: string; modules?: string[] }
  | { kind: 'water' }
  | { kind: 'land' }
  | { kind: 'erase' }
  | { kind: 'paste' }
  | { kind: 'rail' };

const STORAGE_KEY = 'factorio-planner.layout.v1';
const DIR_NAMES = ['north', 'east', 'south', 'west'];

function loadSaved(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return parseLayout(raw);
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return starterLayout();
}

/** Where a click at tile cx,cy would put a building (offshore pumps snap to the shore, signals and stops to track). */
function resolvePlacement(layout: Layout, name: string, dir: Direction, cx: number, cy: number): { x: number; y: number; direction: Direction; diagonal?: boolean } {
  const kind = ENTITIES[name]?.kind;
  if (kind === 'offshore-pump') {
    const snapped = autoOrientOffshore(layoutOccupancy(layout), new Set(layout.water), cx, cy, dir);
    if (snapped) return snapped;
  }
  if (kind === 'rail-signal' && layout.rails?.length) {
    const found = signalAt(layout.rails, cx, cy, dir);
    if (found) return { x: cx, y: cy, direction: found.direction as Direction, diagonal: found.diagonal || undefined };
  }
  if (kind === 'train-stop' && layout.rails?.length) {
    const p = trainStopAt(layout.rails, cx, cy, dir);
    if (p) return { x: p.x, y: p.y, direction: p.direction as Direction };
  }
  return { ...anchorForCursor(name, dir, cx, cy), direction: dir };
}

/**
 * Default research when none is passed in: every recipe unlocked, no rate
 * bonuses (techs that change rates stay off).
 */
const UNLOCK_ALL: ResearchState = Object.fromEntries(Object.values(gameData.technologies).filter((t) => !t.affectsRates).map((t) => [t.name, 1]));

function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(`factorio-planner.pref.${key}`);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: boolean) {
  try {
    localStorage.setItem(`factorio-planner.pref.${key}`, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

const VIEW_LABELS: Record<ViewMode, string> = { normal: 'Normal', electric: 'Electric', logistics: 'Logistics' };
const VIEW_ORDER: ViewMode[] = ['normal', 'electric', 'logistics'];

/** A whole map handed to the editor from another view (city blocks). */
export interface EditorIncoming {
  layout: Layout;
  note: string;
  /** Changes every time, so the same map can be sent twice. */
  seq: number;
}

export interface LayoutEditorProps {
  /** Called whenever the layout changes, so other panels can react. */
  onLayoutChange?: (layout: Layout) => void;
  /** Researched techs (from the research panel); changes machine rates and inserter hands. */
  research?: ResearchState;
  /** Replace the map with this one (undoable). */
  incoming?: EditorIncoming | null;
}

export function LayoutEditor({ onLayoutChange, research = UNLOCK_ALL, incoming }: LayoutEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GridRenderer | null>(null);

  const [layout, setLayoutState] = useState<Layout>(loadSaved);
  const [tool, setTool] = useState<Tool>({ kind: 'select' });
  const [direction, setDirection] = useState<Direction>(0);
  const [brush, setBrush] = useState(3);
  const [selection, setSelection] = useState<string[]>([]);
  const setSelected = useCallback((id: string | null) => setSelection(id ? [id] : []), []);
  const selected = selection.length === 1 ? selection[0] : null;
  const [clip, setClip] = useState<Clipboard | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  /** Rail tool: where the next track starts (null until the first click). */
  const [railFrom, setRailFrom] = useState<RailEnd | null>(null);
  const [message, setMessage] = useState<string>('');
  const [view, setView] = useState<ViewMode>('normal');
  const [showWires, setShowWires] = useState(() => readPref('wires', true));
  const [showContents, setShowContents] = useState(() => readPref('contents', true));
  const [showCoverage, setShowCoverage] = useState(() => readPref('coverage', false));
  const [bpDialog, setBpDialog] = useState<BlueprintDialogMode | null>(null);
  const [designs, setDesigns] = useState<Design[]>(() => loadDesigns());
  const [libraryOpen, setLibraryOpen] = useState(false);
  useEffect(() => saveDesigns(designs), [designs]);
  useEffect(() => writePref('wires', showWires), [showWires]);
  useEffect(() => writePref('contents', showContents), [showContents]);
  useEffect(() => writePref('coverage', showCoverage), [showCoverage]);
  const [showRobots, setShowRobots] = useState(() => readPref('robots', true));
  useEffect(() => writePref('robots', showRobots), [showRobots]);

  // Undo/redo history of whole layouts (cheap: arrays are shared structurally).
  const past = useRef<Layout[]>([]);
  const future = useRef<Layout[]>([]);

  // Latest values for the event handlers, which are bound once.
  const st = useRef({ layout, tool, direction, brush, selection, cursor, clip, railFrom });
  st.current = { layout, tool, direction, brush, selection, cursor, clip, railFrom };

  /** Apply a change; `commit` false merges into the current undo step (drag strokes). */
  const apply = useCallback((next: Layout, commit = true) => {
    const prev = st.current.layout;
    if (next === prev) return;
    if (commit) {
      past.current.push(prev);
      if (past.current.length > 200) past.current.shift();
      future.current = [];
    }
    st.current.layout = next;
    setLayoutState(next);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(st.current.layout);
    st.current.layout = prev;
    setLayoutState(prev);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(st.current.layout);
    st.current.layout = next;
    setLayoutState(next);
  }, []);

  // ---- renderer lifecycle --------------------------------------------------

  useEffect(() => {
    const host = hostRef.current!;
    const r = new GridRenderer();
    rendererRef.current = r;
    r.init(host).then(() => {
      if (rendererRef.current !== r) return;
      r.setLayout(st.current.layout);
      r.centerOn(-10, 0);
    });
    return () => {
      rendererRef.current = null;
      r.destroy();
    };
  }, []);

  const iconsVersion = useIconsVersion();
  useEffect(() => rendererRef.current?.refreshIcons(), [iconsVersion]);

  useEffect(() => {
    rendererRef.current?.setLayout(layout);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      /* ignore quota / private mode */
    }
    onLayoutChange?.(layout);
  }, [layout, onLayoutChange]);

  useEffect(() => rendererRef.current?.setSelection(selection), [selection, layout]);

  // A map sent from the City blocks view replaces this one; undo brings the old one back.
  const lastIncoming = useRef(0);
  useEffect(() => {
    if (!incoming || incoming.seq === lastIncoming.current) return;
    lastIncoming.current = incoming.seq;
    apply(incoming.layout);
    setSelection([]);
    const xs = incoming.layout.rails?.map((r) => r.x) ?? [0];
    const ys = incoming.layout.rails?.map((r) => r.y) ?? [0];
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const r = rendererRef.current;
    // The editor was hidden while the other view was open: size the canvas again before centring.
    requestAnimationFrame(() => {
      if (!r?.canvas) return;
      r.app.resize();
      r.camera.zoom = 0.25;
      r.centerOn(cx, cy);
    });
    setMessage(`Opened ${incoming.note}. Ctrl+Z goes back to your previous map.`);
  }, [incoming, apply]);
  // ---- rates, power and views ---------------------------------------------

  const rates = useMemo(() => computeLayoutRates(layout, gameData, research), [layout, research]);
  const unlocks = useMemo(() => computeUnlocks(research), [research]);
  const power = useMemo(() => analysePower(layout.entities, rates), [layout.entities, rates]);
  // The steady-state simulation is heavier (~0.2 s per 1,000 buildings), so run it after edits settle.
  const [sim, setSim] = useState<SteadyStateResult | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setSim(simulateLayout(layout, gameData, research));
      } catch (err) {
        console.error('simulation failed', err);
        setSim(null);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [layout, research]);
  useEffect(() => rendererRef.current?.setBadges(buildBadges(view, layout.entities, rates, sim)), [view, layout.entities, rates, sim]);
  useEffect(() => rendererRef.current?.setContents(showContents ? entityContents(layout.entities, sim) : {}), [layout.entities, sim, showContents]);
  // While a pole is in hand (or one is selected) show supply areas and the wires it would make.
  const polePreview = useMemo(() => {
    if (tool.kind === 'build' && ENTITIES[tool.name]?.kind === 'pole' && cursor) {
      const p = resolvePlacement(layout, tool.name, direction, cursor[0], cursor[1]);
      return poleInfo({ id: '__ghost', name: tool.name, ...p });
    }
    if (selected) {
      const e = layout.entities.find((x) => x.id === selected);
      if (e && ENTITIES[e.name]?.kind === 'pole') return poleInfo(e);
    }
    return null;
  }, [tool, cursor, direction, layout, selected]);
  const showPoleAreas = showCoverage || polePreview !== null;
  const robots = useMemo(() => analyseRobots(layout.entities), [layout.entities]);
  // Same for a roboport in hand or selected: its zones and the roboports it would join.
  const robotPreview = useMemo(() => {
    if (tool.kind === 'build' && isRoboportName(tool.name) && cursor) {
      const p = resolvePlacement(layout, tool.name, direction, cursor[0], cursor[1]);
      return nodeOf({ id: '__ghost', name: tool.name, ...p });
    }
    if (selected) {
      const e = layout.entities.find((x) => x.id === selected);
      if (e && isRoboportName(e.name)) return nodeOf(e);
    }
    return null;
  }, [tool, cursor, direction, layout, selected]);
  const railCheck = useMemo(() => checkLayoutRails(layout), [layout]);
  useEffect(() => {
    const overlay = buildViewOverlay(view, layout.entities, power, { polePreview, showPoleAreas, showWires, sim });
    if (railCheck) {
      // Track problems: orange dots at dead ends, red or yellow at signal and stop problems.
      const dots = [
        ...railCheck.deadEnds.map((p) => ({ x: p.x, y: p.y, color: 0xff9f1a, r: 5 })),
        ...railCheck.issues.map((i) => ({ x: i.at.x, y: i.at.y, color: i.severity === 'error' ? 0xff4d4d : 0xffd34d, r: 6 })),
      ];
      overlay.dots = [...(overlay.dots ?? []), ...dots];
    }
    if (showRobots || robotPreview) {
      const r = robotOverlay(robots, robotPreview);
      overlay.areas = [...(r.areas ?? []), ...(overlay.areas ?? [])];
      overlay.lines = [...(overlay.lines ?? []), ...(r.lines ?? [])];
      overlay.dots = [...(overlay.dots ?? []), ...(r.dots ?? [])];
    }
    rendererRef.current?.setView(overlay);
  }, [view, layout.entities, power, polePreview, showPoleAreas, showWires, sim, robots, robotPreview, showRobots, railCheck]);
  useEffect(() => {
    setMessage('');
    setRailFrom(null);
  }, [tool]);

  // ---- ghost preview -------------------------------------------------------

  const occupancy = useMemo(() => buildOccupancy(layout.entities, layout.rails), [layout.entities, layout.rails]);
  const waterSet = useMemo(() => new Set(layout.water), [layout.water]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (!cursor) return r.setGhost({ items: [] });
    const [cx, cy] = cursor;
    if (tool.kind === 'build') {
      const { x, y, direction: d, diagonal } = resolvePlacement(layout, tool.name, direction, cx, cy);
      const check = canPlace(occupancy, waterSet, tool.name, x, y, d);
      r.setGhost({ items: [{ name: tool.name, x, y, direction: d, diagonal, ok: check.ok }] });
      setMessage(check.ok ? '' : check.reason);
    } else if (tool.kind === 'water' || tool.kind === 'land') {
      r.setGhost({ items: [], brush: { tiles: brushTiles(cx, cy, brush), color: tool.kind === 'water' ? 0x4fa3ff : 0x7fbf5f } });
    } else if (tool.kind === 'erase') {
      r.setGhost({ items: [], brush: { tiles: [[cx, cy]], color: 0xff4d4d } });
    } else if (tool.kind === 'paste' && clip) {
      const items = clipboardAt(clip, cx, cy).map((e) => ({ ...e, ok: canPlace(occupancy, waterSet, e.name, e.x, e.y, e.direction).ok }));
      const rails = clipboardRailsAt(clip, cx, cy);
      r.setGhost({ items, rails: rails.length ? { rails, ok: true } : undefined });
      const blocked = items.filter((i) => !i.ok).length;
      setMessage(blocked ? `${blocked} of ${items.length} buildings blocked` : '');
    } else if (tool.kind === 'rail') {
      if (!railFrom) {
        r.setGhost({ items: [], railStart: railStartAt(layout.rails ?? [], cx, cy, direction * 4) });
        return;
      }
      const plan = planRail(railFrom, cx + 0.5, cy + 0.5).map((p) => railFromPiece(p, ''));
      const res = addRails({ ...layout, rails: [] }, plan);
      r.setGhost({ items: [], rails: { rails: plan, ok: res.blocked === 0 }, railStart: railFrom });
      setMessage(res.blocked ? `${res.blocked} rail piece${res.blocked === 1 ? '' : 's'} blocked by buildings or water` : '');
    } else r.setGhost({ items: [], box: box ?? undefined });
  }, [cursor, tool, direction, brush, occupancy, waterSet, layout, clip, box, railFrom]);

  // ---- editing actions -----------------------------------------------------

  /** Blueprint the selection, or the whole layout when nothing is selected. */
  const openBlueprintExport = useCallback(() => {
    const { layout: cur, selection: sel } = st.current;
    const chosen = sel.length ? cur.entities.filter((e) => sel.includes(e.id)) : cur.entities;
    const rails = sel.length ? (cur.rails ?? []).filter((r) => sel.includes(r.id)) : (cur.rails ?? []);
    if (!chosen.length && !rails.length) {
      setMessage('Nothing to blueprint yet: place some buildings first.');
      return;
    }
    setBpDialog({ kind: 'export', entities: chosen, rails, scope: sel.length ? 'selection' : 'layout' });
  }, []);

  const tryPlace = useCallback(
    (name: string, x: number, y: number, dir: Direction, commit: boolean, diagonal?: boolean): string | null => {
      const cur = st.current.layout;
      const occ = layoutOccupancy(cur);
      const check = canPlace(occ, new Set(cur.water), name, x, y, dir);
      if (!check.ok) {
        setMessage(check.reason);
        return null;
      }
      const id = newId();
      const t = st.current.tool;
      const e: PlacedEntity = { id, name, x, y, direction: dir };
      if (diagonal) e.diagonal = true;
      if (t.kind === 'build' && t.name === name) {
        if (t.recipe) e.recipe = t.recipe;
        if (t.modules?.length) e.modules = [...t.modules];
      }
      apply({ ...cur, entities: [...cur.entities, e] }, commit);
      return id;
    },
    [apply],
  );

  const removeAt = useCallback(
    (tx: number, ty: number, commit: boolean) => {
      const cur = st.current.layout;
      const id = layoutOccupancy(cur).get(tileKey(tx, ty));
      if (!id) return false;
      apply(removeEntities(cur, [id]), commit);
      if (st.current.selection.includes(id)) setSelection((s) => s.filter((x) => x !== id));
      return true;
    },
    [apply],
  );

  const rotateHoveredOrSelected = useCallback(
    (reverse: boolean) => {
      const { tool: t, cursor: c, layout: cur, selection: sel, clip: cb } = st.current;
      if (t.kind === 'build' || t.kind === 'rail') {
        if (t.kind === 'build' && !isRotatable(ENTITIES[t.name])) return;
        setDirection((d) => ((d + (reverse ? 3 : 1)) % 4) as Direction);
        return;
      }
      if (t.kind === 'paste' && cb) {
        let next = rotateClipboard(cb);
        if (reverse) next = rotateClipboard(rotateClipboard(next));
        setClip(next);
        return;
      }
      // A multi-selection turns as a group; otherwise the hovered building turns.
      const hovered = c && layoutOccupancy(cur).get(tileKey(c[0], c[1]));
      const ids = sel.length > 1 || !hovered ? sel : [hovered];
      if (!ids.length) return;
      let next = rotateGroup(cur, ids);
      if (reverse) next = rotateGroup(rotateGroup(next, ids), ids);
      if (next === cur) setMessage('No room to rotate');
      apply(next);
    },
    [apply],
  );

  // ---- pointer input -------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current!;
    let drag:
      | { mode: 'pan'; lastX: number; lastY: number }
      | { mode: 'build'; name: string; lastTile: [number, number]; lastId: string | null; dir: Direction; moved: boolean }
      | { mode: 'paint'; on: boolean }
      | { mode: 'erase' }
      | { mode: 'box'; x0: number; y0: number; add: boolean }
      | null = null;
    let spaceDown = false;

    const local = (ev: PointerEvent | WheelEvent) => {
      const rect = host.getBoundingClientRect();
      return [ev.clientX - rect.left, ev.clientY - rect.top] as const;
    };
    const tileAt = (ev: PointerEvent | WheelEvent): [number, number] | null => {
      const r = rendererRef.current;
      if (!r) return null;
      const [sx, sy] = local(ev);
      return r.screenToTile(sx, sy);
    };

    const paint = (tx: number, ty: number, on: boolean) => {
      const { layout: cur, brush: b } = st.current;
      apply(setWater(cur, brushTiles(tx, ty, b), on), false);
    };

    const onDown = (ev: PointerEvent) => {
      const t = tileAt(ev);
      if (!t) return;
      host.setPointerCapture(ev.pointerId);
      const { tool: tl, direction: dir } = st.current;
      if (ev.button === 1 || (ev.button === 0 && spaceDown)) {
        drag = { mode: 'pan', lastX: ev.clientX, lastY: ev.clientY };
        return;
      }
      if (ev.button === 2 && tl.kind === 'rail' && st.current.railFrom) {
        // Right-click while laying track drops the current start, like the game.
        setRailFrom(null);
        return;
      }
      if (ev.button === 2 || (ev.button === 0 && tl.kind === 'erase')) {
        // Right button removes, like mining in the game.
        past.current.push(st.current.layout);
        future.current = [];
        drag = { mode: 'erase' };
        removeAt(t[0], t[1], false);
        return;
      }
      if (ev.button !== 0) return;
      if (tl.kind === 'build') {
        past.current.push(st.current.layout);
        future.current = [];
        const p = resolvePlacement(st.current.layout, tl.name, dir, t[0], t[1]);
        const id = tryPlace(tl.name, p.x, p.y, p.direction, false, p.diagonal);
        if (id) setMessage('');
        drag = { mode: 'build', name: tl.name, lastTile: t, lastId: id, dir, moved: false };
      } else if (tl.kind === 'water' || tl.kind === 'land') {
        past.current.push(st.current.layout);
        future.current = [];
        drag = { mode: 'paint', on: tl.kind === 'water' };
        paint(t[0], t[1], drag.on);
      } else if (tl.kind === 'rail') {
        const cur = st.current.layout;
        const from = st.current.railFrom;
        if (!from) {
          setRailFrom(railStartAt(cur.rails ?? [], t[0], t[1], dir * 4));
          return;
        }
        const pieces = planRail(from, t[0] + 0.5, t[1] + 0.5);
        if (!pieces.length) return;
        const res = addRails(cur, pieces.map((p) => railFromPiece(p, railId())));
        if (res.blocked) {
          setMessage('Track blocked by buildings or water');
          return;
        }
        apply(res.layout);
        // Keep laying from where this track ended.
        setRailFrom(pieces[pieces.length - 1]!.b);
      } else if (tl.kind === 'paste') {
        const cb = st.current.clip;
        if (!cb) return;
        const res = pasteClipboard(st.current.layout, cb, t[0], t[1]);
        apply(res.layout);
        setMessage(res.blocked ? `Pasted ${res.placed.length}, ${res.blocked} blocked` : `Pasted ${res.placed.length} pieces`);
      } else {
        // Select: click picks a building (Shift adds), dragging draws a selection box.
        const id = layoutOccupancy(st.current.layout).get(tileKey(t[0], t[1])) ?? null;
        if (ev.shiftKey && id) setSelection((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
        else if (!ev.shiftKey) setSelected(id);
        drag = { mode: 'box', x0: t[0], y0: t[1], add: ev.shiftKey };
      }
    };

    const onMove = (ev: PointerEvent) => {
      const t = tileAt(ev);
      if (t) {
        const c = st.current.cursor;
        if (!c || c[0] !== t[0] || c[1] !== t[1]) setCursor(t);
      }
      if (!drag) return;
      if (drag.mode === 'pan') {
        rendererRef.current?.panBy(ev.clientX - drag.lastX, ev.clientY - drag.lastY);
        drag.lastX = ev.clientX;
        drag.lastY = ev.clientY;
        return;
      }
      if (!t) return;
      if (drag.mode === 'box') {
        if (t[0] !== drag.x0 || t[1] !== drag.y0) setBox({ x0: drag.x0, y0: drag.y0, x1: t[0], y1: t[1] });
        return;
      }
      if (drag.mode === 'paint') return paint(t[0], t[1], drag.on);
      if (drag.mode === 'erase') return void removeAt(t[0], t[1], false);
      // build drag
      const [lx, ly] = drag.lastTile;
      if (lx === t[0] && ly === t[1]) return;
      const def = ENTITIES[drag.name];
      const isBelt = def.kind === 'belt';
      if (def.width === 1 && def.height === 1) {
        // Lay a line of 1x1 entities; belts turn to follow the drag like in the game.
        const { tiles, direction: lineDir } = lineTiles(lx, ly, t[0], t[1]);
        const dir = isBelt ? lineDir : drag.dir;
        const lastId = drag.lastId;
        if (isBelt && lastId) {
          const cur = st.current.layout;
          const prev = cur.entities.find((e) => e.id === lastId);
          if (prev && prev.direction !== dir) apply(updateEntity(cur, prev.id, { direction: dir }), false);
        }
        for (const [x, y] of tiles.slice(1)) {
          const id = tryPlace(drag.name, x, y, dir, false);
          if (id) drag.lastId = id;
        }
        if (isBelt) setDirection(dir);
        drag.lastTile = [tiles[tiles.length - 1][0], tiles[tiles.length - 1][1]];
      } else {
        // Bigger buildings: place wherever the ghost fits as the cursor moves.
        const p = resolvePlacement(st.current.layout, drag.name, drag.dir, t[0], t[1]);
        tryPlace(drag.name, p.x, p.y, p.direction, false, p.diagonal);
        drag.lastTile = t;
      }
      drag.moved = true;
    };

    const onUp = (ev: PointerEvent) => {
      if (host.hasPointerCapture(ev.pointerId)) host.releasePointerCapture(ev.pointerId);
      if (drag?.mode === 'box') {
        const t = tileAt(ev);
        const d = drag;
        if (t && (t[0] !== d.x0 || t[1] !== d.y0)) {
          const cur = st.current.layout;
          const ids = [...entitiesInBox(cur.entities, d.x0, d.y0, t[0], t[1]), ...railsInBox(cur.rails, d.x0, d.y0, t[0], t[1])];
          setSelection((s) => (d.add ? [...new Set([...s, ...ids])] : ids));
        }
        setBox(null);
        drag = null;
        return;
      }
      if (drag && drag.mode !== 'pan') {
        // Drop the undo step if the stroke changed nothing.
        if (past.current[past.current.length - 1] === st.current.layout) past.current.pop();
      }
      drag = null;
    };

    const onLeave = () => setCursor(null);

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = rendererRef.current;
      if (!r) return;
      const [sx, sy] = local(ev);
      r.zoomAt(sx, sy, Math.exp(-ev.deltaY * 0.0015));
    };

    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (ev.type === 'keyup') {
        if (ev.code === 'Space') spaceDown = false;
        return;
      }
      const k = ev.key.toLowerCase();
      if (ev.code === 'Space') {
        spaceDown = true;
        ev.preventDefault();
      } else if ((ev.ctrlKey || ev.metaKey) && k === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) redo();
        else undo();
      } else if ((ev.ctrlKey || ev.metaKey) && (k === 'c' || k === 'x')) {
        const { selection: sel, layout: cur } = st.current;
        const ents = cur.entities.filter((e) => sel.includes(e.id));
        const cb = copyToClipboard(ents, (cur.rails ?? []).filter((r) => sel.includes(r.id)));
        if (!cb) return;
        ev.preventDefault();
        setClip(cb);
        if (k === 'x') {
          apply(removeEntities(cur, sel));
          setSelection([]);
        }
        setTool({ kind: 'paste' });
      } else if ((ev.ctrlKey || ev.metaKey) && k === 'v') {
        if (!st.current.clip) return;
        ev.preventDefault();
        setTool({ kind: 'paste' });
      } else if ((ev.ctrlKey || ev.metaKey) && k === 'b') {
        ev.preventDefault();
        openBlueprintExport();
      } else if ((ev.ctrlKey || ev.metaKey) && k === 'a') {
        ev.preventDefault();
        setSelection([...st.current.layout.entities.map((e) => e.id), ...(st.current.layout.rails ?? []).map((r) => r.id)]);
      } else if ((ev.ctrlKey || ev.metaKey) && k === 'y') {
        ev.preventDefault();
        redo();
      } else if (k === 'r') {
        rotateHoveredOrSelected(ev.shiftKey);
      } else if (k === 'q') {
        // Pipette: pick the hovered building, or empty the hand.
        const { cursor: c, layout: cur, tool: tl } = st.current;
        const id = c && layoutOccupancy(cur).get(tileKey(c[0], c[1]));
        const e = id ? cur.entities.find((x) => x.id === id) : undefined;
        if (id && !e && cur.rails?.some((r) => r.id === id)) {
          setTool(tl.kind === 'rail' ? { kind: 'select' } : { kind: 'rail' });
        } else if (e && !(tl.kind === 'build' && tl.name === e.name && tl.recipe === e.recipe)) {
          // Like the game's pipette, keep the recipe and modules of the picked machine.
          setTool({ kind: 'build', name: e.name, recipe: e.recipe, modules: e.modules });
          setDirection(e.direction);
        } else setTool({ kind: 'select' });
      } else if (k === 'escape') {
        if (st.current.tool.kind === 'rail' && st.current.railFrom) {
          setRailFrom(null);
          return;
        }
        setTool({ kind: 'select' });
        setSelected(null);
      } else if (k === 'delete' || k === 'backspace') {
        const sel = st.current.selection;
        if (sel.length) {
          apply(removeEntities(st.current.layout, sel));
          setSelection([]);
        }
      } else if (k === 'v' && !ev.ctrlKey && !ev.metaKey) {
        setView((v) => VIEW_ORDER[(VIEW_ORDER.indexOf(v) + 1) % VIEW_ORDER.length]);
      } else if (k === 'l' && !ev.ctrlKey && !ev.metaKey) {
        setShowWires((v) => !v);
      } else if (k === 'i' && !ev.ctrlKey && !ev.metaKey) {
        setShowContents((v) => !v);
      } else if (k === 'c' && !ev.ctrlKey && !ev.metaKey) {
        setShowCoverage((v) => !v);
      } else if (k === 'o' && !ev.ctrlKey && !ev.metaKey) {
        setShowRobots((v) => !v);
      } else if (k === 'w' && !ev.ctrlKey) setTool({ kind: 'water' });
      else if (k === 'e' && !ev.ctrlKey) setTool({ kind: 'erase' });
      else if (k === '[' || k === '-') setBrush((b) => Math.max(1, b - 1));
      else if (k === ']' || k === '=' || k === '+') setBrush((b) => Math.min(15, b + 1));
    };

    const onContext = (ev: Event) => ev.preventDefault();

    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onUp);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [apply, redo, undo, removeAt, rotateHoveredOrSelected, tryPlace, openBlueprintExport]);

  // Pasting a blueprint string anywhere outside a text field opens the import dialog.
  useEffect(() => {
    const onPaste = (ev: ClipboardEvent) => {
      if ((ev.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      const text = ev.clipboardData?.getData('text')?.trim();
      if (text && /^0eN[A-Za-z0-9+/=\s]+$/.test(text)) {
        ev.preventDefault();
        setBpDialog({ kind: 'import', initial: text });
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // ---- file actions --------------------------------------------------------

  const importBlueprint = (cb: Clipboard, note: string) => {
    setClip(cb);
    setTool({ kind: 'paste' });
    setBpDialog(null);
    setMessage(`Blueprint in hand: ${note}. Click to place, R to rotate.`);
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'factorio-layout.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    try {
      apply(parseLayout(await file.text()));
      setSelected(null);
      setMessage(`Loaded ${file.name}`);
    } catch (err) {
      setMessage(`Could not load ${file.name}: ${(err as Error).message}`);
    }
  };

  const sel = selected ? layout.entities.find((e) => e.id === selected) : undefined;
  const selDef = sel ? ENTITIES[sel.name] : undefined;
  const hand = tool.kind === 'build' ? ENTITIES[tool.name] : undefined;
  const handRecipe = tool.kind === 'build' && tool.recipe ? (gameData.recipes[tool.recipe]?.displayName ?? gameData.resources[tool.recipe]?.displayName) : undefined;

  const pickHit = (hit: SearchHit) => {
    setTool({ kind: 'build', name: hit.building, recipe: hit.recipe });
    setSelected(null);
  };

  return (
    <div className="editor">
      <aside className="editor-palette">
        <QuickSearch onPick={pickHit} unlocks={unlocks} />
        <div className="tool-row">
          <ToolButton active={tool.kind === 'select'} onClick={() => setTool({ kind: 'select' })} title="Select and pan (Esc)">Select</ToolButton>
          <ToolButton active={tool.kind === 'erase'} onClick={() => setTool({ kind: 'erase' })} title="Remove buildings (E, or right-click any time)">Remove</ToolButton>
        </div>
        <div className="palette-group">
          <h3>Terrain</h3>
          <div className="tool-row">
            <ToolButton active={tool.kind === 'water'} onClick={() => setTool({ kind: 'water' })} title="Paint water (W)">Water</ToolButton>
            <ToolButton active={tool.kind === 'land'} onClick={() => setTool({ kind: 'land' })} title="Paint land over water">Land</ToolButton>
          </div>
          {(tool.kind === 'water' || tool.kind === 'land') && (
            <label className="brush">
              Brush {brush}×{brush}
              <input type="range" min={1} max={15} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
            </label>
          )}
        </div>
        {HOTBAR_GROUPS.map((g) => (
          <div className="palette-group" key={g.title}>
            <h3>{g.title}</h3>
            {g.title === 'Trains' && (
              <div className="tool-row">
                <ToolButton
                  active={tool.kind === 'rail'}
                  onClick={() => setTool(tool.kind === 'rail' ? { kind: 'select' } : { kind: 'rail' })}
                  title="Lay track: click to start (or continue a track end), click again to build up to the cursor. R turns the start, Esc or right-click drops it."
                >
                  Rail
                </ToolButton>
              </div>
            )}
            <div className="palette-grid">
              {g.names.map((n) => {
                const def = ENTITIES[n];
                if (!def) return null;
                const active = tool.kind === 'build' && tool.name === n;
                const locked = !entityUnlocked(unlocks, n);
                return (
                  <button
                    key={n}
                    className={`palette-item${active ? ' active' : ''}${locked ? ' locked' : ''}`}
                    disabled={locked && !active}
                    onClick={() => setTool(active ? { kind: 'select' } : { kind: 'build', name: n })}
                    title={`${def.displayName} (${def.width}×${def.height})${locked ? ': not researched yet' : ''}`}
                  >
                    <span className="swatch" style={{ background: `#${entityColor(def).toString(16).padStart(6, '0')}` }}>
                      <GameIcon name={n} kind="entity" size={28} className="" />
                    </span>
                    <span className="palette-name">{def.displayName}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </aside>

      <div className="editor-main">
        <div className="editor-toolbar">
          <button onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)">Undo</button>
          <button onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Shift+Z)">Redo</button>
          <span className="sep" />
          <button onClick={exportJson}>Export</button>
          <button onClick={() => fileInput.current?.click()}>Import</button>
          <span className="sep" />
          <button onClick={openBlueprintExport} title="Copy the selection (or the whole layout) as a Factorio blueprint string (Ctrl+B)">
            {selection.length ? 'Blueprint selection' : 'Blueprint all'}
          </button>
          <button onClick={() => setBpDialog({ kind: 'import' })} title="Paste a blueprint string from Factorio (or just Ctrl+V it)">
            Import blueprint
          </button>
          <button onClick={() => setLibraryOpen(true)} title="Saved designs and blueprint books">
            Designs{designs.length ? ` (${designs.length})` : ''}
          </button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
          <button
            onClick={() => {
              apply(starterLayout());
              setSelected(null);
            }}
            title="Start over with an empty map and a small lake"
          >
            New map
          </button>
          <span className="sep" />
          <span className="view-switch" title="Switch view (V)">
            {VIEW_ORDER.map((v) => (
              <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
                {VIEW_LABELS[v]}
              </button>
            ))}
          </span>
          <label className="toggle" title="Show what belts, inserters and chests carry, like the game's alt-mode (needs game icons; I)">
            <input type="checkbox" checked={showContents} onChange={(e) => setShowContents(e.target.checked)} /> Contents
          </label>
          <label className="toggle" title="Show copper wires between electric poles (L)">
            <input type="checkbox" checked={showWires} onChange={(e) => setShowWires(e.target.checked)} /> Wires
          </label>
          <label className="toggle" title="Show the area each electric pole powers (C)">
            <input type="checkbox" checked={showCoverage} onChange={(e) => setShowCoverage(e.target.checked)} /> Coverage
          </label>
          <label className="toggle" title="Show roboport logistics (50x50, orange) and construction (110x110, blue) zones and which roboports connect (O)">
            <input type="checkbox" checked={showRobots} onChange={(e) => setShowRobots(e.target.checked)} /> Roboports
          </label>
          <span className="sep" />
          {tool.kind === 'paste' && clip && (
            <span className="hand">
              Pasting <b>{clip.entities.length}</b> buildings{clip.rails?.length ? <> and <b>{clip.rails.length}</b> rails</> : null} (R rotate, Esc cancel)
            </span>
          )}
          {tool.kind === 'rail' && (
            <span className="hand">
              {railFrom ? <>Laying track: click to build up to the cursor (Esc to stop)</> : <>Rail: click to start heading {DIR_NAMES[direction]} (R), or click a track end</>}
            </span>
          )}
          {hand && (
            <span className="hand">
              Placing <b>{hand.displayName}</b>
              {handRecipe && <> making <b>{handRecipe}</b></>}
              {isRotatable(hand) && <> facing {DIR_NAMES[direction]} (R)</>}
            </span>
          )}
        </div>
        <div className="editor-canvas" ref={hostRef} />
        <div className="editor-status">
          <span>{cursor ? `x ${cursor[0]}, y ${cursor[1]}` : ' '}</span>
          <span>
            {layout.entities.length} buildings{layout.rails?.length ? ` · ${layout.rails.length} rails` : ''} · {layout.water.length} water tiles
            {robots.roboports.length > 0 && ` · ${robots.roboports.length} roboports in ${robots.networks.length} network${robots.networks.length === 1 ? '' : 's'}`}
          </span>
          <span className="msg">{message}</span>
          <span className="hint">/ search · V view · O roboports · I contents · drag to select · Ctrl+C/V copy · R rotate · Q pick · right-click remove · Space-drag pan</span>
        </div>
      </div>

      <aside className="editor-inspector">
        {sel && selDef ? (
          <>
            <h3>{selDef.displayName}</h3>
            <dl>
              <dt>Position</dt>
              <dd>{sel.x}, {sel.y}</dd>
              <dt>Size</dt>
              <dd>{selDef.width}×{selDef.height}</dd>
              {isRotatable(selDef) && (
                <>
                  <dt>Facing</dt>
                  <dd>{DIR_NAMES[sel.direction]}</dd>
                </>
              )}
            </dl>
            {(!entityUnlocked(unlocks, sel.name) || (sel.recipe && gameData.recipes[sel.recipe] && !recipeUnlocked(unlocks, sel.recipe))) && (
              <p className="locked-note">Not researched yet with the current research settings.</p>
            )}
            <MachineSettings entity={sel} def={selDef} unlocks={unlocks} onChange={(patch) => apply(updateEntity(layout, sel.id, patch))} />
            <FlowState state={sim?.entities[sel.id]} transport={sim?.transport[sel.id]} />
            <MachineRates rate={rates[sel.id]} status={power.status[sel.id]} />
            <div className="tool-row">
              {isRotatable(selDef) && <button onClick={() => apply(rotateEntity(layout, sel.id))}>Rotate</button>}
              <button
                onClick={() => {
                  apply(removeEntities(layout, [sel.id]));
                  setSelected(null);
                }}
              >
                Remove
              </button>
            </div>
            <a href={selDef.wikiUrl} target="_blank" rel="noreferrer">Wiki page</a>
          </>
        ) : selection.length > 1 ? (
          <>
            <h3>{selection.length} selected</h3>
            <p className="muted small">Ctrl+C copy · Ctrl+X cut · R rotate · Delete remove · Shift+click to add or drop one</p>
            <div className="tool-row">
              <button onClick={() => apply(rotateGroup(layout, selection))}>Rotate</button>
              <button
                onClick={() => {
                  setClip(copyToClipboard(layout.entities.filter((e) => selection.includes(e.id)), (layout.rails ?? []).filter((r) => selection.includes(r.id))));
                  setTool({ kind: 'paste' });
                }}
              >
                Copy
              </button>
              <button onClick={openBlueprintExport} title="Copy as a Factorio blueprint string (Ctrl+B)">Blueprint</button>
              <button onClick={() => setLibraryOpen(true)} title="Save the selection as a named design">Save design</button>
              <button
                onClick={() => {
                  apply(removeEntities(layout, selection));
                  setSelection([]);
                }}
              >
                Remove
              </button>
            </div>
            <SelectionCounts ids={selection} entities={layout.entities} rails={layout.rails} />
            <SelectionFlows sim={sim} ids={selection} />
          </>
        ) : (
          <>
            <h3>Factory</h3>
            <PowerSummary power={power} />
            <SimSummary sim={sim} />
            <Bottlenecks sim={sim} entities={layout.entities} onSelect={setSelection} />
            {railCheck && <RailSummary check={railCheck} onSelect={(id) => setSelection([id])} />}
            <ProductionSummary rates={rates} />
            {layout.entities.length === 0 && <p className="muted">Pick a building on the left, or press / to search.</p>}
          </>
        )}
      </aside>
      {bpDialog && <BlueprintDialog mode={bpDialog} onClose={() => setBpDialog(null)} onImport={importBlueprint} />}
      {libraryOpen && (
        <LibraryDialog
          designs={designs}
          onChange={setDesigns}
          selection={layout.entities.filter((e) => selection.includes(e.id))}
          selectionRails={(layout.rails ?? []).filter((r) => selection.includes(r.id))}
          onPlace={(cb, name) => {
            setLibraryOpen(false);
            importBlueprint(cb, `"${name}", ${cb.entities.length} buildings${cb.rails?.length ? `, ${cb.rails.length} rails` : ''}`);
          }}
          onClose={() => setLibraryOpen(false)}
        />
      )}
    </div>
  );
}

function ToolButton(props: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button className={`tool${props.active ? ' active' : ''}`} onClick={props.onClick} title={props.title}>
      {props.children}
    </button>
  );
}

function SelectionCounts({ ids, entities, rails = [] }: { ids: string[]; entities: PlacedEntity[]; rails?: Layout['rails'] }) {
  const counts = new Map<string, number>();
  const set = new Set(ids);
  for (const e of entities) if (set.has(e.id)) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const nRails = rails.filter((r) => set.has(r.id)).length;
  if (nRails) counts.set('rail', nRails);
  return (
    <ul className="flow-list">
      {[...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => (
        <li key={name}>
          {n} × {name === 'rail' ? 'Rail' : (ENTITIES[name]?.displayName ?? name)}
        </li>
      ))}
    </ul>
  );
}

function RailSummary({ check, onSelect }: { check: RailCheck; onSelect: (id: string) => void }) {
  const shown = check.issues.slice(0, 8);
  return (
    <section className="rail-summary">
      <h4>Track</h4>
      <p className="small">
        {check.pieces} rail piece{check.pieces === 1 ? '' : 's'} · {check.signals} signal{check.signals === 1 ? '' : 's'} · {check.blocks} block{check.blocks === 1 ? '' : 's'}
        {check.deadEnds.length > 0 && <> · <span className="warn">{check.deadEnds.length} dead end{check.deadEnds.length === 1 ? '' : 's'}</span> (orange dots)</>}
      </p>
      {shown.length > 0 && (
        <ul className="flow-list small">
          {shown.map((i, n) => (
            <li key={n} className={i.severity === 'error' ? 'warn' : undefined}>
              {i.entityId ? (
                <button className="linklike" onClick={() => onSelect(i.entityId!)}>
                  {i.message}
                </button>
              ) : (
                <>
                  {i.message} at {i.at.x}, {i.at.y}
                </>
              )}
            </li>
          ))}
          {check.issues.length > shown.length && <li className="muted">and {check.issues.length - shown.length} more</li>}
        </ul>
      )}
      {check.issues.length === 0 && check.pieces > 0 && <p className="small muted">Signals and stops sit correctly. Rule used: chain signal into a junction, rail signal out.</p>}
    </section>
  );
}
