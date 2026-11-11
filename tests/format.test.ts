import { describe, expect, it } from 'vitest';
import { strToU8, zipSync, zlibSync } from 'fflate';
import { decodeExport, parseRuns, rgb } from '../src/export/format';
import { findExport, loadBytes, readSaveVersion } from '../src/export/load';
import { demoRaw } from '../src/export/demo';
import { footprint } from '../src/map/renderer';

const wrap = (json: string) =>
  `FACTORIO-MAP-VIEWER-EXPORT-1:${Buffer.from(zlibSync(strToU8(json))).toString('base64')}:END-FACTORIO-MAP-VIEWER-EXPORT`;

describe('export format', () => {
  it('expands tile runs', () => {
    const t = parseRuns('3*5,7,2*1018');
    expect(Array.from(t.slice(0, 7))).toEqual([3, 3, 3, 3, 3, 7, 2]);
    expect(t[1023]).toBe(2);
  });

  it('normalises 0-1 and 0-255 colours', () => {
    expect(rgb([1, 0.5, 0], [0, 0, 0])).toEqual([255, 128, 0]);
    expect(rgb([51, 83, 95], [0, 0, 0])).toEqual([51, 83, 95]);
    expect(rgb(undefined, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('accepts empty tables written as {}', () => {
    const map = decodeExport({ format: 1, tiles: [], entities: [], recipes: {}, forces: [], surfaces: {} });
    expect(map.surfaces).toEqual([]);
  });

  it('rejects unknown format versions', () => {
    expect(() => decodeExport({ format: 2, tiles: [], entities: [], recipes: [], forces: [], surfaces: [] })).toThrow(/format 2/);
  });

  it('decodes the demo map and indexes entities by chunk', () => {
    const map = decodeExport(demoRaw());
    expect(map.surfaces.map((s) => s.kind)).toEqual(['planet', 'platform']);
    const nauvis = map.surfaces[0];
    const total = [...nauvis.chunks.values()].reduce((n, c) => n + c.entities.length, 0);
    expect(total).toBe(nauvis.count);
  });
});

describe('loading files', () => {
  it('reads the script-output text file', () => {
    const res = loadBytes(strToU8(wrap(JSON.stringify(demoRaw()))));
    expect(res.ok && res.map.surfaces.length).toBe(2);
  });

  it('takes the newest of several exports', () => {
    const a = { ...demoRaw(), tick: 1 }, b = { ...demoRaw(), tick: 2 };
    const res = loadBytes(strToU8(wrap(JSON.stringify(a)) + '...' + wrap(JSON.stringify(b))));
    expect(res.ok && res.map.tick).toBe(2);
  });

  it('reports a save without an export, with its version', () => {
    const save = zipSync({
      's/level.dat0': zlibSync(new Uint8Array([2, 0, 0, 0, 72, 0, 1, 0])),
      's/level.dat1': zlibSync(new Uint8Array(100)),
      's/script.dat': new Uint8Array(50),
    });
    expect(loadBytes(save)).toEqual({ ok: false, reason: 'no-export', save: { version: '2.0.72', name: 's' } });
  });

  it('finds an export kept in level.dat, even across pieces', () => {
    const text = strToU8(wrap(JSON.stringify(demoRaw())));
    const mid = 40;
    const save = zipSync({
      's/level.dat0': zlibSync(new Uint8Array([2, 0, 1, 0, 24, 0, 1, 0, ...text.slice(0, mid)])),
      's/level.dat1': zlibSync(text.slice(mid)),
    });
    const res = loadBytes(save);
    expect(res.ok).toBe(true);
  });

  it('ignores garbage', () => {
    expect(findExport(strToU8('hello'))).toBeUndefined();
    expect(readSaveVersion(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
    expect(loadBytes(strToU8('FACTORIO-MAP-VIEWER-EXPORT-1:!!!:END-FACTORIO-MAP-VIEWER-EXPORT')).ok).toBe(false);
  });
});

describe('footprints', () => {
  const p = { name: 'x', type: 'assembling-machine', w: 2, h: 3, own: [0, 0, 0], enemy: [0, 0, 0], neutral: [0, 0, 0] } as const;
  it('rotates east/west', () => {
    expect(footprint({ ...p, own: [0, 0, 0], enemy: [0, 0, 0], neutral: [0, 0, 0] }, 0, 0, 0)).toEqual([-1, -1.5, 2, 3]);
    expect(footprint({ ...p, own: [0, 0, 0], enemy: [0, 0, 0], neutral: [0, 0, 0] }, 0, 0, 4)).toEqual([-1.5, -1, 3, 2]);
  });
});
