import { useMemo, useState } from 'react';
import {
  gameData as d, machinesFor, recipesProducing, recipesUsing, techUnlocking,
  type Entity, type Ingredient, type Product, type Technology,
} from '../data';
import type { IconKind } from '../data/icons';
import { GameIcon } from './GameIcon';

type Tab = 'items' | 'recipes' | 'buildings' | 'research';
type Selection = { tab: Tab; name: string } | null;

const TABS: { id: Tab; label: string }[] = [
  { id: 'items', label: 'Items' },
  { id: 'recipes', label: 'Recipes' },
  { id: 'buildings', label: 'Buildings' },
  { id: 'research', label: 'Research' },
];

function fmtPower(w?: number) {
  if (w === undefined) return '';
  if (w >= 1e6) return `${+(w / 1e6).toFixed(2)} MW`;
  if (w >= 1e3) return `${+(w / 1e3).toFixed(1)} kW`;
  return `${w} W`;
}
const fmtNum = (n: number) => String(+n.toFixed(3));

const TAB_KIND = { items: 'item', recipes: 'recipe', buildings: 'entity', research: 'technology' } as const;

function Icon({ name, kind, size = 24 }: { name: string; kind?: IconKind; size?: number }) {
  return <GameIcon name={name} kind={kind} size={size} />;
}

function Amounts({ list, onPick }: { list: (Ingredient | Product)[]; onPick: (name: string) => void }) {
  return (
    <span className="amounts">
      {list.map((x) => (
        <button key={x.name} className="chip" onClick={() => onPick(x.name)} title={d.items[x.name]?.displayName}>
          <Icon name={x.name} size={20} />
          {fmtNum(x.amount)}{'probability' in x && x.probability ? ` (${x.probability * 100}%)` : ''}
          <span className="chip-name">{d.items[x.name]?.displayName ?? x.name}</span>
        </button>
      ))}
    </span>
  );
}

export function DataBrowser() {
  const [tab, setTab] = useState<Tab>('items');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<Selection>({ tab: 'items', name: 'electronic-circuit' });

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const src: { name: string; displayName: string; order?: string }[] =
      tab === 'items' ? Object.values(d.items).filter((i) => !i.hidden)
        : tab === 'recipes' ? Object.values(d.recipes)
          : tab === 'buildings' ? Object.values(d.entities)
            : Object.values(d.technologies);
    return src
      .filter((x) => !q || x.displayName.toLowerCase().includes(q) || x.name.includes(q))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [tab, query]);

  const pickItem = (name: string) => { setTab('items'); setSel({ tab: 'items', name }); };
  const pick = (t: Tab, name: string) => { setTab(t); setSel({ tab: t, name }); };

  return (
    <div className="browser">
      <aside className="browser-list">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <input className="search" placeholder={`Search ${tab}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <ul>
          {list.map((x) => (
            <li key={x.name}>
              <button className={sel?.tab === tab && sel.name === x.name ? 'row active' : 'row'} onClick={() => pick(tab, x.name)}>
                <Icon name={x.name} kind={TAB_KIND[tab]} size={20} /> {x.displayName}
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">{list.length} shown · Factorio {d.version}</p>
      </aside>
      <section className="browser-detail">
        {!sel ? <p className="muted">Pick something on the left.</p>
          : sel.tab === 'items' ? <ItemDetail name={sel.name} onPickItem={pickItem} onPick={pick} />
            : sel.tab === 'recipes' ? <RecipeDetail name={sel.name} onPickItem={pickItem} onPick={pick} />
              : sel.tab === 'buildings' ? <EntityDetail e={d.entities[sel.name]} onPick={pick} />
                : <TechDetail t={d.technologies[sel.name]} onPick={pick} />}
      </section>
    </div>
  );
}

type PickProps = { onPickItem: (n: string) => void; onPick: (t: Tab, n: string) => void };

function Header({ name, displayName, wikiUrl, kind }: { name: string; displayName: string; wikiUrl: string; kind: IconKind }) {
  return (
    <header className="detail-head">
      <Icon name={name} kind={kind} size={40} />
      <h2>{displayName}</h2>
      <a href={wikiUrl} target="_blank" rel="noreferrer">Wiki ↗</a>
    </header>
  );
}

function RecipeLine({ name, onPickItem, onPick }: { name: string } & PickProps) {
  const r = d.recipes[name];
  return (
    <div className="recipe-line">
      <button className="link" onClick={() => onPick('recipes', name)}>{r.displayName}</button>
      <span className="muted"> {r.time}s</span>
      <div className="flow">
        <Amounts list={r.ingredients} onPick={onPickItem} />
        <span className="arrow">→</span>
        <Amounts list={r.results} onPick={onPickItem} />
      </div>
    </div>
  );
}

function ItemDetail({ name, onPickItem, onPick }: { name: string } & PickProps) {
  const it = d.items[name];
  if (!it) return null;
  const made = recipesProducing(d, name);
  const used = recipesUsing(d, name);
  const res = d.resources[name];
  const place = it.placeResult ? d.entities[it.placeResult] : undefined;
  return (
    <div>
      <Header {...it} kind="item" />
      <dl className="stats">
        <dt>Type</dt><dd>{it.type}</dd>
        {it.stackSize && <><dt>Stack size</dt><dd>{it.stackSize}</dd></>}
        {it.fuelValue && <><dt>Fuel value</dt><dd>{fmtPower(it.fuelValue).replace('W', 'J')}</dd></>}
        {res && <><dt>Mined</dt><dd>{res.miningTime}s per unit at mining speed 1{res.requiredFluid ? `, needs ${res.fluidAmount} ${res.requiredFluid} per 10 ore` : ''}</dd></>}
        {name === 'water' && <><dt>Source</dt><dd>Offshore pump, {d.entities['offshore-pump']?.pumpingSpeed}/s</dd></>}
        {place && <><dt>Places</dt><dd><button className="link" onClick={() => onPick('buildings', place.name)}>{place.displayName}</button></dd></>}
      </dl>
      <h3>Made by</h3>
      {made.length ? made.map((r) => <RecipeLine key={r.name} name={r.name} onPickItem={onPickItem} onPick={onPick} />)
        : <p className="muted">{res ? 'Raw resource (mined).' : 'No recipe.'}</p>}
      <h3>Used in</h3>
      {used.length ? used.map((r) => <RecipeLine key={r.name} name={r.name} onPickItem={onPickItem} onPick={onPick} />)
        : <p className="muted">Not used in any recipe.</p>}
    </div>
  );
}

function RecipeDetail({ name, onPickItem, onPick }: { name: string } & PickProps) {
  const r = d.recipes[name];
  if (!r) return null;
  const machines = machinesFor(d, r);
  const tech = techUnlocking(d, name);
  const main = r.results[0];
  return (
    <div>
      <Header name={name} kind="recipe" displayName={r.displayName} wikiUrl={d.items[main?.name]?.wikiUrl ?? ''} />
      <div className="flow big">
        <Amounts list={r.ingredients} onPick={onPickItem} />
        <span className="arrow">→</span>
        <Amounts list={r.results} onPick={onPickItem} />
      </div>
      <dl className="stats">
        <dt>Craft time</dt><dd>{r.time}s</dd>
        <dt>Category</dt><dd>{r.categories.join(', ')}</dd>
        <dt>Productivity</dt><dd>{r.allowProductivity ? 'allowed' : 'not allowed'}</dd>
        <dt>Unlocked by</dt><dd>{r.enabledByDefault ? 'available at start'
          : tech ? <button className="link" onClick={() => onPick('research', tech.name)}>{tech.displayName}</button> : '—'}</dd>
      </dl>
      <h3>Rate per machine</h3>
      <table className="grid">
        <thead><tr><th>Machine</th><th>Speed</th><th>Crafts/min</th>{r.results.map((p) => <th key={p.name}>{d.items[p.name]?.displayName}/min</th>)}</tr></thead>
        <tbody>
          {machines.map((m) => {
            const perMin = (60 * (m.craftingSpeed ?? 1)) / r.time;
            return (
              <tr key={m.name}>
                <td><button className="link" onClick={() => onPick('buildings', m.name)}><Icon name={m.name} kind="entity" size={18} /> {m.displayName}</button></td>
                <td>{m.craftingSpeed}</td>
                <td>{fmtNum(perMin)}</td>
                {r.results.map((p) => <td key={p.name}>{fmtNum(perMin * p.amount * (p.probability ?? 1))}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">Base rates without modules, beacons or research. The rate calculator applies those.</p>
    </div>
  );
}

const ENTITY_FIELDS: [keyof Entity, string, (v: never) => string][] = [
  ['kind', 'Kind', (v: string) => v],
  ['craftingSpeed', 'Crafting speed', (v: number) => String(v)],
  ['miningSpeed', 'Mining speed', (v: number) => `${v} (${v * 60}/min per 1s ore)`],
  ['miningArea', 'Mining area', (v: number) => `${v}×${v}`],
  ['pumpingSpeed', 'Pumping speed', (v: number) => `${v}/s`],
  ['fluidUsage', 'Fluid use', (v: number) => `${v}/s`],
  ['temperature', 'Temperature', (v: number) => `${v} °C`],
  ['powerOutput', 'Power output', (v: number) => fmtPower(v)],
  ['energySource', 'Energy source', (v: string) => v],
  ['energyUsage', 'Energy use', (v: number) => fmtPower(v)],
  ['drain', 'Drain', (v: number) => fmtPower(v)],
  ['moduleSlots', 'Module slots', (v: number) => String(v)],
  ['allowedEffects', 'Allowed effects', (v: string[]) => v.join(', ')],
  ['beltThroughput', 'Throughput', (v: number) => `${v} items/s`],
  ['maxDistance', 'Max distance', (v: number) => `${v} tiles`],
  ['rotationSpeed', 'Rotation speed', (v: number) => `${+(v * 60 * 360).toFixed(1)}°/s`],
  ['supplyAreaDistance', 'Supply area', (v: number) => `${v * 2}×${v * 2}`],
  ['wireReach', 'Wire reach', (v: number) => `${v} tiles`],
  ['inventorySize', 'Slots', (v: number) => String(v)],
  ['fluidCapacity', 'Capacity', (v: number) => String(v)],
  ['distributionEffectivity', 'Distribution effectivity', (v: number) => String(v)],
  ['researchingSpeed', 'Research speed', (v: number) => String(v)],
  ['categories', 'Categories', (v: string[]) => v.join(', ')],
];

function EntityDetail({ e, onPick }: { e?: Entity; onPick: (t: Tab, n: string) => void }) {
  if (!e) return null;
  const recipe = Object.values(d.recipes).find((r) => r.results.some((p) => p.name === e.item));
  const tech = recipe && techUnlocking(d, recipe.name);
  return (
    <div>
      <Header {...e} kind="entity" />
      <dl className="stats">
        <dt>Size</dt><dd>{e.width}×{e.height}</dd>
        {ENTITY_FIELDS.map(([k, label, f]) => e[k] !== undefined && (
          <span key={k} className="contents"><dt>{label}</dt><dd>{f(e[k] as never)}</dd></span>
        ))}
        <dt>Unlocked by</dt><dd>{!recipe || recipe.enabledByDefault ? 'available at start'
          : tech ? <button className="link" onClick={() => onPick('research', tech.name)}>{tech.displayName}</button> : '—'}</dd>
      </dl>
    </div>
  );
}

function describeEffect(ef: Technology['effects'][number]) {
  switch (ef.type) {
    case 'unlock-recipe': return null;
    case 'mining-drill-productivity-bonus': return `Mining productivity +${ef.modifier * 100}%`;
    case 'change-recipe-productivity': return `${d.recipes[ef.recipe]?.displayName ?? ef.recipe} productivity +${ef.modifier * 100}%`;
    case 'laboratory-speed': return `Lab speed +${ef.modifier * 100}%`;
    case 'laboratory-productivity': return `Lab productivity +${ef.modifier * 100}%`;
    case 'inserter-stack-size-bonus': return `Inserter hand size +${ef.modifier}`;
    case 'bulk-inserter-capacity-bonus': return `Bulk inserter hand size +${ef.modifier}`;
    case 'belt-stack-size-bonus': return `Belt stack size +${ef.modifier}`;
    default: return `${ef.name.replace(/-/g, ' ')}${ef.modifier !== undefined ? ` +${+(ef.modifier * 100).toFixed(1)}%` : ''}`;
  }
}

function TechDetail({ t, onPick }: { t?: Technology; onPick: (t: Tab, n: string) => void }) {
  if (!t) return null;
  const bonuses = t.effects.map(describeEffect).filter(Boolean);
  return (
    <div>
      <Header {...t} kind="technology" />
      {t.affectsRates && <p className="badge">Changes production rates</p>}
      <dl className="stats">
        {t.cost && <><dt>Cost</dt><dd>{t.cost.count ?? t.cost.countFormula} × ({t.cost.ingredients.map((i) => d.items[i.name]?.displayName).join(', ')}), {t.cost.time}s each</dd></>}
        {t.maxLevel && <><dt>Max level</dt><dd>{t.maxLevel}</dd></>}
        <dt>Requires</dt><dd>{t.prerequisites.length ? t.prerequisites.map((p) => (
          <button key={p} className="link" onClick={() => onPick('research', p)}>{d.technologies[p]?.displayName ?? p}</button>
        )) : 'nothing'}</dd>
      </dl>
      {bonuses.length > 0 && <><h3>Bonuses</h3><ul>{bonuses.map((b) => <li key={b}>{b}</li>)}</ul></>}
      {t.unlocksRecipes.length > 0 && <><h3>Unlocks</h3>
        <div className="amounts">{t.unlocksRecipes.map((r) => (
          <button key={r} className="chip" onClick={() => onPick('recipes', r)}><Icon name={r} kind="recipe" size={20} /><span className="chip-name">{d.recipes[r]?.displayName ?? r}</span></button>
        ))}</div></>}
    </div>
  );
}
