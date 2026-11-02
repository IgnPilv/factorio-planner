import { useMemo, useState } from 'react';
import { gameData } from '../data';
import { bonusFamilies, dependents, withPrerequisites, type ResearchSettings } from './research';

export interface ResearchPanelProps {
  settings: ResearchSettings;
  onChange: (s: ResearchSettings) => void;
  onClose?: () => void;
}

/** Toggle research: rate bonuses with level pickers, and optionally which techs are unlocked. */
export function ResearchPanel({ settings, onChange, onClose }: ResearchPanelProps) {
  const families = useMemo(() => bonusFamilies(gameData), []);
  const unlockTechs = useMemo(
    () => Object.values(gameData.technologies).filter((t) => !t.affectsRates).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [],
  );
  const [query, setQuery] = useState('');
  const researched = useMemo(() => withPrerequisites(gameData, settings.unlocked), [settings.unlocked]);

  const setLevel = (id: string, level: number) => onChange({ ...settings, levels: { ...settings.levels, [id]: Math.max(0, level) } });
  const toggleTech = (name: string, on: boolean) => {
    let unlocked: string[];
    if (on) unlocked = [...new Set([...settings.unlocked, name])];
    else {
      // Turning a tech off also turns off everything that needs it, and its own
      // prerequisites stay only if something else still needs them.
      const drop = dependents(gameData, name);
      drop.add(name);
      const keep = [...researched].filter((n) => !drop.has(n));
      unlocked = keep;
    }
    onChange({ ...settings, unlocked });
  };

  const q = query.trim().toLowerCase();
  const shown = q ? unlockTechs.filter((t) => t.displayName.toLowerCase().includes(q) || t.name.includes(q)) : unlockTechs;

  return (
    <aside className="research-panel" aria-label="Research">
      <div className="research-head">
        <h2>Research</h2>
        {onClose && (
          <button className="link" onClick={onClose} aria-label="Close research panel">
            Close
          </button>
        )}
      </div>

      <section>
        <h3>Bonuses that change rates</h3>
        {families.map((f) => {
          const level = settings.levels[f.id] ?? 0;
          return (
            <div key={f.id} className="research-row">
              <label htmlFor={`lvl-${f.id}`}>{f.label}</label>
              <div className="research-level">
                <button onClick={() => setLevel(f.id, level - 1)} disabled={level <= 0} aria-label={`Lower ${f.label}`}>
                  −
                </button>
                <input
                  id={`lvl-${f.id}`}
                  type="number"
                  min={0}
                  max={Number.isFinite(f.max) ? f.max : undefined}
                  value={level}
                  onChange={(e) => setLevel(f.id, Math.min(f.max, Number(e.target.value) || 0))}
                />
                <button onClick={() => setLevel(f.id, Math.min(f.max, level + 1))} disabled={level >= f.max} aria-label={`Raise ${f.label}`}>
                  +
                </button>
                <span className="muted small">
                  {Number.isFinite(f.max) ? `of ${f.max}` : 'infinite'} · {f.describe(level)}
                </span>
              </div>
            </div>
          );
        })}
      </section>

      <section>
        <h3>Unlocks</h3>
        <label className="research-check">
          <input type="checkbox" checked={settings.lockUnlocks} onChange={(e) => onChange({ ...settings, lockUnlocks: e.target.checked })} />
          Only allow what's researched (greenfield start)
        </label>
        {!settings.lockUnlocks && <p className="muted small">Every recipe and building is available. Tick the box to pick techs one by one.</p>}
        {settings.lockUnlocks && (
          <>
            <div className="research-actions">
              <input className="search" placeholder="Search techs" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button onClick={() => onChange({ ...settings, unlocked: [] })}>None</button>
              <button onClick={() => onChange({ ...settings, unlocked: unlockTechs.map((t) => t.name) })}>All</button>
            </div>
            <p className="muted small">
              {[...researched].filter((n) => !gameData.technologies[n]?.affectsRates).length} of {unlockTechs.length} researched. Ticking a
              tech also researches its prerequisites.
            </p>
            <ul className="research-list">
              {shown.map((t) => (
                <li key={t.name}>
                  <label className="research-check">
                    <input type="checkbox" checked={researched.has(t.name)} onChange={(e) => toggleTech(t.name, e.target.checked)} />
                    {t.displayName}
                    {t.unlocksRecipes.length > 0 && <span className="muted small"> · {t.unlocksRecipes.length} {t.unlocksRecipes.length === 1 ? 'recipe' : 'recipes'}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </aside>
  );
}
