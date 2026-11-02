// Blueprint string export and import: copy a selection (or the whole layout)
// as a string to paste into Factorio, or paste a string from the game.

import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeBlueprintString, encodeBlueprintString } from '../blueprint/format';
import { blueprintToClipboard, layoutToBlueprint, type ImportResult } from '../blueprint/layout';
import { centreLine } from '../rails/geometry';
import { railPiece } from './rails';
import { ENTITIES } from './catalog';
import { footprint, type BlockGrid, type Clipboard, type PlacedEntity, type PlacedRail } from './model';

export type BlueprintDialogMode =
  | { kind: 'export'; entities: PlacedEntity[]; rails?: PlacedRail[]; scope: 'selection' | 'layout'; grid?: BlockGrid }
  | { kind: 'import'; initial?: string };

export function BlueprintDialog({ mode, onClose, onImport }: { mode: BlueprintDialogMode; onClose: () => void; onImport: (clip: Clipboard, note: string) => void }) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="bp-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bp-dialog" role="dialog" aria-modal="true">
        {mode.kind === 'export' ? <ExportPane entities={mode.entities} rails={mode.rails ?? []} scope={mode.scope} grid={mode.grid} onClose={onClose} /> : <ImportPane initial={mode.initial} onClose={onClose} onImport={onImport} />}
      </div>
    </div>
  );
}

function ExportPane({ entities, rails, scope, grid, onClose }: { entities: PlacedEntity[]; rails: PlacedRail[]; scope: 'selection' | 'layout'; grid?: BlockGrid; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [snap, setSnap] = useState(true);
  const useGrid = grid && snap ? grid : undefined;
  const [copied, setCopied] = useState<'' | 'ok' | 'failed'>('');
  const text = useRef<HTMLTextAreaElement>(null);
  const { str, wires, skipped } = useMemo(() => {
    const { blueprint, skipped } = layoutToBlueprint(entities, { label: label.trim() || undefined, rails, grid: useGrid });
    return { str: encodeBlueprintString(blueprint), wires: blueprint.wires?.length ?? 0, skipped };
  }, [entities, rails, label, useGrid]);
  useEffect(() => setCopied(''), [str]);

  const drillsWithoutNote = entities.filter((e) => ENTITIES[e.name]?.kind === 'mining-drill').length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(str);
      setCopied('ok');
    } catch {
      text.current?.select();
      setCopied(document.execCommand?.('copy') ? 'ok' : 'failed');
    }
  };

  return (
    <>
      <h3>Blueprint string</h3>
      <p className="muted small">
        {entities.length} building{entities.length === 1 ? '' : 's'}
        {rails.length > 0 && <>, {rails.length} rail piece{rails.length === 1 ? '' : 's'}</>} from the {scope === 'selection' ? 'selection' : 'whole layout'}
        {wires > 0 && <>, {wires} copper wire{wires === 1 ? '' : 's'}</>}. In Factorio, click <b>Import string</b> on the shortcut bar and paste it.
      </p>
      <label className="bp-label">
        Name <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Blueprint name (optional)" maxLength={200} />
      </label>
      {grid && (
        <label className="bp-label" title="The blueprint snaps to the city-block grid in the game, so it lands in the same place relative to the grid as here">
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap to the {grid.pitch}×{grid.pitch} block grid (absolute)
        </label>
      )}
      {useGrid && (
        <p className="muted small">
          In the game this snaps to the same world grid as the City blocks book, so it lands in the same spot within its block as it sits here.
        </p>
      )}
      <textarea ref={text} className="bp-text" readOnly value={str} onFocus={(e) => e.currentTarget.select()} />
      <div className="tool-row">
        <button className="primary" onClick={copy} autoFocus>
          {copied === 'ok' ? 'Copied' : 'Copy to clipboard'}
        </button>
        <button onClick={onClose}>Close</button>
      </div>
      {copied === 'failed' && <p className="small warn">Could not copy automatically. The text is selected, press Ctrl+C.</p>}
      <p className="muted small">
        Includes recipes, modules and pole wires. Water tiles are not included{drillsWithoutNote ? ', and drills mine whatever ore is under them' : ''}.
        {skipped > 0 && <> {skipped} unknown building{skipped === 1 ? ' was' : 's were'} left out.</>}
      </p>
    </>
  );
}

interface ImportSummary {
  clip: Clipboard;
  preview?: ImportResult['preview'];
  note: string;
  coming: string[];
  converted: string[];
  skipped: string[];
  notes: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summarise(value: string): ImportSummary | string {
  const { clipboard, unknown, replaced, railRoutes, preview, label } = blueprintToClipboard(decodeBlueprintString(value));
  const skipped = Object.entries(unknown).map(([n, c]) => `${c} × ${n}`);
  const names = Object.keys(unknown);
  const notes: string[] = [];
  if (names.some((n) => /locomotive|wagon/.test(n))) notes.push('Trains are not placed: the planner lays out track, not rolling stock.');
  if (names.some((n) => /beside 1\.x curve/.test(n))) notes.push('Signals and stops left out stood beside 1.x curves with no matching spot on the rebuilt track; the rebuilt junctions get new signals instead.');
  if (names.some((n) => /rail-ramp|rail-support|elevated/.test(n))) notes.push('Elevated rails are not supported.');
  if (names.some((n) => !/\(|locomotive|wagon|rail/.test(n))) notes.push('Other skipped buildings are from mods, or not in the planner yet.');
  if (!clipboard) return skipped.length ? `Nothing the planner knows in this blueprint (${skipped.join(', ')}). ${notes.join(' ')}` : 'This blueprint has no buildings.';
  const counts = new Map<string, number>();
  for (const e of clipboard.entities) {
    const n = ENTITIES[e.name]?.displayName ?? e.name;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const coming = [...counts].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c} × ${n}`);
  if (clipboard.rails?.length) coming.unshift(plural(clipboard.rails.length, 'rail piece'));
  const converted = Object.entries(replaced).map(([n, c]) => `${c} × ${n}`);
  if (railRoutes?.rebuilt)
    converted.unshift(
      `${plural(railRoutes.legacyPieces, '1.x curve or diagonal piece')} rebuilt as ${plural(railRoutes.rebuilt, 'route')} of 2.0 track. 2.0 curves are wider, so junctions and loops take a little more room.`,
    );
  if (railRoutes?.resignalled) converted.splice(1, 0, `${plural(railRoutes.resignalled, 'signal')} from beside the old curves and diagonals moved onto the rebuilt track, facing the same way.`);
  if (railRoutes?.moved) converted.splice(1, 0, `${plural(railRoutes.moved, 'building')} moved a few tiles to make room for the wider 2.0 curves.`);
  if (railRoutes?.signals) converted.splice(1, 0, `${plural(railRoutes.signals, 'signal')} added at the rebuilt junctions: chain signals where trains enter, rail signals where they leave.`);
  const note = `${label ? `"${label}": ` : ''}${plural(clipboard.entities.length, 'building')}${clipboard.rails?.length ? `, ${clipboard.rails.length} rails` : ''}`;
  return { clip: clipboard, preview, note, coming, converted, skipped, notes };
}

function ImportPane({ initial, onClose, onImport }: { initial?: string; onClose: () => void; onImport: (clip: Clipboard, note: string) => void }) {
  const [value, setValue] = useState(initial ?? '');
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const run = () => {
    try {
      const s = summarise(value);
      if (typeof s === 'string') setError(s);
      // Place straight away when everything came through unchanged; otherwise say what happened first.
      else if (!s.converted.length && !s.skipped.length) onImport(s.clip, s.note);
      else setSummary(s);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <h3>Import blueprint</h3>
      {!summary && (
        <>
          <p className="muted small">Paste a blueprint string from Factorio 1.x or 2.0 (or a book: its active blueprint is used). It goes into your hand to place.</p>
          <textarea
            className="bp-text"
            autoFocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError('');
            }}
            placeholder="0eNq..."
          />
        </>
      )}
      {error && <p className="small warn">{error}</p>}
      {summary && (
        <div className="bp-summary small">
          {summary.preview && <ImportPreview clip={summary.clip} preview={summary.preview} />}
          <h4>Coming in</h4>
          <ul>{summary.coming.map((c) => <li key={c}>{c}</li>)}</ul>
          {summary.converted.length > 0 && (
            <>
              <h4>Converted</h4>
              <ul>{summary.converted.map((c) => <li key={c}>{c}</li>)}</ul>
            </>
          )}
          {summary.skipped.length > 0 && (
            <>
              <h4 className="warn">Left out</h4>
              <ul>{summary.skipped.map((c) => <li key={c}>{c}</li>)}</ul>
            </>
          )}
          {summary.notes.map((n) => <p key={n} className="muted">{n}</p>)}
        </div>
      )}
      <div className="tool-row">
        {summary ? (
          <>
            <button className="primary" autoFocus onClick={() => onImport(summary.clip, summary.note)}>
              Place it
            </button>
            <button onClick={() => setSummary(null)}>Back</button>
          </>
        ) : (
          <button className="primary" onClick={run} disabled={!value.trim()}>
            Import
          </button>
        )}
        <button onClick={onClose}>Cancel</button>
      </div>
    </>
  );
}

const PREVIEW = { track: '#7d7d7d', rebuilt: '#ff9f1c', building: '#55606c', moved: '#4fa3ff', signal: '#5fd35f', dropped: '#ff4d4d', bg: '#1b1d1f' };

/** A small map of the imported blueprint: what was rebuilt, moved, added and left out. */
function ImportPreview({ clip, preview }: { clip: Clipboard; preview: NonNullable<ImportResult['preview']> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const W = canvas.clientWidth || 500, H = 220;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const k = Math.min((W - 8) / clip.w, (H - 8) / clip.h);
    const ox = (W - clip.w * k) / 2, oy = (H - clip.h * k) / 2;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    ctx.fillStyle = PREVIEW.bg;
    ctx.fillRect(-ox / k, -oy / k, W / k, H / k);
    const moved = new Set(preview.movedEntities), added = new Set(preview.addedSignals), rebuilt = new Set(preview.rebuiltRails);
    clip.entities.forEach((e, i) => {
      const def = ENTITIES[e.name];
      if (!def) return;
      const { w, h } = footprint(def, e.direction);
      const signal = def.kind === 'rail-signal';
      ctx.fillStyle = moved.has(i) ? PREVIEW.moved : added.has(i) ? PREVIEW.signal : signal ? PREVIEW.track : PREVIEW.building;
      // Highlights stay at least a few pixels across however far the map is zoomed out.
      const pad = moved.has(i) || added.has(i) ? -Math.max(0, 1.5 / k - 0.5) : 0.1;
      ctx.fillRect(e.x + pad, e.y + pad, w - 2 * pad, h - 2 * pad);
    });
    ctx.lineCap = 'round';
    const line = Math.max(1.2, 2.5 / k);
    for (const pass of [false, true])
      (clip.rails ?? []).forEach((r, i) => {
        if (rebuilt.has(i) !== pass) return;
        const pts = centreLine(railPiece(r));
        ctx.strokeStyle = pass ? PREVIEW.rebuilt : PREVIEW.track;
        ctx.lineWidth = pass ? line * 1.6 : line;
        ctx.beginPath();
        pts.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      });
    ctx.strokeStyle = PREVIEW.dropped;
    ctx.lineWidth = line * 0.8;
    const r = Math.max(0.8, 2.5 / k);
    for (const d of preview.dropped) {
      const cx = d.x + 0.5, cy = d.y + 0.5;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r);
      ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r);
      ctx.lineTo(cx - r, cy + r);
      ctx.stroke();
    }
  }, [clip, preview]);
  const swatch = (c: string) => <i className="bp-swatch" style={{ background: c }} />;
  return (
    <figure className="bp-preview">
      <canvas ref={ref} />
      <figcaption>
        <span>{swatch(PREVIEW.rebuilt)} rebuilt track</span>
        <span>{swatch(PREVIEW.moved)} moved</span>
        <span>{swatch(PREVIEW.signal)} new signals</span>
        <span>{swatch(PREVIEW.dropped)} left out</span>
      </figcaption>
    </figure>
  );
}
