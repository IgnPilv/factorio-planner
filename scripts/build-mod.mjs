// Packs mod/map-viewer-export into public/<name>_<version>.zip so the site can
// offer it as a download. Factorio wants one top-level folder named name_version.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

const src = new URL('../mod/map-viewer-export/', import.meta.url).pathname;
const info = JSON.parse(readFileSync(join(src, 'info.json'), 'utf8'));
const top = `${info.name}_${info.version}`;

const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files[`${top}/${relative(src, full).split('\\').join('/')}`] = [readFileSync(full), { mtime: new Date('2026-01-01') }];
  }
})(src);

const out = new URL('../public/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${top}.zip`), zipSync(files, { level: 9 }));
writeFileSync(join(out, 'mod.json'), JSON.stringify({ file: `${top}.zip`, name: info.name, version: info.version, factorio_version: info.factorio_version }));
console.log(`public/${top}.zip`);
