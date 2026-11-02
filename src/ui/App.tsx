import { useState } from 'react';
import { LayoutEditor } from '../editor/LayoutEditor';
import { DataBrowser } from './DataBrowser';

type View = 'layout' | 'data';

export function App() {
  const [view, setView] = useState<View>('layout');
  return (
    <div className="app">
      <header className="topbar">
        <h1>Factorio Planner</h1>
        <span className="muted">Nauvis · base game</span>
        <nav className="view-tabs">
          <button className={view === 'layout' ? 'active' : ''} onClick={() => setView('layout')}>Layout</button>
          <button className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}>Items and recipes</button>
        </nav>
      </header>
      <div className="view">{view === 'layout' ? <LayoutEditor /> : <DataBrowser />}</div>
    </div>
  );
}
