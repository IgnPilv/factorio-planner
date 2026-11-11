// Draws one surface of an export on a 2D canvas.
//
// Zoomed out, the map is a picture at one pixel per tile, like the in-game map:
// tile colours with each entity's footprint filled in its map colour. Those
// pictures are built lazily per "region" (8 x 8 chunks) and cached. Zoomed in,
// entities are drawn one by one on top, with their icons once the player has
// loaded them from their game folder.

import { forceClass, type MapExport, type Proto, type Surface } from '../export/format';
import { iconBitmap } from '../icons';

const REGION = 8; // chunks per region side
const REGION_TILES = REGION * 32;

export interface View {
  /** World position (tiles) at the canvas centre. */
  x: number;
  y: number;
  /** Screen pixels per tile. */
  scale: number;
}

export const MIN_SCALE = 1 / 16;
export const MAX_SCALE = 96;
/** From this zoom on, entities are drawn individually. */
const DETAIL_SCALE = 6;
const ICON_SCALE = 12;

const RAILS = new Set([
  'straight-rail', 'curved-rail-a', 'curved-rail-b', 'half-diagonal-rail', 'legacy-straight-rail',
  'legacy-curved-rail', 'elevated-straight-rail', 'elevated-curved-rail-a', 'elevated-curved-rail-b',
  'elevated-half-diagonal-rail', 'rail-ramp',
]);
const DIRECTIONAL = new Set([
  'transport-belt', 'underground-belt', 'splitter', 'loader', 'loader-1x1', 'lane-splitter',
  'linked-belt', 'inserter', 'pump', 'offshore-pump', 'train-stop', 'rail-signal', 'rail-chain-signal',
]);
const ROUND = new Set(['tree', 'plant', 'simple-entity', 'fish', 'asteroid']);
const VEHICLES = new Set(['car', 'spider-vehicle', 'locomotive', 'cargo-wagon', 'infinity-cargo-wagon', 'fluid-wagon', 'artillery-wagon']);
/** Not drawn on the overview picture (they are drawn in detail view only). */
const NOT_ON_MAP = new Set(['tree', 'plant', 'simple-entity', 'fish', 'asteroid', 'cliff']);

type RGB = [number, number, number];

/** Footprint of entity e in tiles: [left, top, width, height]. */
export function footprint(proto: Proto, x: number, y: number, dir: number): [number, number, number, number] {
  let w = proto.w, h = proto.h;
  if (RAILS.has(proto.type)) { w = 2; h = 2; }
  else if (VEHICLES.has(proto.type)) {
    // Orientation in 1/64 turns; rotate the box only for roughly sideways vehicles.
    const sideways = Math.round(dir / 16) % 2 === 1;
    if (sideways) [w, h] = [h, w];
  } else if (dir === 4 || dir === 12) [w, h] = [h, w];
  return [x - w / 2, y - h / 2, w, h];
}

export class MapRenderer {
  private regions = new Map<string, HTMLCanvasElement>();
  private colors: { own: string; enemy: string; neutral: string }[];

  constructor(readonly map: MapExport, readonly surface: Surface) {
    const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
    this.colors = map.protos.map((p) => ({
      own: css(p.own), enemy: css(p.enemy), neutral: css(p.neutral),
    }));
  }

  private entityColor(e: number): string {
    const c = this.colors[this.surface.proto[e]];
    if (!c) return '#888';
    return c[forceClass(this.map, this.surface.force[e])];
  }

  private region(rx: number, ry: number): HTMLCanvasElement | undefined {
    const key = `${rx},${ry}`;
    const cached = this.regions.get(key);
    if (cached) return cached;
    const s = this.surface;
    const chunks = [];
    for (let cy = ry * REGION; cy < (ry + 1) * REGION; cy++)
      for (let cx = rx * REGION; cx < (rx + 1) * REGION; cx++) {
        const c = s.chunks.get(`${cx},${cy}`);
        if (c) chunks.push(c);
      }
    if (!chunks.length) return undefined;

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = REGION_TILES;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(REGION_TILES, REGION_TILES);
    const px = img.data;
    const tiles = this.map.tiles;
    for (const c of chunks) {
      const ox = (c.cx - rx * REGION) * 32, oy = (c.cy - ry * REGION) * 32;
      for (let t = 0; t < 1024; t++) {
        const color = tiles[c.tiles[t]]?.color ?? [0, 0, 0];
        const i = ((oy + (t >> 5)) * REGION_TILES + ox + (t & 31)) * 4;
        px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Entities whose centre is in this region or one chunk around it (big ones overlap edges).
    const x0 = rx * REGION_TILES, y0 = ry * REGION_TILES;
    for (let cy = ry * REGION - 1; cy <= (ry + 1) * REGION; cy++)
      for (let cx = rx * REGION - 1; cx <= (rx + 1) * REGION; cx++) {
        const c = s.chunks.get(`${cx},${cy}`);
        if (!c) continue;
        for (const e of c.entities) {
          const proto = this.map.protos[s.proto[e]];
          if (!proto || NOT_ON_MAP.has(proto.type)) continue;
          const [l, t, w, h] = footprint(proto, s.x[e], s.y[e], s.dir[e]);
          ctx.fillStyle = this.entityColor(e);
          ctx.fillRect(Math.round(l - x0), Math.round(t - y0), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
        }
      }
    this.regions.set(key, canvas);
    return canvas;
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number, view: View) {
    const { scale } = view;
    ctx.save();
    ctx.fillStyle = '#0b0c0e';
    ctx.fillRect(0, 0, width, height);
    // World -> screen: sx = (wx - view.x) * scale + width / 2
    const left = view.x - width / 2 / scale, top = view.y - height / 2 / scale;
    const right = view.x + width / 2 / scale, bottom = view.y + height / 2 / scale;
    const toX = (wx: number) => (wx - left) * scale;
    const toY = (wy: number) => (wy - top) * scale;

    ctx.imageSmoothingEnabled = scale < 1;
    const rx0 = Math.floor(left / REGION_TILES), rx1 = Math.floor(right / REGION_TILES);
    const ry0 = Math.floor(top / REGION_TILES), ry1 = Math.floor(bottom / REGION_TILES);
    for (let ry = ry0; ry <= ry1; ry++)
      for (let rx = rx0; rx <= rx1; rx++) {
        const r = this.region(rx, ry);
        if (!r) continue;
        const sx = toX(rx * REGION_TILES), sy = toY(ry * REGION_TILES);
        const size = REGION_TILES * scale;
        // Snap to whole pixels to avoid seams between regions.
        ctx.drawImage(r, Math.floor(sx), Math.floor(sy), Math.ceil(sx + size) - Math.floor(sx), Math.ceil(sy + size) - Math.floor(sy));
      }

    if (scale >= DETAIL_SCALE) this.drawDetail(ctx, view, left, top, right, bottom, toX, toY);
    if (scale >= 24) this.drawGrid(ctx, left, top, right, bottom, toX, toY, scale);
    ctx.restore();
  }

  private drawDetail(
    ctx: CanvasRenderingContext2D, view: View, left: number, top: number, right: number, bottom: number,
    toX: (n: number) => number, toY: (n: number) => number,
  ) {
    const s = this.surface;
    const { scale } = view;
    const cx0 = Math.floor(left / 32) - 1, cx1 = Math.floor(right / 32) + 1;
    const cy0 = Math.floor(top / 32) - 1, cy1 = Math.floor(bottom / 32) + 1;
    const visible: number[] = [];
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = s.chunks.get(`${cx},${cy}`);
        if (c) for (const e of c.entities) visible.push(e);
      }
    // Ground things first, then buildings, so trees never hide a belt's icon.
    const layer = (e: number) => {
      const t = this.map.protos[s.proto[e]]?.type;
      if (t === 'resource') return 0;
      if (t && ROUND.has(t)) return 1;
      if (t && RAILS.has(t)) return 2;
      return 3;
    };
    visible.sort((a, b) => layer(a) - layer(b));

    const pad = Math.max(1, scale * 0.06);
    for (const e of visible) {
      const proto = this.map.protos[s.proto[e]];
      if (!proto) continue;
      const [l, t, w, h] = footprint(proto, s.x[e], s.y[e], s.dir[e]);
      const sx = toX(l), sy = toY(t), sw = w * scale, sh = h * scale;
      const color = this.entityColor(e);
      if (proto.type === 'resource') {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(toX(s.x[e] - 0.5), toY(s.y[e] - 0.5), scale, scale);
        ctx.globalAlpha = 1;
        continue;
      }
      if (ROUND.has(proto.type)) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(toX(s.x[e]), toY(s.y[e]), Math.max(1, Math.min(sw, sh) * 0.4), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(sx + pad, sy + pad, sw - 2 * pad, sh - 2 * pad);
      ctx.globalAlpha = 1;
      if (scale >= 10) {
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + pad + 0.5, sy + pad + 0.5, sw - 2 * pad - 1, sh - 2 * pad - 1);
      }

      if (scale >= ICON_SCALE) {
        const icon = iconBitmap(proto.icon);
        const recipe = s.recipe[e] ? this.map.recipes[s.recipe[e] - 1] : undefined;
        const recipeIcon = recipe && iconBitmap(recipe.icon);
        const box = Math.min(sw, sh) - 2 * pad;
        if (recipeIcon && box >= 20) {
          // Alt-mode style: the recipe's icon big, on a dark disc.
          const size = box * 0.7;
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.beginPath();
          ctx.arc(sx + sw / 2, sy + sh / 2, size * 0.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.drawImage(recipeIcon, sx + (sw - size) / 2, sy + (sh - size) / 2, size, size);
        } else if (icon) {
          const size = Math.min(box * 0.85, 64);
          ctx.drawImage(icon, sx + (sw - size) / 2, sy + (sh - size) / 2, size, size);
        }
        if (DIRECTIONAL.has(proto.type) && !icon) this.arrow(ctx, toX(s.x[e]), toY(s.y[e]), s.dir[e], Math.min(sw, sh) * 0.35);
        else if (DIRECTIONAL.has(proto.type) && scale >= 28) this.arrow(ctx, toX(s.x[e]), toY(s.y[e]), s.dir[e], Math.min(sw, sh) * 0.35, true);
      } else if (DIRECTIONAL.has(proto.type) && scale >= 8) {
        this.arrow(ctx, toX(s.x[e]), toY(s.y[e]), s.dir[e], Math.min(sw, sh) * 0.35);
      }
    }
  }

  private arrow(ctx: CanvasRenderingContext2D, x: number, y: number, dir: number, r: number, small = false) {
    const a = (dir / 16) * Math.PI * 2; // 0 = north, clockwise
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    if (small) { ctx.translate(0, -r * 0.9); r *= 0.35; }
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.75, r * 0.6);
    ctx.lineTo(-r * 0.75, r * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D, left: number, top: number, right: number, bottom: number,
    toX: (n: number) => number, toY: (n: number) => number, scale: number,
  ) {
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(left); x <= right; x++) { const sx = Math.round(toX(x)) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, (bottom - top) * scale); }
    for (let y = Math.floor(top); y <= bottom; y++) { const sy = Math.round(toY(y)) + 0.5; ctx.moveTo(0, sy); ctx.lineTo((right - left) * scale, sy); }
    ctx.stroke();
  }

  /** The topmost building (not ground clutter) under a world position, or any entity there. */
  entityAt(wx: number, wy: number): number | undefined {
    const s = this.surface;
    let best: number | undefined, bestRank = -1;
    for (let cy = Math.floor(wy / 32) - 1; cy <= Math.floor(wy / 32) + 1; cy++)
      for (let cx = Math.floor(wx / 32) - 1; cx <= Math.floor(wx / 32) + 1; cx++) {
        const c = s.chunks.get(`${cx},${cy}`);
        if (!c) continue;
        for (const e of c.entities) {
          const proto = this.map.protos[s.proto[e]];
          if (!proto) continue;
          const [l, t, w, h] = footprint(proto, s.x[e], s.y[e], s.dir[e]);
          if (wx < l || wx >= l + w || wy < t || wy >= t + h) continue;
          const rank = proto.type === 'resource' ? 0 : ROUND.has(proto.type) ? 1 : 2;
          if (rank > bestRank) { best = e; bestRank = rank; }
        }
      }
    return best;
  }

  tileAt(wx: number, wy: number): string | undefined {
    const c = this.surface.chunks.get(`${Math.floor(wx / 32)},${Math.floor(wy / 32)}`);
    if (!c) return undefined;
    const t = c.tiles[(Math.floor(wy) - c.cy * 32) * 32 + (Math.floor(wx) - c.cx * 32)];
    return this.map.tiles[t]?.name;
  }
}
