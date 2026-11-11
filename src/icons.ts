// Real game icons, read from the player's own Factorio install.
//
// Wube's terms of service don't allow redistributing the game's art, and the
// public factorio-data repository has no graphics, so the site ships none.
// Instead the player points the app at their game's `data` folder once; the
// browser reads just the icon files the planner needs (nothing is uploaded),
// crops each to its full-size mip level and keeps them in IndexedDB.
// Until then the map draws coloured blocks.
//
// Paths look like "__space-age__/graphics/icons/foundry.png"; the mod reports one
// per entity and recipe in the export. Icons from the game's own folders (base,
// core, space-age, quality, elevated-rails) load; mods installed as zips don't yet.

/** Size icons are stored and drawn at (Factorio's own item icon size). */
export const ICON_SIZE = 64;

let wanted = new Set<string>();
/** The icon paths the loaded map uses. */
export function setNeededIconPaths(paths: Iterable<string>) {
  wanted = new Set(paths);
}

function neededIconPaths(): Set<string> {
  return wanted;
}

// ---- in-memory store and change notifications ------------------------------

interface Loaded { url: string; bitmap: ImageBitmap }
const loaded = new Map<string, Loaded>();
let version = 0;
const listeners = new Set<() => void>();
function changed() {
  version++;
  for (const l of listeners) l();
}

export function subscribeIcons(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const iconsVersion = () => version;
export const loadedIconCount = () => loaded.size;

/** Object URL of a loaded icon, for <img>. */
export function iconUrl(path: string | undefined): string | undefined {
  return path ? loaded.get(path)?.url : undefined;
}
/** Decoded icon, for drawing on the canvas. */
export function iconBitmap(path: string | undefined): ImageBitmap | undefined {
  return path ? loaded.get(path)?.bitmap : undefined;
}

async function put(path: string, blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const old = loaded.get(path);
  if (old) URL.revokeObjectURL(old.url);
  loaded.set(path, { url: URL.createObjectURL(blob), bitmap });
}

// ---- IndexedDB persistence --------------------------------------------------

const DB = 'factorio-map-viewer-icons';
const STORE = 'icons';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

let started: Promise<void> | undefined;
/** Restores icons saved by an earlier visit. Safe to call more than once. */
export function restoreIcons(): Promise<void> {
  started ??= (async () => {
    if (typeof indexedDB === 'undefined') return;
    try {
      const keys = (await tx('readonly', (s) => s.getAllKeys())) as string[] | undefined;
      const blobs = (await tx('readonly', (s) => s.getAll())) as Blob[] | undefined;
      if (!keys?.length || !blobs) return;
      await Promise.all(keys.map((k, i) => put(k, blobs[i]).catch(() => undefined)));
      changed();
    } catch {
      // Private windows and blocked storage: the app works without icons.
    }
  })();
  return started;
}

export async function forgetIcons() {
  for (const v of loaded.values()) URL.revokeObjectURL(v.url);
  loaded.clear();
  try { await tx('readwrite', (s) => s.clear()); } catch { /* nothing stored */ }
  changed();
}

// ---- reading the game files -------------------------------------------------

/**
 * Maps a file's path relative to the chosen folder to a game path, e.g.
 * "Factorio/data/space-age/graphics/icons/foundry.png" -> "__space-age__/graphics/icons/foundry.png".
 * A bare graphics folder is assumed to belong to base.
 */
export function gamePathOf(relative: string): string | undefined {
  const parts = relative.replace(/\\/g, '/').split('/').filter(Boolean);
  const g = parts.lastIndexOf('graphics');
  if (g < 0) return undefined;
  const mod = g > 0 && parts[g - 1] !== 'data' ? parts[g - 1] : 'base';
  return `__${mod}__/${parts.slice(g).join('/')}`;
}

/** Crops the largest mip level (the left-most square) and scales it to ICON_SIZE. */
async function cropIcon(file: Blob): Promise<Blob> {
  const src = await createImageBitmap(file);
  const s = Math.min(src.width, src.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, s, s, 0, 0, ICON_SIZE, ICON_SIZE);
  src.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'));
}

export interface LoadResult { found: number; needed: number }

async function store(files: Map<string, () => Promise<Blob>>): Promise<LoadResult> {
  const needed = neededIconPaths();
  const blobs: [string, Blob][] = [];
  await Promise.all([...files].map(async ([path, read]) => {
    if (!needed.has(path)) return;
    try {
      const blob = await cropIcon(await read());
      await put(path, blob);
      blobs.push([path, blob]);
    } catch { /* unreadable file: skip it */ }
  }));
  if (blobs.length) {
    try { await tx('readwrite', (s) => { for (const [k, b] of blobs) s.put(b, k); }); } catch { /* keep them for this visit only */ }
    changed();
  }
  return { found: loaded.size, needed: needed.size };
}

/** From an <input type="file" webkitdirectory> selection. */
export function loadIconsFromFiles(list: FileList | File[]): Promise<LoadResult> {
  const files = new Map<string, () => Promise<Blob>>();
  for (const f of Array.from(list)) {
    if (!f.name.endsWith('.png')) continue;
    const p = gamePathOf(f.webkitRelativePath || f.name);
    if (p) files.set(p, async () => f);
  }
  return store(files);
}

// Minimal typing for the File System Access API (Chromium only).
interface DirHandle {
  kind: 'directory';
  name: string;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  getFileHandle(name: string): Promise<{ getFile(): Promise<File> }>;
}
type DirPicker = (opts?: { id?: string; mode?: 'read' }) => Promise<DirHandle>;

export const canPickDirectory = () => typeof (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker === 'function';

async function sub(dir: DirHandle, path: string[]): Promise<DirHandle | undefined> {
  let d: DirHandle | undefined = dir;
  for (const p of path) {
    try { d = await d.getDirectoryHandle(p); } catch { return undefined; }
  }
  return d;
}

/**
 * Asks for the game folder with the directory picker and reads only the needed files
 * by path. Accepts the install folder, its `data` folder, or `data/base`.
 */
export async function pickAndLoadIcons(): Promise<LoadResult> {
  const w = window as unknown as { showDirectoryPicker: DirPicker };
  const dir = await w.showDirectoryPicker({ id: 'factorio-data', mode: 'read' });
  // Find the folder holding base/ and core/ (the game's data folder).
  let data: DirHandle | undefined;
  for (const path of [[], ['data'], ['factorio.app', 'Contents', 'data'], ['Contents', 'data']]) {
    const d = await sub(dir, path);
    if (d && (await sub(d, ['base', 'graphics']))) { data = d; break; }
  }
  const files = new Map<string, () => Promise<Blob>>();
  for (const path of neededIconPaths()) {
    const m = /^__([\w-]+)__\/(.+)$/.exec(path);
    if (!m) continue;
    // Without a data folder, accept a picked base/ (or its graphics/) folder for base icons.
    const parts = m[2].split('/');
    const tries: [DirHandle | undefined, string[]][] = data
      ? [[data, [m[1], ...parts]]]
      : m[1] === 'base' ? [[dir, parts], [dir, parts.slice(1)]] : [];
    files.set(path, async () => {
      for (const [root, segs] of tries) {
        const folder = root && (await sub(root, segs.slice(0, -1)));
        if (!folder) continue;
        try { return await (await folder.getFileHandle(segs[segs.length - 1])).getFile(); } catch { /* try next */ }
      }
      throw new Error('missing');
    });
  }
  return store(files);
}
