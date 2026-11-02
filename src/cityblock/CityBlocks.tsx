// City-block planner view: design one block, see it tiled 3x3 on the global grid
// with rails, junctions, signals, power and robot zones, and a list of checks.

import { useEffect, useMemo, useRef, useState } from 'react';
import { gameData } from '../data';
import { centreLine, type RailPiece } from '../rails/geometry';
import { signalPosition } from '../rails/signals';
import { analyse, buildDesign, DEFAULT_SPEC, gridBuildings, type BlockSpec, type Status } from './block';
import { constructionRect, logisticsRect, supplyRect, type Rect } from './network';
import './cityblock.css';

const STORAGE_KEY = 'factorio-planner.cityblock.v1';

interface Preset {
  label: string;
  spec: Partial<BlockSpec>;
  substations: number;
  roboports: number;
}

const PRESETS: Preset[] = [
  { label: '54x54 inner, 3x3 substations, 1 roboport', spec: { pitch: 66, corridor: 12, locomotives: 1, wagons: 2 }, substations: 3, roboports: 1 },
  { label: '90x90 inner, 5x5 substations, 2x2 roboports', spec: { pitch: 102, corridor: 12, locomotives: 1, wagons: 4 }, substations: 5, roboports: 2 },
  { label: '100 grid, 5x5 substations, 2x2 roboports', spec: { pitch: 100, corridor: 12, locomotives: 1, wagons: 4 }, substations: 5, roboports: 2 },
];

type Tool = 'substation' | 'roboport' | 'medium-electric-pole' | 'big-electric-pole' | 'erase';
const TOOLS: { id: Tool; label: string }[] = [
  { id: 'substation', label: 'Substation' },
  { id: 'roboport', label: 'Roboport' },
  { id: 'big-electric-pole', label: 'Big pole' },
  { id: 'medium-electric-pole', label: 'Medium pole' },
  { id: 'erase', label: 'Erase' },
];

type Layer = 'power' | 'wires' | 'logistics' | 'construction' | 'gaps' | 'signals';
const LAYERS: { id: Layer; label: string }[] = [
  { id: 'power', label: 'Supply areas' },
  { id: 'wires', label: 'Wires' },
  { id: 'logistics', label: 'Logistics zones' },
  { id: 'construction', label: 'Construction zones' },
  { id: 'gaps', label: 'Coverage gaps' },
  { id: 'signals', label: 'Signals' },
];

function initialSpec(): BlockSpec {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SPEC, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  const p = PRESETS[1];
  const spec = { ...DEFAULT_SPEC, ...p.spec };
  return { ...spec, buildings: gridBuildings(spec, p.substations, p.roboports) };
}

const STATUS_ICON: Record<Status, string> = { pass: '✓', warn: '!', fail: '✕', info: 'i' };

export function CityBlocks() {
  const [spec, setSpec] = useState<BlockSpec>(initialSpec);
  const [tool, setTool] = useState<Tool>('substation');
  const [layers, setLayers] = useState<Record<Layer, boolean>>({
    power: true, wires: true, logistics: true, construction: false, gaps: true, signals: true,
  });
  const [subN, setSubN] = useState(5);
  const [roboN, setRoboN] = useState(2);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(spec));
    } catch {
      /* ignore */
    }
  }, [spec]);

  const design = useMemo(() => buildDesign(spec), [spec]);
  const result = useMemo(() => analyse(design), [design]);

  const set = <K extends keyof BlockSpec>(k: K, v: BlockSpec[K]) => setSpec((s) => ({ ...s, [k]: v }));
  const num = (k: 'pitch' | 'offset' | 'trackSpacing' | 'corridor' | 'locomotives' | 'wagons', min: number, max: number, step = 1) => (
    <label className="cb-field">
      <span>{FIELD_LABEL[k]}</span>
      <input
        type="number" min={min} max={max} step={step} value={spec[k]}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) set(k, Math.max(min, Math.min(max, v)));
        }}
      />
    </label>
  );

  // ----- view -----
  const svgRef = useRef<SVGSVGElement>(null);
  const { area } = design;
  const size = area.x1 - area.x0;
  const [view, setView] = useState({ x: area.x0 - 4, y: area.y0 - 4, w: size + 8 });
  useEffect(() => setView({ x: area.x0 - 4, y: area.y0 - 4, w: size + 8 }), [area.x0, area.y0, size]);
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);

  const toWorld = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    const scale = view.w / Math.min(r.width, r.height);
    const ox = (r.width - Math.min(r.width, r.height)) / 2;
    const oy = (r.height - Math.min(r.width, r.height)) / 2;
    return { x: view.x + (clientX - r.left - ox) * scale, y: view.y + (clientY - r.top - oy) * scale, scale };
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) * 0.002);
    const w = Math.max(20, Math.min(size * 3, view.w * f));
    setView({ x: p.x - (p.x - view.x) * (w / view.w), y: p.y - (p.y - view.y) * (w / view.w), w });
  };

  const place = (wx: number, wy: number) => {
    const P = spec.pitch;
    const bx = Math.floor((wx - spec.offset) / P) * P + spec.offset;
    const by = Math.floor((wy - spec.offset) / P) * P + spec.offset;
    const rx = wx - bx;
    const ry = wy - by;
    if (tool === 'erase') {
      const idx = spec.buildings.findIndex((b) => {
        const e = gameData.entities[b.name];
        return Math.abs(b.x - rx) <= (e?.width ?? 1) / 2 && Math.abs(b.y - ry) <= (e?.height ?? 1) / 2;
      });
      if (idx >= 0) set('buildings', spec.buildings.filter((_, i) => i !== idx));
      return;
    }
    const e = gameData.entities[tool];
    const even = (e?.width ?? 1) % 2 === 0;
    const cx = even ? Math.round(rx) : Math.floor(rx) + 0.5;
    const cy = even ? Math.round(ry) : Math.floor(ry) + 0.5;
    set('buildings', [...spec.buildings, { name: tool, x: cx, y: cy }]);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    setHover({ x: Math.floor(p.x), y: Math.floor(p.y) });
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: d.vx - dx * p.scale, y: d.vy - dy * p.scale }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && e.button === 0) {
      const p = toWorld(e.clientX, e.clientY);
      place(p.x, p.y);
    }
  };

  const rect = (r: Rect, cls: string, key: string | number) => (
    <rect key={key} className={cls} x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} />
  );

  const lines = Array.from({ length: spec.tiles + 1 }, (_, k) => k * spec.pitch + spec.offset);
  const railPath = (p: RailPiece) => centreLine(p, p.type === 'straight-rail' ? 1 : 8).map((q, i) => `${i ? 'L' : 'M'}${q.x} ${q.y}`).join('');
  const railD = useMemo(() => design.pieces.map(railPath).join(''), [design]);

  const grouped = (['Grid', 'Rails', 'Trains', 'Power', 'Robots'] as const).map((g) => ({
    g, checks: result.checks.filter((c) => c.group === g),
  }));

  return (
    <div className="cb">
      <aside className="cb-side">
        <h3>Preset</h3>
        <select
          defaultValue=""
          onChange={(e) => {
            const p = PRESETS[Number(e.target.value)];
            if (!p) return;
            const s = { ...spec, ...p.spec };
            setSubN(p.substations);
            setRoboN(p.roboports);
            setSpec({ ...s, buildings: gridBuildings(s, p.substations, p.roboports) });
            e.target.value = '';
          }}
        >
          <option value="">Load a preset…</option>
          {PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
        </select>

        <h3>Global grid</h3>
        {num('pitch', 20, 256, 2)}
        {num('offset', -64, 64)}
        {num('corridor', 2, 64, 2)}
        {num('trackSpacing', 2, 16, 2)}
        <label className="cb-check">
          <input type="checkbox" checked={spec.junctions} onChange={(e) => set('junctions', e.target.checked)} />
          4-way junctions with all turns
        </label>
        <p className="cb-note">
          Blueprint: snap to grid {spec.pitch}x{spec.pitch}, absolute position, grid offset {spec.offset},{spec.offset}.
          Inner area {spec.pitch - spec.corridor}x{spec.pitch - spec.corridor}.
        </p>

        <h3>Train</h3>
        <div className="cb-pair">
          {num('locomotives', 1, 8)}
          {num('wagons', 0, 16)}
        </div>

        <h3>Buildings in one block</h3>
        <div className="cb-tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={tool === t.id ? 'active' : ''} onClick={() => setTool(t.id)}>{t.label}</button>
          ))}
        </div>
        <div className="cb-fill">
          <label>Substations <input type="number" min={0} max={12} value={subN} onChange={(e) => setSubN(Number(e.target.value))} />²</label>
          <label>Roboports <input type="number" min={0} max={6} value={roboN} onChange={(e) => setRoboN(Number(e.target.value))} />²</label>
          <button onClick={() => set('buildings', gridBuildings(spec, subN, roboN))}>Fill the inner area evenly</button>
          <button onClick={() => set('buildings', [])}>Clear</button>
        </div>
        <p className="cb-note">Click the map to place in every block at once; drag to pan, scroll to zoom.</p>

        <h3>Show</h3>
        <div className="cb-layers">
          {LAYERS.map((l) => (
            <label key={l.id} className="cb-check">
              <input type="checkbox" checked={layers[l.id]} onChange={(e) => setLayers((s) => ({ ...s, [l.id]: e.target.checked }))} />
              {l.label}
            </label>
          ))}
        </div>
      </aside>

      <div className="cb-main">
        <svg
          ref={svgRef}
          className="cb-map"
          viewBox={`${view.x} ${view.y} ${view.w} ${view.w}`}
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
        >
          <rect className="cb-ground" x={area.x0} y={area.y0} width={size} height={size} />
          {design.inner.map((r, i) => rect(r, i === design.centre ? 'cb-inner cb-inner-centre' : 'cb-inner', `in${i}`))}
          {layers.construction && design.nodes.map((n) => {
            const r = constructionRect(n);
            return r && rect(r, 'cb-construction', `c${n.id}`);
          })}
          {layers.logistics && design.nodes.map((n) => {
            const r = logisticsRect(n);
            return r && rect(r, 'cb-logistics', `l${n.id}`);
          })}
          {layers.power && design.nodes.map((n) => {
            const r = supplyRect(n);
            return r && rect(r, 'cb-supply', `p${n.id}`);
          })}
          {layers.gaps && result.logisticsGaps.map((r, i) => rect(r, 'cb-gap-logistics', `lg${i}`))}
          {layers.gaps && result.powerGaps.map((r, i) => rect(r, 'cb-gap-power', `pg${i}`))}
          {lines.map((L) => (
            <g key={`g${L}`} className="cb-gridline">
              <line x1={L} y1={area.y0} x2={L} y2={area.y1} />
              <line x1={area.x0} y1={L} x2={area.x1} y2={L} />
            </g>
          ))}
          <path className="cb-rail-bed" d={railD} />
          <path className="cb-rail" d={railD} />
          {layers.signals && design.signals.map((s) => {
            const p = signalPosition(s);
            return <circle key={s.id} className={s.kind === 'chain' ? 'cb-signal-chain' : 'cb-signal'} cx={p.x} cy={p.y} r={0.6} />;
          })}
          {layers.wires && result.wires.map(([a, b], i) => <line key={`w${i}`} className="cb-wire" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />)}
          {design.nodes.map((n) => {
            const e = gameData.entities[n.name];
            const w = e?.width ?? 1;
            const h = e?.height ?? 1;
            return <rect key={n.id} className={`cb-body cb-${e?.kind ?? 'x'}`} x={n.x - w / 2} y={n.y - h / 2} width={w} height={h} />;
          })}
        </svg>
        <div className="cb-status">
          {hover ? <span>Tile {hover.x}, {hover.y}</span> : <span>&nbsp;</span>}
          <span className="cb-legend">
            <i className="lg-rail" /> rails <i className="lg-chain" /> chain signal <i className="lg-signal" /> rail signal
            <i className="lg-supply" /> power <i className="lg-logi" /> logistics <i className="lg-gap" /> no power
          </span>
        </div>
      </div>

      <aside className="cb-checks">
        <h3>Checks for the middle block</h3>
        {grouped.map(({ g, checks }) => checks.length > 0 && (
          <section key={g}>
            <h4>{g}</h4>
            {checks.map((c) => (
              <div key={c.id} className={`cb-c cb-c-${c.status}`}>
                <span className="cb-c-icon">{STATUS_ICON[c.status]}</span>
                <div>
                  <div className="cb-c-title">{c.title}</div>
                  {c.detail && <div className="cb-c-detail">{c.detail}</div>}
                </div>
              </div>
            ))}
          </section>
        ))}
      </aside>
    </div>
  );
}

const FIELD_LABEL = {
  pitch: 'Grid size (block pitch)',
  offset: 'Grid offset',
  corridor: 'Rail corridor width',
  trackSpacing: 'Track spacing (centre to centre)',
  locomotives: 'Locomotives',
  wagons: 'Wagons',
} as const;
