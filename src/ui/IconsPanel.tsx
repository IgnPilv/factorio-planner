import { useRef, useState } from 'react';
import {
  canPickDirectory, forgetIcons, loadedIconCount, loadIconsFromFiles, neededIconPaths, pickAndLoadIcons, type LoadResult,
} from '../data/icons';
import { GameIcon, useIconsVersion } from './GameIcon';

const SAMPLE = ['iron-plate', 'electronic-circuit', 'assembling-machine-2', 'transport-belt', 'fast-inserter', 'oil-refinery'];

/** Side panel for loading the game's icons from the player's own install. */
export function IconsPanel({ onClose }: { onClose: () => void }) {
  useIconsVersion();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const needed = neededIconPaths().size;
  const have = loadedIconCount();

  const report = (r: LoadResult) =>
    setMsg(r.found === 0
      ? 'No game icons found there. Pick the Factorio folder, or its "data" folder.'
      : `Loaded ${r.found} of ${r.needed} icons.`);
  const run = async (load: () => Promise<LoadResult>) => {
    setBusy(true);
    setMsg(undefined);
    try { report(await load()); } catch (e) {
      if ((e as Error).name !== 'AbortError') setMsg(`Couldn't read that folder: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };
  const choose = () => (canPickDirectory() ? run(pickAndLoadIcons) : input.current?.click());

  return (
    <aside className="research-panel icons-panel" aria-label="Game icons">
      <div className="research-head">
        <h2>Game icons</h2>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      <p>
        The planner can show Factorio's own icons, read from your copy of the game. Wube's terms don't allow
        sites to redistribute the game's art, so they aren't bundled. Your browser reads only the icon files,
        keeps them on this device, and uploads nothing.
      </p>
      <div className="icons-sample">{SAMPLE.map((n) => <GameIcon key={n} name={n} size={32} />)}</div>
      <p className="muted small">{have ? `${have} of ${needed} icons loaded.` : 'No game icons loaded yet.'}</p>
      <div className="research-actions">
        <button onClick={choose} disabled={busy}>{busy ? 'Reading…' : have ? 'Reload from game folder' : 'Choose Factorio folder'}</button>
        {have > 0 && <button onClick={() => { forgetIcons(); setMsg(undefined); }} disabled={busy}>Forget icons</button>}
      </div>
      {msg && <p role="status">{msg}</p>}
      <input
        ref={input} type="file" hidden multiple
        {...{ webkitdirectory: '' }}
        onChange={(e) => { const f = e.target.files; if (f?.length) run(() => loadIconsFromFiles(f)); e.target.value = ''; }}
      />
      <h3>Where the game folder is</h3>
      <ul className="small">
        <li>Steam on Windows: <code>C:\Program Files (x86)\Steam\steamapps\common\Factorio</code></li>
        <li>Steam on macOS: <code>~/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents</code></li>
        <li>Steam on Linux: <code>~/.steam/steam/steamapps/common/Factorio</code></li>
        <li>Standalone: the folder you unpacked or installed Factorio into.</li>
      </ul>
      <p className="muted small">
        Pick the Factorio folder or its <code>data</code> folder. In Firefox and Safari, picking <code>data/base/graphics</code> reads
        fewer files; the browser may say it will "upload" them, but they stay on your device.
      </p>
    </aside>
  );
}
