// Blueprint string export and import: copy a selection (or the whole layout)
// as a string to paste into Factorio, or paste a string from the game.

import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeBlueprintString, encodeBlueprintString } from '../blueprint/format';
import { blueprintToClipboard, layoutToBlueprint } from '../blueprint/layout';
import { ENTITIES } from './catalog';
import type { BlockGrid, Clipboard, PlacedEntity, PlacedRail } from './model';

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

function ImportPane({ initial, onClose, onImport }: { initial?: string; onClose: () => void; onImport: (clip: Clipboard, note: string) => void }) {
  const [value, setValue] = useState(initial ?? '');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ clip: Clipboard; note: string; skipped: string[]; railNote: string } | null>(null);
  const run = () => {
    try {
      const { clipboard, unknown, label } = blueprintToClipboard(decodeBlueprintString(value));
      const missing = Object.entries(unknown).map(([n, c]) => `${c} × ${n}`);
      const names = Object.keys(unknown);
      const notes: string[] = [];
      if (names.some((n) => /locomotive|wagon/.test(n))) notes.push('Trains are not placed: the planner lays out track, not rolling stock.');
      if (names.some((n) => /\(1\.x|legacy-/.test(n))) notes.push('1.x diagonal and curved rails have no 2.0 equivalent (the game keeps them as legacy rails), so that track and its signals and stops were left out.');
      if (names.some((n) => /rail-ramp|rail-support|elevated/.test(n))) notes.push('Elevated rails are not supported.');
      const railNote = notes.length ? ' ' + notes.join(' ') : '';
      if (!clipboard) {
        setError(missing.length ? `Nothing the planner knows in this blueprint (${missing.join(', ')}).${railNote}` : 'This blueprint has no buildings.');
        return;
      }
      const railCount = clipboard.rails?.length ?? 0;
      const note = `${label ? `"${label}": ` : ''}${clipboard.entities.length} buildings${railCount ? `, ${railCount} rails` : ''}${missing.length ? `, skipped ${missing.join(', ')}` : ''}${railNote}`;
      // Say what is missing before placing a partial blueprint.
      if (missing.length) setPending({ clip: clipboard, note, skipped: missing, railNote });
      else onImport(clipboard, note);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <h3>Import blueprint</h3>
      <p className="muted small">Paste a blueprint string from Factorio (or a book: its active blueprint is used). It goes into your hand to place.</p>
      <textarea
        className="bp-text"
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError('');
          setPending(null);
        }}
        placeholder="0eNq..."
      />
      {error && <p className="small warn">{error}</p>}
      {pending && (
        <div className="small warn">
          <p>
            Only part of this blueprint can be placed: {pending.clip.entities.length} building{pending.clip.entities.length === 1 ? '' : 's'}. Skipped (not in the planner{pending.railNote ? '' : ', possibly from a mod'}): {pending.skipped.join(', ')}.
            {pending.railNote}
          </p>
        </div>
      )}
      <div className="tool-row">
        {pending ? (
          <button className="primary" onClick={() => onImport(pending.clip, pending.note)}>
            Place {pending.clip.entities.length} building{pending.clip.entities.length === 1 ? '' : 's'} anyway
          </button>
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
