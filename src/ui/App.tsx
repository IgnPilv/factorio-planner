import { DataBrowser } from './DataBrowser';

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Factorio Planner</h1>
        <span className="muted">Nauvis · base game</span>
      </header>
      <DataBrowser />
    </div>
  );
}
