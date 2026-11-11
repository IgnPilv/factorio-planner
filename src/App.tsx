import { useEffect, useMemo, useState, type DragEvent } from 'react';
import modInfo from '../mod/map-viewer-export/info.json';
import { surfaceTitle, type MapExport, type Surface } from './export/format';
import { loadFile, type SaveInfo } from './export/load';
import { demoMap } from './export/demo';
import { MapView } from './MapView';
import {
  canPickDirectory, forgetIcons, loadedIconCount, loadIconsFromFiles, pickAndLoadIcons,
  restoreIcons, setNeededIconPaths, subscribeIcons,
} from './icons';

const MOD_FILE = `${modInfo.name}_${modInfo.version}.zip`;
const MOD_URL = `${import.meta.env.BASE_URL}${MOD_FILE}`;

type State =
  | { kind: 'empty' }
  | { kind: 'loading'; name: string }
  | { kind: 'no-export'; save?: SaveInfo; name: string }
  | { kind: 'error'; message: string }
  | { kind: 'map'; map: MapExport; name: string };

function useIconCount() {
  const [n, setN] = useState(loadedIconCount());
  useEffect(() => subscribeIcons(() => setN(loadedIconCount())), []);
  return n;
}

export function App() {
  const [state, setState] = useState<State>({ kind: 'empty' });
  const [dragging, setDragging] = useState(false);

  useEffect(() => { void restoreIcons(); }, []);

  const open = async (file: File) => {
    setState({ kind: 'loading', name: file.name });
    await new Promise((r) => setTimeout(r, 30)); // let the spinner paint before the heavy work
    const res = await loadFile(file);
    if (res.ok) setState({ kind: 'map', map: res.map, name: file.name });
    else if (res.reason === 'no-export') setState({ kind: 'no-export', save: res.save, name: file.name });
    else setState({ kind: 'error', message: res.message });
  };

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    setDragging(false);
    const f = ev.dataTransfer.files[0];
    if (f) void open(f);
  };

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      {state.kind === 'map'
        ? <Viewer map={state.map} name={state.name} onOpen={open} onClose={() => setState({ kind: 'empty' })} />
        : <Landing state={state} onOpen={open} onDemo={() => setState({ kind: 'map', map: demoMap(), name: 'Demo map' })} />}
    </div>
  );
}

function FileButton({ label, onOpen, primary }: { label: string; onOpen: (f: File) => void; primary?: boolean }) {
  return (
    <label className={`button${primary ? ' primary' : ''}`}>
      {label}
      <input type="file" accept=".zip,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onOpen(f); e.target.value = ''; }} />
    </label>
  );
}

function Landing({ state, onOpen, onDemo }: { state: State; onOpen: (f: File) => void; onDemo: () => void }) {
  return (
    <main className="landing">
      <h1>Factorio Map Viewer</h1>
      <p className="lead">Drop a save and explore it in your browser: every planet and space platform, zoomable down to single buildings, with the game's own icons. Nothing is uploaded; the file is read on your computer.</p>

      <div className="dropzone">
        {state.kind === 'loading' ? (
          <p>Reading <b>{state.name}</b>…</p>
        ) : (
          <>
            <p>Drop your save <b>.zip</b> here</p>
            <div className="row">
              <FileButton label="Choose a save" onOpen={onOpen} primary />
              <button className="button" onClick={onDemo}>Try a demo map</button>
            </div>
          </>
        )}
      </div>

      {state.kind === 'no-export' && (
        <div className="notice">
          <b>{state.name}</b> {state.save?.version ? `is a Factorio ${state.save.version} save, but it` : ''} has no map export in it yet.
          Saves keep the map in a binary format that changes with every game version, so the site needs the
          small companion mod below to write the map out. Follow the three steps, then drop the new save.
        </div>
      )}
      {state.kind === 'error' && <div className="notice error">Couldn't read that file: {state.message}</div>}

      <ol className="steps">
        <li>
          <b>Install the mod.</b> <a className="button small" href={MOD_URL} download>Download {MOD_FILE}</a>{' '}
          and put the zip in your Factorio <code>mods</code> folder
          (Windows: <code>%APPDATA%\Factorio\mods</code>, macOS: <code>~/Library/Application Support/factorio/mods</code>,
          Linux: <code>~/.factorio/mods</code>). For Factorio {modInfo.factorio_version}.
        </li>
        <li>
          <b>Export in game.</b> Load your save and press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>M</kbd>
          (or type <code>/map-export</code> in chat). It walks every charted chunk on every surface; a big base takes a minute.
        </li>
        <li>
          <b>Save and drop it here.</b> The export is stored inside the save, so just save the game and drop
          the save .zip (from <code>saves</code>). It's also written to <code>script-output/map-viewer-export.txt</code>, which works too.
        </li>
      </ol>
      <p className="dim small">Mods can make a save unusable for achievements. The mod only reads the map; it changes nothing in your world.</p>
    </main>
  );
}

function surfaceGroups(map: MapExport) {
  const groups: { title: string; surfaces: Surface[] }[] = [];
  const by = (kind: Surface['kind']) => map.surfaces.filter((s) => s.kind === kind);
  if (by('planet').length) groups.push({ title: 'Planets', surfaces: by('planet') });
  if (by('platform').length) groups.push({ title: 'Space platforms', surfaces: by('platform') });
  if (by('other').length) groups.push({ title: 'Other surfaces', surfaces: by('other') });
  return groups;
}

function Viewer({ map, name, onOpen, onClose }: { map: MapExport; name: string; onOpen: (f: File) => void; onClose: () => void }) {
  const [surfaceIndex, setSurfaceIndex] = useState(map.surfaces[0]?.index);
  const surface = map.surfaces.find((s) => s.index === surfaceIndex) ?? map.surfaces[0];
  const icons = useIconCount();
  const [iconMsg, setIconMsg] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const needed = useMemo(() => {
    const set = new Set<string>();
    for (const p of map.protos) if (p.icon) set.add(p.icon);
    for (const r of map.recipes) if (r.icon) set.add(r.icon);
    return set;
  }, [map]);
  useEffect(() => setNeededIconPaths(needed), [needed]);

  const loadIcons = async () => {
    try {
      const r = await pickAndLoadIcons();
      setIconMsg(`Loaded ${r.found} icons.`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setIconMsg('Could not read that folder.');
    }
  };

  const days = Math.floor(map.tick / 60 / 3600 / 24), hours = Math.floor((map.tick / 60 / 3600) % 24);
  const groups = surfaceGroups(map);

  return (
    <div className={`viewer${menuOpen ? ' menu-open' : ''}`}>
      <aside className="sidebar">
        <header>
          <h1>Map Viewer</h1>
          <button className="button small close-menu" onClick={() => setMenuOpen(false)}>Close</button>
        </header>
        <p className="dim small">{name}<br />
          {map.gameVersion && <>Factorio {map.gameVersion} · </>}{days > 0 && `${days}d `}{hours}h played
        </p>
        {!map.surfaces.length && <p>This export has no explored surfaces.</p>}
        {groups.map((g) => (
          <section key={g.title}>
            <h2>{g.title}</h2>
            <ul className="surfaces">
              {g.surfaces.map((s) => (
                <li key={s.index}>
                  <button className={s === surface ? 'active' : ''} onClick={() => { setSurfaceIndex(s.index); setMenuOpen(false); }}>
                    <span>{surfaceTitle(s)}</span>
                    <span className="dim">{s.count.toLocaleString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section>
          <h2>Icons</h2>
          <p className="small dim">
            {icons ? `${icons} icons loaded from your game. ` : 'The site can\'t ship the game\'s art. '}
            Point it at your Factorio install folder once and icons are kept in this browser.
          </p>
          <div className="row">
            {canPickDirectory()
              ? <button className="button small" onClick={loadIcons}>Load icons…</button>
              : (
                <label className="button small">
                  Load icons…
                  <input type="file" hidden {...{ webkitdirectory: '' }} multiple onChange={async (e) => {
                    if (e.target.files) { const r = await loadIconsFromFiles(e.target.files); setIconMsg(`Loaded ${r.found} icons.`); }
                  }} />
                </label>
              )}
            {icons > 0 && <button className="button small" onClick={() => void forgetIcons()}>Forget</button>}
          </div>
          {iconMsg && <p className="small">{iconMsg}</p>}
        </section>

        <section>
          <div className="row">
            <FileButton label="Open another save" onOpen={onOpen} />
            <button className="button" onClick={onClose}>Close</button>
          </div>
        </section>
      </aside>
      <div className="main">
        <button className="button small open-menu" onClick={() => setMenuOpen(true)}>☰ {surface ? surfaceTitle(surface) : ''}</button>
        {surface ? <MapView key={surface.index} map={map} surface={surface} /> : <div className="empty">Nothing to show.</div>}
      </div>
    </div>
  );
}

