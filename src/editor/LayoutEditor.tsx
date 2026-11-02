import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ENTITIES, HOTBAR_GROUPS, entityColor, isRotatable } from './catalog';
import {
  anchorForCursor,
  autoOrientOffshore,
  brushTiles,
  buildOccupancy,
  canPlace,
  lineTiles,
  newId,
  parseLayout,
  removeEntities,
  rotateEntity,
  setWater,
  starterLayout,
  tileKey,
  updateEntity,
  type Direction,
  type Layout,
  type PlacedEntity,
} from './model';
import { GridRenderer } from './renderer';
import './editor.css';

export type Tool =
  | { kind: 'select' }
  | { kind: 'build'; name: string }
  | { kind: 'water' }
  | { kind: 'land' }
  | { kind: 'erase' };

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

/** Where a click at tile cx,cy would put a building (offshore pumps snap to the shore). */
function resolvePlacement(layout: Layout, name: string, dir: Direction, cx: number, cy: number) {
  if (ENTITIES[name]?.kind === 'offshore-pump') {
    const snapped = autoOrientOffshore(buildOccupancy(layout.entities), new Set(layout.water), cx, cy, dir);
    if (snapped) return snapped;
  }
  return { ...anchorForCursor(name, dir, cx, cy), direction: dir };
}

export interface LayoutEditorProps {
  /** Optional per-entity badge text (e.g. "45/min") from the rate engine. */
  badges?: Record<string, string>;
  /** Called whenever the layout changes, so other panels can react. */
  onLayoutChange?: (layout: Layout) => void;
}

export function LayoutEditor({ badges, onLayoutChange }: LayoutEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GridRenderer | null>(null);

  const [layout, setLayoutState] = useState<Layout>(loadSaved);
  const [tool, setTool] = useState<Tool>({ kind: 'select' });
  const [direction, setDirection] = useState<Direction>(0);
  const [brush, setBrush] = useState(3);
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [message, setMessage] = useState<string>('');

  // Undo/redo history of whole layouts (cheap: arrays are shared structurally).
  const past = useRef<Layout[]>([]);
  const future = useRef<Layout[]>([]);

  // Latest values for the event handlers, which are bound once.
  const st = useRef({ layout, tool, direction, brush, selected, cursor });
  st.current = { layout, tool, direction, brush, selected, cursor };

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

  useEffect(() => {
    rendererRef.current?.setLayout(layout);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      /* ignore quota / private mode */
    }
    onLayoutChange?.(layout);
  }, [layout, onLayoutChange]);

  useEffect(() => rendererRef.current?.setSelection(selected ? [selected] : []), [selected, layout]);
  useEffect(() => rendererRef.current?.setBadges(badges ?? {}), [badges]);
  useEffect(() => setMessage(''), [tool]);

  // ---- ghost preview -------------------------------------------------------

  const occupancy = useMemo(() => buildOccupancy(layout.entities), [layout.entities]);
  const waterSet = useMemo(() => new Set(layout.water), [layout.water]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (!cursor) return r.setGhost({ items: [] });
    const [cx, cy] = cursor;
    if (tool.kind === 'build') {
      const { x, y, direction: d } = resolvePlacement(layout, tool.name, direction, cx, cy);
      const check = canPlace(occupancy, waterSet, tool.name, x, y, d);
      r.setGhost({ items: [{ name: tool.name, x, y, direction: d, ok: check.ok }] });
      setMessage(check.ok ? '' : check.reason);
    } else if (tool.kind === 'water' || tool.kind === 'land') {
      r.setGhost({ items: [], brush: { tiles: brushTiles(cx, cy, brush), color: tool.kind === 'water' ? 0x4fa3ff : 0x7fbf5f } });
    } else if (tool.kind === 'erase') {
      r.setGhost({ items: [], brush: { tiles: [[cx, cy]], color: 0xff4d4d } });
    } else r.setGhost({ items: [] });
  }, [cursor, tool, direction, brush, occupancy, waterSet, layout]);

  // ---- editing actions -----------------------------------------------------

  const tryPlace = useCallback(
    (name: string, x: number, y: number, dir: Direction, commit: boolean): string | null => {
      const cur = st.current.layout;
      const occ = buildOccupancy(cur.entities);
      const check = canPlace(occ, new Set(cur.water), name, x, y, dir);
      if (!check.ok) {
        setMessage(check.reason);
        return null;
      }
      const id = newId();
      const e: PlacedEntity = { id, name, x, y, direction: dir };
      apply({ ...cur, entities: [...cur.entities, e] }, commit);
      return id;
    },
    [apply],
  );

  const removeAt = useCallback(
    (tx: number, ty: number, commit: boolean) => {
      const cur = st.current.layout;
      const id = buildOccupancy(cur.entities).get(tileKey(tx, ty));
      if (!id) return false;
      apply(removeEntities(cur, [id]), commit);
      if (st.current.selected === id) setSelected(null);
      return true;
    },
    [apply],
  );

  const rotateHoveredOrSelected = useCallback(
    (reverse: boolean) => {
      const { tool: t, cursor: c, layout: cur, selected: sel } = st.current;
      if (t.kind === 'build') {
        if (!isRotatable(ENTITIES[t.name])) return;
        setDirection((d) => ((d + (reverse ? 3 : 1)) % 4) as Direction);
        return;
      }
      const id = (c && buildOccupancy(cur.entities).get(tileKey(c[0], c[1]))) || sel;
      if (!id) return;
      let next = rotateEntity(cur, id);
      if (reverse) next = rotateEntity(rotateEntity(next, id), id);
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
        const id = tryPlace(tl.name, p.x, p.y, p.direction, false);
        if (id) setMessage('');
        drag = { mode: 'build', name: tl.name, lastTile: t, lastId: id, dir, moved: false };
      } else if (tl.kind === 'water' || tl.kind === 'land') {
        past.current.push(st.current.layout);
        future.current = [];
        drag = { mode: 'paint', on: tl.kind === 'water' };
        paint(t[0], t[1], drag.on);
      } else {
        const id = buildOccupancy(st.current.layout.entities).get(tileKey(t[0], t[1])) ?? null;
        setSelected(id);
        if (!id) drag = { mode: 'pan', lastX: ev.clientX, lastY: ev.clientY };
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
        tryPlace(drag.name, p.x, p.y, p.direction, false);
        drag.lastTile = t;
      }
      drag.moved = true;
    };

    const onUp = (ev: PointerEvent) => {
      if (host.hasPointerCapture(ev.pointerId)) host.releasePointerCapture(ev.pointerId);
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
      } else if ((ev.ctrlKey || ev.metaKey) && k === 'y') {
        ev.preventDefault();
        redo();
      } else if (k === 'r') {
        rotateHoveredOrSelected(ev.shiftKey);
      } else if (k === 'q') {
        // Pipette: pick the hovered building, or empty the hand.
        const { cursor: c, layout: cur, tool: tl } = st.current;
        const id = c && buildOccupancy(cur.entities).get(tileKey(c[0], c[1]));
        const e = id ? cur.entities.find((x) => x.id === id) : undefined;
        if (e && !(tl.kind === 'build' && tl.name === e.name)) {
          setTool({ kind: 'build', name: e.name });
          setDirection(e.direction);
        } else setTool({ kind: 'select' });
      } else if (k === 'escape') {
        setTool({ kind: 'select' });
        setSelected(null);
      } else if (k === 'delete' || k === 'backspace') {
        const sel = st.current.selected;
        if (sel) {
          apply(removeEntities(st.current.layout, [sel]));
          setSelected(null);
        }
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
  }, [apply, redo, undo, removeAt, rotateHoveredOrSelected, tryPlace]);

  // ---- file actions --------------------------------------------------------

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

  return (
    <div className="editor">
      <aside className="editor-palette">
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
            <div className="palette-grid">
              {g.names.map((n) => {
                const def = ENTITIES[n];
                if (!def) return null;
                const active = tool.kind === 'build' && tool.name === n;
                return (
                  <button
                    key={n}
                    className={`palette-item${active ? ' active' : ''}`}
                    onClick={() => setTool(active ? { kind: 'select' } : { kind: 'build', name: n })}
                    title={`${def.displayName} (${def.width}×${def.height})`}
                  >
                    <span className="swatch" style={{ background: `#${entityColor(def).toString(16).padStart(6, '0')}` }} />
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
          {hand && (
            <span className="hand">
              Placing <b>{hand.displayName}</b>
              {isRotatable(hand) && <> facing {DIR_NAMES[direction]} (R)</>}
            </span>
          )}
        </div>
        <div className="editor-canvas" ref={hostRef} />
        <div className="editor-status">
          <span>{cursor ? `x ${cursor[0]}, y ${cursor[1]}` : ' '}</span>
          <span>{layout.entities.length} buildings · {layout.water.length} water tiles</span>
          <span className="msg">{message}</span>
          <span className="hint">Wheel zoom · Space/middle-drag pan · R rotate · Q pick · right-click remove</span>
        </div>
      </div>

      {sel && selDef && (
        <aside className="editor-inspector">
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
            {sel.recipe && (
              <>
                <dt>Recipe</dt>
                <dd>{sel.recipe}</dd>
              </>
            )}
          </dl>
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
        </aside>
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
