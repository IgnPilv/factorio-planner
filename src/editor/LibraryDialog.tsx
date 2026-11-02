// The design library: save selections as named designs, place them again,
// copy one as a blueprint string or all of them as a blueprint book.

import { useEffect, useState } from 'react';
import { designFromEntities, designsFromString, designString, libraryBookString, type Design } from '../blueprint/library';
import type { Clipboard, PlacedEntity, PlacedRail } from './model';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function LibraryDialog(props: {
  designs: Design[];
  onChange: (designs: Design[]) => void;
  selection: PlacedEntity[];
  /** Selected rails, saved with the selection. */
  selectionRails?: PlacedRail[];
  onPlace: (clip: Clipboard, name: string) => void;
  onClose: () => void;
}) {
  const { designs, onChange, selection, selectionRails = [], onPlace, onClose } = props;
  const picked = selection.length + selectionRails.length;
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    const d = designFromEntities(selection, name.trim() || `Design ${designs.length + 1}`, selectionRails);
    if (!d) return;
    onChange([...designs, d]);
    setName('');
    setNote(`Saved "${d.name}"`);
  };

  const copy = async (text: string, what: string) => setNote((await copyText(text)) ? `Copied ${what}. In Factorio click Import string and paste.` : 'Could not copy: the browser blocked the clipboard.');

  const runImport = () => {
    try {
      const res = designsFromString(importText);
      const skipped = Object.entries(res.unknown).map(([n, c]) => `${c} × ${n}`);
      if (!res.designs.length) {
        setNote(res.empty ? 'No buildings the planner knows in that string.' : 'That string has no blueprints.');
        return;
      }
      onChange([...designs, ...res.designs]);
      setImporting(false);
      setImportText('');
      setNote(`Added ${res.designs.length} design${res.designs.length === 1 ? '' : 's'}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`);
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= designs.length) return;
    const next = [...designs];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <div className="bp-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bp-dialog lib-dialog" role="dialog" aria-modal="true">
        <h3>Designs</h3>
        <div className="bp-label">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={picked ? 'Name for the selection' : 'Select buildings to save them'} disabled={!picked} maxLength={200} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <button className="primary" onClick={save} disabled={!picked}>
            Save selection{picked ? ` (${picked})` : ''}
          </button>
        </div>
        {designs.length === 0 ? (
          <p className="muted small">No designs yet. Select buildings on the map and save them here, or add a blueprint or book from the game.</p>
        ) : (
          <ul className="lib-list">
            {designs.map((d, i) => (
              <li key={d.id}>
                <input
                  className="lib-name"
                  value={d.name}
                  aria-label="Design name"
                  onChange={(e) => onChange(designs.map((x) => (x.id === d.id ? { ...x, name: e.target.value } : x)))}
                />
                <span className="muted small lib-size">
                  {d.clip.entities.length} bldg · {d.clip.w}×{d.clip.h}
                </span>
                <button onClick={() => onPlace(d.clip, d.name)} title="Put it in your hand to place">Place</button>
                <button onClick={() => copy(designString(d), `"${d.name}"`)} title="Copy as a blueprint string">Copy</button>
                <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up" aria-label="Move up">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === designs.length - 1} title="Move down" aria-label="Move down">↓</button>
                <button onClick={() => onChange(designs.filter((x) => x.id !== d.id))} title="Delete" aria-label="Delete">✕</button>
              </li>
            ))}
          </ul>
        )}
        {importing && (
          <>
            <textarea className="bp-text" autoFocus value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste a blueprint or blueprint book string" />
            <div className="tool-row">
              <button className="primary" onClick={runImport} disabled={!importText.trim()}>Add to designs</button>
              <button onClick={() => setImporting(false)}>Cancel</button>
            </div>
          </>
        )}
        <div className="tool-row">
          <button className="primary" disabled={!designs.length} onClick={() => copy(libraryBookString(designs), `a book of ${designs.length} blueprint${designs.length === 1 ? '' : 's'}`)}>
            Copy all as blueprint book
          </button>
          {!importing && <button onClick={() => setImporting(true)}>Add from string</button>}
          <button onClick={onClose}>Close</button>
        </div>
        {note && <p className="small">{note}</p>}
        <p className="muted small">Designs are kept in this browser.</p>
      </div>
    </div>
  );
}
