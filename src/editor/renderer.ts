// PixiJS renderer for the layout grid. Owns the canvas, the camera and the
// drawing; knows nothing about React or editing rules.

import { Application, Container, Graphics, Text } from 'pixi.js';
import { gameData } from '../data';
import { ENTITIES, entityColor, isRotatable, shortLabel } from './catalog';
import { entityRect, footprint, tileKey, type Direction, type Layout } from './model';

export const TILE = 32;

const COLORS = {
  grass: 0x33402a,
  grassAlt: 0x36442c,
  gridMinor: 0x000000,
  gridMajor: 0x000000,
  water: 0x1d4f7c,
  shore: 0x6a9fc4,
  selection: 0xffd34d,
  ok: 0x4cd964,
  bad: 0xff4d4d,
  arrow: 0x111111,
  badgeBg: 0x111111,
};

export interface Camera {
  /** world-space pixel at the screen's top-left */
  x: number;
  y: number;
  zoom: number;
}

export interface Ghost {
  /** tiles that show a ghost; each one can be valid or not */
  items: { name: string; x: number; y: number; direction: Direction; ok: boolean }[];
  /** extra highlighted tiles (water brush, eraser) */
  brush?: { tiles: [number, number][]; color: number };
  /** selection rectangle being dragged, in tiles (inclusive) */
  box?: { x0: number; y0: number; x1: number; y1: number };
}

/** Extra drawing for the electric and logistics views. Coordinates are in tiles. */
export interface ViewOverlay {
  /** Filled areas drawn under the buildings (pole supply areas). */
  areas?: { x0: number; y0: number; x1: number; y1: number; color: number; alpha: number }[];
  /** Lines drawn over the buildings (power wires). */
  lines?: { x1: number; y1: number; x2: number; y2: number; color: number; width: number }[];
  /** Colour washes over individual buildings (power status, belt tier). */
  tints?: { id: string; color: number; alpha: number }[];
  /** Buildings to fade out because they don't matter in this view. */
  dim?: ReadonlySet<string>;
}

export class GridRenderer {
  app = new Application();
  private world = new Container();
  private ground = new Graphics();
  private water = new Graphics();
  private grid = new Graphics();
  private entities = new Container();
  private viewUnder = new Graphics();
  private viewOver = new Graphics();
  private overlay = new Graphics();
  private ghostLayer = new Container();
  private ready = false;
  private destroyed = false;

  camera: Camera = { x: -400, y: -300, zoom: 1 };
  private layout: Layout = { version: 1, entities: [], water: [] };
  private selected = new Set<string>();
  private badges: Record<string, string> = {};
  private ghost: Ghost = { items: [] };
  private view: ViewOverlay = {};

  async init(host: HTMLElement) {
    await this.app.init({
      resizeTo: host,
      background: COLORS.grass,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    host.appendChild(this.app.canvas);
    this.world.addChild(this.ground, this.water, this.grid, this.viewUnder, this.entities, this.viewOver, this.overlay, this.ghostLayer);
    this.app.stage.addChild(this.world);
    this.app.renderer.on('resize', () => this.drawView());
    this.ready = true;
    this.redrawAll();
  }

  destroy() {
    this.destroyed = true;
    if (this.ready) this.app.destroy(true, { children: true });
  }

  get canvas(): HTMLCanvasElement | undefined {
    return this.ready ? this.app.canvas : undefined;
  }

  // ---- coordinate helpers -------------------------------------------------

  screenToTile(sx: number, sy: number): [number, number] {
    const wx = sx / this.camera.zoom + this.camera.x;
    const wy = sy / this.camera.zoom + this.camera.y;
    return [Math.floor(wx / TILE), Math.floor(wy / TILE)];
  }

  centerOn(tx: number, ty: number) {
    const { width, height } = this.app.screen;
    this.camera.x = tx * TILE - width / 2 / this.camera.zoom;
    this.camera.y = ty * TILE - height / 2 / this.camera.zoom;
    this.drawView();
  }

  panBy(dx: number, dy: number) {
    this.camera.x -= dx / this.camera.zoom;
    this.camera.y -= dy / this.camera.zoom;
    this.drawView();
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const z0 = this.camera.zoom;
    const z1 = Math.min(4, Math.max(0.1, z0 * factor));
    // keep the world point under the cursor fixed
    const wx = sx / z0 + this.camera.x;
    const wy = sy / z0 + this.camera.y;
    this.camera.zoom = z1;
    this.camera.x = wx - sx / z1;
    this.camera.y = wy - sy / z1;
    this.drawView();
  }

  // ---- state setters -------------------------------------------------------

  setLayout(layout: Layout) {
    const waterChanged = layout.water !== this.layout.water;
    const entitiesChanged = layout.entities !== this.layout.entities;
    this.layout = layout;
    if (!this.ready) return;
    if (waterChanged) this.drawWater();
    if (entitiesChanged) this.drawEntities();
    this.drawOverlay();
    this.drawViewOverlay();
  }

  setSelection(ids: Iterable<string>) {
    this.selected = new Set(ids);
    if (this.ready) this.drawOverlay();
  }

  setBadges(badges: Record<string, string>) {
    this.badges = badges;
    if (this.ready) this.drawEntities();
  }

  setView(view: ViewOverlay) {
    this.view = view;
    if (this.ready) this.drawViewOverlay();
  }

  setGhost(ghost: Ghost) {
    this.ghost = ghost;
    if (this.ready) this.drawGhost();
  }

  // ---- drawing -------------------------------------------------------------

  private redrawAll() {
    this.drawView();
    this.drawWater();
    this.drawEntities();
    this.drawOverlay();
    this.drawViewOverlay();
    this.drawGhost();
  }

  /** Camera transform plus everything that depends on the visible area. */
  private drawView() {
    if (!this.ready) return;
    const { zoom, x, y } = this.camera;
    this.world.scale.set(zoom);
    this.world.position.set(-x * zoom, -y * zoom);

    const { width, height } = this.app.screen;
    const x0 = Math.floor(x / TILE) - 1;
    const y0 = Math.floor(y / TILE) - 1;
    const x1 = Math.ceil((x + width / zoom) / TILE) + 1;
    const y1 = Math.ceil((y + height / zoom) / TILE) + 1;

    // Ground: a faint 8x8 chunk checker so large empty areas still read as a map.
    const g = this.ground.clear();
    const C = 8;
    for (let cy = Math.floor(y0 / C); cy <= Math.floor(y1 / C); cy++)
      for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++)
        if ((cx + cy) & 1) g.rect(cx * C * TILE, cy * C * TILE, C * TILE, C * TILE);
    g.fill(COLORS.grassAlt);

    const grid = this.grid.clear();
    const px = 1 / zoom;
    if (zoom >= 0.35) {
      for (let tx = x0; tx <= x1; tx++) if (tx % C !== 0) grid.moveTo(tx * TILE, y0 * TILE).lineTo(tx * TILE, y1 * TILE);
      for (let ty = y0; ty <= y1; ty++) if (ty % C !== 0) grid.moveTo(x0 * TILE, ty * TILE).lineTo(x1 * TILE, ty * TILE);
      grid.stroke({ width: px, color: COLORS.gridMinor, alpha: 0.18 });
    }
    for (let tx = Math.ceil(x0 / C) * C; tx <= x1; tx += C) grid.moveTo(tx * TILE, y0 * TILE).lineTo(tx * TILE, y1 * TILE);
    for (let ty = Math.ceil(y0 / C) * C; ty <= y1; ty += C) grid.moveTo(x0 * TILE, ty * TILE).lineTo(x1 * TILE, ty * TILE);
    grid.stroke({ width: px * 1.5, color: COLORS.gridMajor, alpha: 0.35 });

    // Labels are hidden when zoomed far out, where they would be unreadable.
    for (const child of this.entities.children) if (child instanceof Text) child.visible = zoom >= 0.45;
  }

  private drawWater() {
    const set = new Set(this.layout.water);
    const g = this.water.clear();
    for (const k of this.layout.water) {
      const [x, y] = k.split(',').map(Number);
      g.rect(x * TILE, y * TILE, TILE, TILE);
    }
    g.fill(COLORS.water);
    // Shoreline: a lighter line along every water edge that borders land.
    for (const k of this.layout.water) {
      const [x, y] = k.split(',').map(Number);
      const X = x * TILE;
      const Y = y * TILE;
      if (!set.has(tileKey(x, y - 1))) g.moveTo(X, Y).lineTo(X + TILE, Y);
      if (!set.has(tileKey(x, y + 1))) g.moveTo(X, Y + TILE).lineTo(X + TILE, Y + TILE);
      if (!set.has(tileKey(x - 1, y))) g.moveTo(X, Y).lineTo(X, Y + TILE);
      if (!set.has(tileKey(x + 1, y))) g.moveTo(X + TILE, Y).lineTo(X + TILE, Y + TILE);
    }
    g.stroke({ width: 4, color: COLORS.shore, alignment: 0.5 });
  }

  private drawEntities() {
    for (const c of this.entities.removeChildren()) c.destroy();
    const body = new Graphics();
    const marks = new Graphics();
    this.entities.addChild(body, marks);
    const labels: Text[] = [];

    for (const e of this.layout.entities) {
      const def = ENTITIES[e.name];
      if (!def) continue;
      const r = entityRect(e);
      const px = r.x * TILE;
      const py = r.y * TILE;
      const w = r.w * TILE;
      const h = r.h * TILE;
      const inset = def.kind === 'belt' ? 0 : def.kind === 'pipe' ? 7 : 2;
      body.roundRect(px + inset, py + inset, w - inset * 2, h - inset * 2, Math.min(4, inset + 2))
        .fill(entityColor(def))
        .stroke({ width: 1, color: 0x000000, alpha: 0.6 });

      if (def.kind === 'belt') drawChevrons(marks, px, py, e.direction);
      else if (def.kind === 'inserter') drawArrow(marks, px, py, w, h, e.direction, 0.45);
      else if (def.kind === 'offshore-pump') drawArrow(marks, px, py, w, h, ((e.direction + 2) % 4) as Direction, 0.35);
      else if (isRotatable(def)) drawArrow(marks, px, py, w, h, e.direction, Math.min(0.25, 10 / Math.min(w, h)));

      const label = shortLabel(def);
      if (label) {
        const t = new Text({ text: label, style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, fill: 0xffffff, fontWeight: '600' } });
        t.resolution = 2;
        t.anchor.set(0.5);
        t.position.set(px + w / 2, py + h / 2);
        labels.push(t);
      }
      const recipeName = e.recipe && (gameData.recipes[e.recipe]?.displayName ?? gameData.resources[e.recipe]?.displayName);
      if (recipeName && r.w >= 2) {
        const t = new Text({
          text: recipeName,
          style: { fontFamily: 'system-ui, sans-serif', fontSize: 9, fill: 0xffe6a0, wordWrap: true, wordWrapWidth: w - 6, align: 'center' },
        });
        t.resolution = 2;
        t.anchor.set(0.5, 0);
        t.position.set(px + w / 2, py + h / 2 + 9);
        labels.push(t);
      }
      const badge = this.badges[e.id];
      if (badge) {
        const t = new Text({ text: badge, style: { fontFamily: 'system-ui, sans-serif', fontSize: 10, fill: 0xffffff } });
        t.resolution = 2;
        t.anchor.set(0.5, 1);
        t.position.set(px + w / 2, py + h - 2);
        body.roundRect(px + w / 2 - t.width / 2 - 3, py + h - t.height - 3, t.width + 6, t.height + 2, 3).fill({ color: COLORS.badgeBg, alpha: 0.75 });
        labels.push(t);
      }
    }
    marks.fill({ color: COLORS.arrow, alpha: 0.65 });
    for (const t of labels) {
      t.visible = this.camera.zoom >= 0.45;
      this.entities.addChild(t);
    }
  }

  private drawViewOverlay() {
    const under = this.viewUnder.clear();
    const over = this.viewOver.clear();
    const { areas, lines, tints, dim } = this.view;
    for (const a of areas ?? [])
      under.rect(a.x0 * TILE, a.y0 * TILE, (a.x1 - a.x0) * TILE, (a.y1 - a.y0) * TILE).fill({ color: a.color, alpha: a.alpha });
    if (dim?.size || tints?.length) {
      const byId = new Map(this.layout.entities.map((e) => [e.id, e]));
      if (dim?.size) {
        for (const id of dim) {
          const e = byId.get(id);
          if (!e) continue;
          const r = entityRect(e);
          over.rect(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE);
        }
        over.fill({ color: 0x1b1b1b, alpha: 0.7 });
      }
      for (const t of tints ?? []) {
        const e = byId.get(t.id);
        if (!e) continue;
        const r = entityRect(e);
        over.rect(r.x * TILE + 2, r.y * TILE + 2, r.w * TILE - 4, r.h * TILE - 4).fill({ color: t.color, alpha: t.alpha });
      }
    }
    for (const l of lines ?? [])
      over.moveTo(l.x1 * TILE, l.y1 * TILE).lineTo(l.x2 * TILE, l.y2 * TILE).stroke({ width: l.width, color: l.color, alpha: 0.9 });
  }

  private drawOverlay() {
    const g = this.overlay.clear();
    if (!this.selected.size) return;
    for (const e of this.layout.entities) {
      if (!this.selected.has(e.id)) continue;
      const r = entityRect(e);
      g.rect(r.x * TILE + 1, r.y * TILE + 1, r.w * TILE - 2, r.h * TILE - 2);
    }
    g.stroke({ width: 2, color: COLORS.selection });
  }

  private drawGhost() {
    for (const c of this.ghostLayer.removeChildren()) c.destroy();
    const g = new Graphics();
    this.ghostLayer.addChild(g);
    const { brush, items, box } = this.ghost;
    if (box) {
      const x0 = Math.min(box.x0, box.x1), y0 = Math.min(box.y0, box.y1);
      const w = Math.abs(box.x1 - box.x0) + 1, h = Math.abs(box.y1 - box.y0) + 1;
      g.rect(x0 * TILE, y0 * TILE, w * TILE, h * TILE).fill({ color: COLORS.selection, alpha: 0.12 }).stroke({ width: 2, color: COLORS.selection, alpha: 0.9 });
    }
    if (brush) {
      for (const [x, y] of brush.tiles) g.rect(x * TILE, y * TILE, TILE, TILE);
      g.fill({ color: brush.color, alpha: 0.35 }).stroke({ width: 1, color: brush.color, alpha: 0.8 });
    }
    for (const it of items) {
      const def = ENTITIES[it.name];
      if (!def) continue;
      const { w, h } = footprint(def, it.direction);
      const color = it.ok ? COLORS.ok : COLORS.bad;
      g.rect(it.x * TILE, it.y * TILE, w * TILE, h * TILE).fill({ color: entityColor(def), alpha: 0.45 }).stroke({ width: 2, color, alpha: 0.9 });
      const arrows = new Graphics();
      if (def.kind === 'belt') drawChevrons(arrows, it.x * TILE, it.y * TILE, it.direction);
      else if (def.kind === 'offshore-pump') drawArrow(arrows, it.x * TILE, it.y * TILE, w * TILE, h * TILE, ((it.direction + 2) % 4) as Direction, 0.35);
      else if (isRotatable(def)) drawArrow(arrows, it.x * TILE, it.y * TILE, w * TILE, h * TILE, it.direction, Math.min(0.3, 12 / Math.min(w * TILE, h * TILE) + 0.1));
      arrows.fill({ color: 0xffffff, alpha: 0.8 });
      this.ghostLayer.addChild(arrows);
    }
  }
}

/** Unit vectors per direction (screen y grows downward). */
const DIRS: Record<Direction, [number, number]> = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0] };

function drawArrow(g: Graphics, px: number, py: number, w: number, h: number, d: Direction, size: number) {
  const cx = px + w / 2;
  const cy = py + h / 2;
  const [dx, dy] = DIRS[d];
  const len = Math.min(w, h) * size;
  // tip sits towards the edge the entity faces
  const tipX = cx + dx * (w / 2 - 4);
  const tipY = cy + dy * (h / 2 - 4);
  const baseX = tipX - dx * len;
  const baseY = tipY - dy * len;
  g.poly([tipX, tipY, baseX - dy * len * 0.7, baseY + dx * len * 0.7, baseX + dy * len * 0.7, baseY - dx * len * 0.7]);
}

function drawChevrons(g: Graphics, px: number, py: number, d: Direction) {
  const [fx, fy] = DIRS[d];
  const [sx, sy] = [-fy, fx];
  const cx = px + TILE / 2;
  const cy = py + TILE / 2;
  // chevron outline in (forward, side) coordinates, pointing forward
  const shape: [number, number][] = [[3, 0], [-3, 6], [-6, 6], [0, 0], [-6, -6], [-3, -6]];
  for (const off of [-5, 6]) {
    const pts: number[] = [];
    for (const [f, side] of shape) pts.push(cx + fx * (f + off) + sx * side, cy + fy * (f + off) + sy * side);
    g.poly(pts);
  }
}

