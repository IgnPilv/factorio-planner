import { useEffect, useRef, useState } from 'react';
import { prettyName, type MapExport, type Surface } from './export/format';
import { MapRenderer, MAX_SCALE, MIN_SCALE, type View } from './map/renderer';
import { iconsVersion, subscribeIcons } from './icons';

export function fitView(s: Surface, width: number, height: number): View {
  const w = (s.maxCx - s.minCx + 1) * 32, h = (s.maxCy - s.minCy + 1) * 32;
  const scale = Math.min(4, Math.max(MIN_SCALE, Math.min(width / w, height / h) * 0.95));
  return { x: (s.minCx * 32 + w / 2), y: (s.minCy * 32 + h / 2), scale };
}

/** Start on the player's own buildings (median position), not the whole radar-charted area. */
export function homeView(map: MapExport, s: Surface, width: number, height: number): View {
  const xs: number[] = [], ys: number[] = [];
  for (let e = 0; e < s.count; e++) {
    if (s.force[e] !== map.playerForce) continue;
    xs.push(s.x[e]); ys.push(s.y[e]);
  }
  if (xs.length < 20) return fitView(s, width, height);
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const mid = xs.length >> 1;
  const fit = fitView(s, width, height);
  return { x: xs[mid], y: ys[mid], scale: Math.max(fit.scale, 2) };
}

interface Hover { x: number; y: number; tile?: string; entity?: string; recipe?: string }

export function MapView({ map, surface }: { map: MapExport; surface: Surface }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View | null>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const frame = useRef(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const [zoom, setZoom] = useState(1);

  const redraw = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const canvas = canvasRef.current, view = viewRef.current, r = rendererRef.current;
      if (!canvas || !view || !r) return;
      const dpr = window.devicePixelRatio || 1;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      r.draw(ctx, canvas.width, canvas.height, { ...view, scale: view.scale * dpr });
      setZoom(view.scale);
    });
  };

  // New surface: new renderer, fit to its explored area.
  useEffect(() => {
    rendererRef.current = new MapRenderer(map, surface);
    const canvas = canvasRef.current!;
    viewRef.current = homeView(map, surface, canvas.clientWidth || 800, canvas.clientHeight || 600);
    redraw();
  }, [map, surface]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => subscribeIcons(redraw), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the backing store matched to the element size and pixel ratio.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      redraw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pan with drag (mouse, pen or one finger), zoom with the wheel or two fingers.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; scale: number } | null = null;

    const world = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const v = viewRef.current!;
      return {
        x: v.x + (clientX - rect.left - rect.width / 2) / v.scale,
        y: v.y + (clientY - rect.top - rect.height / 2) / v.scale,
      };
    };
    const zoomAt = (clientX: number, clientY: number, factor: number) => {
      const v = viewRef.current!;
      const before = world(clientX, clientY);
      v.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const after = world(clientX, clientY);
      v.x += before.x - after.x;
      v.y += before.y - after.y;
      redraw();
    };
    const updateHover = (clientX: number, clientY: number) => {
      const r = rendererRef.current;
      if (!r) return;
      const w = world(clientX, clientY);
      const e = r.entityAt(w.x, w.y);
      const s = r.surface;
      const proto = e !== undefined ? map.protos[s.proto[e]] : undefined;
      const recipe = e !== undefined && s.recipe[e] ? map.recipes[s.recipe[e] - 1]?.name : undefined;
      setHover({ x: Math.floor(w.x), y: Math.floor(w.y), tile: r.tileAt(w.x, w.y), entity: proto?.name, recipe });
    };

    const down = (ev: PointerEvent) => {
      canvas.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: viewRef.current!.scale };
      }
    };
    const move = (ev: PointerEvent) => {
      const prev = pointers.get(ev.pointerId);
      if (!prev) { updateHover(ev.clientX, ev.clientY); return; }
      const v = viewRef.current!;
      if (pointers.size === 1) {
        v.x -= (ev.clientX - prev.x) / v.scale;
        v.y -= (ev.clientY - prev.y) / v.scale;
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        redraw();
      } else if (pointers.size === 2 && pinch) {
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinch.scale * (dist / pinch.dist)));
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, target / v.scale);
      }
    };
    const up = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
      zoomAt(ev.clientX, ev.clientY, Math.exp(-delta * 0.001));
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement) return;
      const v = viewRef.current!;
      const step = 120 / v.scale;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      switch (ev.key) {
        case 'ArrowLeft': case 'a': v.x -= step; break;
        case 'ArrowRight': case 'd': v.x += step; break;
        case 'ArrowUp': case 'w': v.y -= step; break;
        case 'ArrowDown': case 's': v.y += step; break;
        case '+': case '=': zoomAt(cx, cy, 1.5); return;
        case '-': zoomAt(cx, cy, 1 / 1.5); return;
        default: return;
      }
      redraw();
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => setHover(null));
    canvas.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', key);
    };
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomBy = (f: number) => {
    const v = viewRef.current!;
    v.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * f));
    redraw();
  };

  return (
    <div className="map-wrap">
      <canvas ref={canvasRef} className="map-canvas" data-icons={iconsVersion()} />
      <div className="map-controls">
        <button onClick={() => zoomBy(1.5)} aria-label="Zoom in">+</button>
        <button onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out">−</button>
        <button onClick={() => { const c = canvasRef.current!; viewRef.current = fitView(surface, c.clientWidth, c.clientHeight); redraw(); }}>Fit</button>
      </div>
      <div className="map-status">
        {hover ? (
          <>
            <span>[{hover.x}, {hover.y}]</span>
            {hover.entity && <b>{prettyName(hover.entity)}</b>}
            {hover.recipe && <span>making {prettyName(hover.recipe)}</span>}
            {hover.tile && <span className="dim">{prettyName(hover.tile)}</span>}
          </>
        ) : <span className="dim">Drag to move, scroll or pinch to zoom</span>}
        <span className="zoom">{zoom >= 1 ? `${zoom.toFixed(zoom < 10 ? 1 : 0)} px/tile` : `1:${(1 / zoom).toFixed(0)}`}</span>
      </div>
    </div>
  );
}
