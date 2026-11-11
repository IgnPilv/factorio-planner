// Finds the mod's export in whatever the player drops on the page: a save .zip
// (the export lives in script.dat, where the game keeps each mod's `storage`),
// the script-output text file, or a zip of that file.

import { decompressSync, strFromU8, unzipSync } from 'fflate';
import { MARK_END, MARK_START, decodeExport, type MapExport, type RawExport } from './format';

export interface SaveInfo {
  /** e.g. "2.1.24" */
  version?: string;
  name?: string;
}

export type LoadResult =
  | { ok: true; map: MapExport; save?: SaveInfo }
  | { ok: false; reason: 'no-export'; save?: SaveInfo }
  | { ok: false; reason: 'error'; message: string };

const enc = new TextEncoder();
const START = enc.encode(MARK_START);
const END = enc.encode(MARK_END);

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  const last = hay.length - needle.length;
  for (let i = hay.indexOf(first, from); i >= 0 && i <= last; i = hay.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/** Base64 text between the markers, or undefined. Takes the last export if there are several. */
export function findExport(bytes: Uint8Array): string | undefined {
  let found: string | undefined;
  for (let s = indexOf(bytes, START); s >= 0; s = indexOf(bytes, START, s + 1)) {
    const e = indexOf(bytes, END, s + START.length);
    if (e < 0) break;
    found = strFromU8(bytes.subarray(s + START.length, e), true);
  }
  return found;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Inflates the game's helpers.encode_string output and parses the JSON. */
export function decodeEncoded(b64: string): MapExport {
  const json = strFromU8(decompressSync(base64ToBytes(b64)));
  return decodeExport(JSON.parse(json) as RawExport);
}

/** Version from the first bytes of level.dat: four little-endian u16 (major, minor, patch, build). */
export function readSaveVersion(levelDat: Uint8Array): string | undefined {
  if (levelDat.length < 8) return undefined;
  const v = new DataView(levelDat.buffer, levelDat.byteOffset, 8);
  const major = v.getUint16(0, true), minor = v.getUint16(2, true), patch = v.getUint16(4, true);
  if (major < 1 || major > 9 || minor > 99 || patch > 999) return undefined;
  return `${major}.${minor}.${patch}`;
}

const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/**
 * Older or future saves might keep mod data inside level.dat instead of script.dat.
 * level.dat is split into level.dat0, level.dat1, ... each zlib-compressed on its own;
 * a string can straddle two pieces, so search them joined.
 */
function findInLevelDat(zip: Uint8Array): string | undefined {
  const pieces = unzipSync(zip, { filter: (f) => /(^|\/)level\.dat\d+$/.test(f.name) });
  const names = Object.keys(pieces).sort((a, b) => Number(/(\d+)$/.exec(a)![1]) - Number(/(\d+)$/.exec(b)![1]));
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const n of names) {
    let d = pieces[n];
    try { d = decompressSync(d); } catch { /* stored raw */ }
    parts.push(d);
    total += d.length;
    delete pieces[n];
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return findExport(all);
}

export function loadBytes(bytes: Uint8Array): LoadResult {
  try {
    if (!isZip(bytes)) {
      const b64 = findExport(bytes);
      return b64 ? { ok: true, map: decodeEncoded(b64) } : { ok: false, reason: 'no-export' };
    }
    // Only unpack what can hold an export, plus the first level.dat piece for the version.
    const files = unzipSync(bytes, {
      filter: (f) => /(^|\/)(script\.dat|level\.dat0?|[^/]*\.txt)$/.test(f.name),
    });
    const fallback = () => findInLevelDat(bytes);
    let save: SaveInfo | undefined;
    for (const [name, data] of Object.entries(files)) {
      const m = /(?:^|\/)level\.dat0?$/.exec(name);
      if (!m) continue;
      let raw = data;
      try { raw = decompressSync(data); } catch { /* stored uncompressed */ }
      save = { version: readSaveVersion(raw), name: name.split('/')[0] };
    }
    const order = Object.keys(files).sort((a, b) => Number(b.endsWith('script.dat')) - Number(a.endsWith('script.dat')));
    for (const name of order) {
      if (/level\.dat0?$/.test(name)) continue;
      const b64 = findExport(files[name]);
      if (b64) return { ok: true, map: decodeEncoded(b64), save };
    }
    const b64 = fallback();
    if (b64) return { ok: true, map: decodeEncoded(b64), save };
    return { ok: false, reason: 'no-export', save };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadFile(file: Blob): Promise<LoadResult> {
  return loadBytes(new Uint8Array(await file.arrayBuffer()));
}
