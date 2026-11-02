import { useMemo, useState } from 'react';
import { gameData } from '../data';
import { CityBlocks } from '../cityblock/CityBlocks';
import { LayoutEditor } from '../editor/LayoutEditor';
import { DataBrowser } from './DataBrowser';
import { ResearchPanel } from './ResearchPanel';
import { toResearchState, useResearchSettings } from './research';

type View = 'layout' | 'blocks' | 'data';

export function App() {
  const [view, setView] = useState<View>('layout');
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchSettings, setResearchSettings] = useResearchSettings();
  const research = useMemo(() => toResearchState(gameData, researchSettings), [researchSettings]);
  return (
    <div className="app">
      <header className="topbar">
        <h1>Factorio Planner</h1>
        <span className="muted">Nauvis · base game</span>
        <nav className="view-tabs">
          <button className={view === 'layout' ? 'active' : ''} onClick={() => setView('layout')}>Layout</button>
          <button className={view === 'blocks' ? 'active' : ''} onClick={() => setView('blocks')}>City blocks</button>
          <button className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}>Items and recipes</button>
        </nav>
        <button className={`research-toggle${researchOpen ? ' active' : ''}`} onClick={() => setResearchOpen((o) => !o)} aria-expanded={researchOpen}>
          Research
        </button>
      </header>
      {researchOpen && <ResearchPanel settings={researchSettings} onChange={setResearchSettings} onClose={() => setResearchOpen(false)} />}
      {/* The editor stays mounted so its camera and undo history survive a tab switch. */}
      <div className="view" hidden={view !== 'layout'}>
        <LayoutEditor research={research} />
      </div>
      {view === 'blocks' && (
        <div className="view">
          <CityBlocks />
        </div>
      )}
      {view === 'data' && (
        <div className="view">
          <DataBrowser />
        </div>
      )}
    </div>
  );
}
