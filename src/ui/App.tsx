import { useMemo, useState } from 'react';
import { gameData } from '../data';
import { CityBlocks } from '../cityblock/CityBlocks';
import { LayoutEditor } from '../editor/LayoutEditor';
import { DataBrowser } from './DataBrowser';
import { useIconsVersion } from './GameIcon';
import { IconsPanel } from './IconsPanel';
import { loadedIconCount } from '../data/icons';
import { ResearchPanel } from './ResearchPanel';
import { toResearchState, useResearchSettings } from './research';

type View = 'layout' | 'blocks' | 'data';

export function App() {
  const [view, setView] = useState<View>('layout');
  const [researchOpen, setResearchOpen] = useState(false);
  const [iconsOpen, setIconsOpen] = useState(false);
  useIconsVersion();
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
        <button className={`research-toggle icons-toggle${iconsOpen ? ' active' : ''}`} onClick={() => { setIconsOpen((o) => !o); setResearchOpen(false); }} aria-expanded={iconsOpen}
          title={loadedIconCount() ? 'Game icons are loaded' : 'Load the real game icons from your Factorio install'}>
          Icons{loadedIconCount() ? '' : ' •'}
        </button>
        <button className={`research-toggle${researchOpen ? ' active' : ''}`} onClick={() => { setResearchOpen((o) => !o); setIconsOpen(false); }} aria-expanded={researchOpen}>
          Research
        </button>
      </header>
      {researchOpen && <ResearchPanel settings={researchSettings} onChange={setResearchSettings} onClose={() => setResearchOpen(false)} />}
      {iconsOpen && <IconsPanel onClose={() => setIconsOpen(false)} />}
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
