// Side panels: layout summary (power and production) and the quick search box.

import { useEffect, useRef, useState } from 'react';
import { bottlenecks, groupFlows, layoutTotals, type Bottleneck, type EntityRate, type PlacedEntity, type EntityState, type SteadyStateResult, type TransportState } from '../calc';
import { gameData } from '../data';
import { GameIcon } from '../ui/GameIcon';
import { ENTITIES } from './catalog';
import { formatWatts, type PowerReport, type PowerStatus } from './power';
import { quickSearch, type SearchHit } from './search';
import type { Unlocks } from './unlocks';
import { displayNameOf, fmtRate, STATUS_COLORS, STATUS_LABELS } from './views';

const YELLOW_BELT = 15; // items per second

const STATUS_TEXT: Record<PowerStatus, string> = {
  powered: 'Powered',
  low: 'Low power',
  'no-power': 'No power: the network has no generator',
  unconnected: 'Not connected: no electric pole covers it',
};

function Bar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const color = value >= 0.999 ? '#4cd964' : value >= 0.5 ? '#ffcc00' : '#ff4d4d';
  return (
    <span className="bar">
      <span style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

export function PowerSummary({ power }: { power: PowerReport }) {
  const unconnected = Object.values(power.status).filter((s) => s === 'unconnected').length;
  const ratio = power.totalDemandW > 0 ? power.totalSupplyW / power.totalDemandW : 1;
  return (
    <section className="summary-section">
      <h4>Electricity</h4>
      <dl className="kv">
        <dt>Production</dt>
        <dd>{formatWatts(power.totalSupplyW)}</dd>
        <dt>Consumption</dt>
        <dd>{formatWatts(power.totalDemandW)}</dd>
      </dl>
      {power.totalDemandW > 0 && <Bar value={ratio} />}
      {power.networks.length > 1 &&
        power.networks.map((n) => (
          <div key={n.id} className="network-row">
            <span>Network {n.id + 1}</span>
            <span className="muted">
              {formatWatts(n.supplyW)} / {formatWatts(n.demandW)}
            </span>
            <Bar value={n.satisfaction} />
          </div>
        ))}
      {unconnected > 0 && <p className="warn">{unconnected} machine{unconnected > 1 ? 's' : ''} not covered by a pole</p>}
      {power.networks.some((n) => n.demandW > 0 && n.supplyW === 0) && <p className="warn">A network has consumers but no generator</p>}
      {power.totalSupplyW > 0 && power.totalSupplyW < power.totalDemandW && (
        <p className="warn">Demand exceeds production by {formatWatts(power.totalDemandW - power.totalSupplyW)}</p>
      )}
      <p className="muted small">Solar counts at its day-night average. Steam engines count at full output.</p>
    </section>
  );
}

export function ProductionSummary({ rates }: { rates: Record<string, EntityRate> }) {
  const totals = layoutTotals(rates);
  const net = [...totals.net].sort((a, b) => b.perSecond - a.perSecond);
  if (!net.length) return null;
  return (
    <section className="summary-section">
      <h4>Full-speed balance</h4>
      <table className="flows">
        <thead>
          <tr>
            <th />
            <th>/min</th>
            <th title="Yellow belts' worth (15 items/s); fluids in units">belts</th>
          </tr>
        </thead>
        <tbody>
          {net.map((f) => {
            const fluid = gameData.items[f.name]?.type === 'fluid';
            return (
              <tr key={f.name} className={f.perSecond < 0 ? 'neg' : ''}>
                <td>{displayNameOf(f.name)}</td>
                <td>{f.perSecond > 0 ? '+' : ''}{fmtRate(f.perSecond * 60)}</td>
                <td className="muted">{fluid ? '' : fmtRate(Math.abs(f.perSecond) / YELLOW_BELT)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">Machines at full speed; negative means the layout needs it from outside.</p>
    </section>
  );
}

export function MachineRates({ rate, status }: { rate?: EntityRate; status?: PowerStatus }) {
  if (!rate) return null;
  const outputs = rate.outputs.filter((o) => o.name !== 'electricity');
  return (
    <section className="summary-section">
      {outputs.length > 0 && (
        <>
          <h4>Output</h4>
          <ul className="flow-list">
            {outputs.map((o) => (
              <li key={o.name}>
                {displayNameOf(o.name)} <b>{fmtRate(o.perSecond * 60)}/min</b>
              </li>
            ))}
          </ul>
        </>
      )}
      {rate.inputs.length > 0 && (
        <>
          <h4>Input</h4>
          <ul className="flow-list">
            {rate.inputs.map((o) => (
              <li key={o.name}>
                {displayNameOf(o.name)} <b>{fmtRate(o.perSecond * 60)}/min</b>
              </li>
            ))}
          </ul>
        </>
      )}
      {(rate.speedBonus !== 0 || rate.productivityBonus !== 0) && (
        <p className="muted small">
          Speed {rate.speedBonus >= 0 ? '+' : ''}{Math.round(rate.speedBonus * 100)}% · productivity +{Math.round(rate.productivityBonus * 100)}%
          {rate.beacons > 0 && ` · ${rate.beacons} beacon${rate.beacons > 1 ? 's' : ''}`}
        </p>
      )}
      {rate.powerW !== 0 && (
        <p>
          {rate.powerW > 0 ? `Uses ${formatWatts(rate.powerW)}` : `Produces ${formatWatts(-rate.powerW)}`}
          {status && <span className={`power-status ${status}`}> · {STATUS_TEXT[status]}</span>}
        </p>
      )}
      {rate.fuelW > 0 && <p className="muted">Burns {formatWatts(rate.fuelW)} of fuel</p>}
      {rate.warnings.map((w) => (
        <p key={w} className="warn">{w}</p>
      ))}
    </section>
  );
}

/** Search box over buildings, recipes and resources. "/" focuses it from anywhere in the editor. */
export function QuickSearch({ onPick, unlocks }: { onPick: (hit: SearchHit) => void; unlocks?: Unlocks }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = quickSearch(query, 12, unlocks);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (ev.key === '/' || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k')) {
        ev.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setActive(0), [query]);

  const pick = (hit: SearchHit) => {
    onPick(hit);
    setQuery('');
    input.current?.blur();
  };

  return (
    <div className="quick-search">
      <input
        ref={input}
        type="search"
        placeholder="Search buildings, recipes…  ( / )"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(hits.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter' && hits[active] && !hits[active].locked) {
            pick(hits[active]);
          } else if (e.key === 'Escape') {
            setQuery('');
            input.current?.blur();
          }
        }}
      />
      {query.trim() && (
        <ul className="search-results">
          {hits.length === 0 && <li className="muted">No matches</li>}
          {hits.map((h, i) => (
            <li key={`${h.kind}:${h.building}:${h.recipe ?? ''}`}>
              <button
                className={`${i === active ? 'active' : ''}${h.locked ? ' locked' : ''}`}
                disabled={h.locked}
                title={h.locked ? 'Not researched yet (see Research)' : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(h)}
              >
                <GameIcon name={h.recipe ?? h.building} kind={h.kind === 'building' ? 'entity' : h.kind === 'recipe' ? 'recipe' : 'item'} size={20} className="" />
                <span className="hit-label">{h.label}</span>
                <span className="hit-kind">
                  {h.locked ? 'not researched' : h.kind === 'building' ? `${ENTITIES[h.building].width}×${ENTITIES[h.building].height}` : `in ${h.detail}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** Simulated state of one building: status and actual activity, or belt/inserter load. */
export function FlowState({ state, transport }: { state?: EntityState; transport?: TransportState }) {
  if (transport) {
    return (
      <section className="summary-section">
        <h4>Throughput</h4>
        <p>
          {fmtRate(transport.perSecond)}/s of {fmtRate(transport.capacity)}/s ({Math.round(transport.utilization * 100)}%)
        </p>
        {transport.powerShare === 0 && <p className="warn">No power: no electric pole reaches this inserter.</p>}
        {transport.powerShare !== undefined && transport.powerShare > 0 && (
          <p className="warn">Low power: runs at {Math.round(transport.powerShare * 100)}% speed.</p>
        )}
        {transport.items.length > 0 && (
          <ul className="flow-list">
            {transport.items.map((f) => (
              <li key={f.name}>
                {displayNameOf(f.name)} <b>{fmtRate(f.perSecond * 60)}/min</b>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  if (!state) return null;
  const outputs = state.rate.outputs.filter((o) => o.name !== 'electricity');
  return (
    <section className="summary-section">
      <h4>As built</h4>
      <p>
        <span className="status-dot" style={{ background: hex(STATUS_COLORS[state.status]) }} /> {STATUS_LABELS[state.status]}
        {state.status !== 'no-recipe' && ` · ${Math.round(state.activity * 100)}% speed`}
      </p>
      {state.missing?.length ? <p className="warn">Nothing delivers: {state.missing.map(displayNameOf).join(', ')}</p> : null}
      {outputs.length > 0 && state.activity < 0.999 && (
        <p className="muted small">
          Actually making {outputs.map((o) => `${fmtRate(o.perSecond * 60)}/min ${displayNameOf(o.name)}`).join(', ')}
        </p>
      )}
    </section>
  );
}

/** Whole-layout result of the steady-state simulation. */
export function SimSummary({ sim }: { sim: SteadyStateResult | null }) {
  if (!sim) return null;
  const counts = new Map<string, number>();
  for (const s of Object.values(sim.entities)) if (s.status !== 'working' && s.status !== 'no-recipe') counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  const full = Object.values(sim.transport).filter((t) => t.utilization >= 0.99).length;
  if (!sim.outputs.length && !sim.inputs.length && !counts.size && !full && !sim.warnings.length) return null;
  return (
    <section className="summary-section">
      <h4>As built</h4>
      {sim.outputs.length > 0 && (
        <>
          <span className="muted small">Leaves the layout (open belt ends, chests)</span>
          <table className="flows">
            <tbody>
              {sim.outputs.map((f) => (
                <tr key={f.name}>
                  <td>{displayNameOf(f.name)}</td>
                  <td>{fmtRate(f.perSecond * 60)}/min</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {sim.inputs.length > 0 && (
        <>
          <span className="muted small">Taken from supply chests</span>
          <table className="flows">
            <tbody>
              {sim.inputs.map((f) => (
                <tr key={f.name}>
                  <td>{displayNameOf(f.name)}</td>
                  <td>{fmtRate(f.perSecond * 60)}/min</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {[...counts].map(([status, n]) => (
        <p key={status}>
          <span className="status-dot" style={{ background: hex(STATUS_COLORS[status as keyof typeof STATUS_COLORS]) }} /> {n} {STATUS_LABELS[status as keyof typeof STATUS_LABELS].split(':')[0].toLowerCase()}
        </p>
      ))}
      {full > 0 && <p className="warn">{full} belt or inserter{full > 1 ? 's' : ''} running full</p>}
      {sim.warnings.slice(0, 5).map((w) => (
        <p key={w} className="muted small">{w}</p>
      ))}
      <p className="muted small">The Logistics view (V) colours machines by status and belts by load.</p>
    </section>
  );
}

const BOTTLENECK_TEXT: Record<Bottleneck['kind'], string> = {
  missing: 'nothing delivers',
  unpowered: 'no pole reaches it',
  starved: 'starved',
  'output-blocked': 'output blocked',
  power: 'short of power',
  transport: 'running full, carrying',
};

/** What holds the layout back, worst first; click a row to select those buildings. */
export function Bottlenecks({ sim, entities, onSelect }: { sim: SteadyStateResult | null; entities: readonly PlacedEntity[]; onSelect: (ids: string[]) => void }) {
  if (!sim) return null;
  const list = bottlenecks(sim, entities);
  if (!list.length) return null;
  return (
    <section className="summary-section">
      <h4>Bottlenecks</h4>
      <ul className="bottlenecks">
        {list.slice(0, 12).map((b) => {
          const what = ENTITIES[b.entity]?.displayName ?? b.entity;
          const items = b.items.map(displayNameOf).join(', ');
          return (
            <li key={`${b.kind}|${b.entity}|${b.recipe}|${b.items.join()}`}>
              <button className="link" onClick={() => onSelect(b.ids)} title="Select these buildings">
                {b.ids.length} × {what}
                {b.recipe && b.kind !== 'transport' && <> ({displayNameOf(b.recipe)})</>}
              </button>{' '}
              <span className={b.kind === 'output-blocked' ? 'muted' : 'warn'}>
                {BOTTLENECK_TEXT[b.kind]}
                {items && ` ${items}`}
              </span>
              {b.lost > 0.005 && <span className="muted small"> · {fmtRate(b.lost)} {Math.abs(b.lost - 1) < 0.005 ? "machine's" : "machines'"} worth lost</span>}
            </li>
          );
        })}
      </ul>
      <p className="muted small">Click a row to select those buildings. Full belts and inserters are listed when they carry something a starved machine is short of.</p>
    </section>
  );
}

/** Net in and out of the selected buildings, as built. */
export function SelectionFlows({ sim, ids }: { sim: SteadyStateResult | null; ids: string[] }) {
  if (!sim) return null;
  const g = groupFlows(sim, ids);
  if (!g.machines) return null;
  return (
    <section className="summary-section">
      <h4>Selection as built</h4>
      <p className="small">
        {g.machines} machine{g.machines === 1 ? '' : 's'}
        {g.slowed > 0 && <span className="warn"> · {g.slowed} below full speed</span>}
        {g.powerW > 0 && <> · {formatWatts(g.powerW)}</>}
      </p>
      {g.net.length > 0 && (
        <table className="flows">
          <thead>
            <tr>
              <th />
              <th>/min</th>
              <th title="Yellow belts' worth (15 items/s); fluids in units">belts</th>
            </tr>
          </thead>
          <tbody>
            {g.net.map((f) => {
              const fluid = gameData.items[f.name]?.type === 'fluid';
              return (
                <tr key={f.name} className={f.perSecond < 0 ? 'neg' : ''}>
                  <td>{displayNameOf(f.name)}</td>
                  <td>{f.perSecond > 0 ? '+' : ''}{fmtRate(f.perSecond * 60)}</td>
                  <td className="muted">{fluid ? '' : fmtRate(Math.abs(f.perSecond) / YELLOW_BELT)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">Negative means the selection needs it from outside.</p>
    </section>
  );
}

/** What the labs research, how fast, and which packs they use; pick another tech. */
export function ResearchSummary({ sim, chosen, onChoose }: { sim: SteadyStateResult | null; chosen: string; onChoose: (tech: string) => void }) {
  const r = sim?.research;
  if (!r) return null;
  const techName = (n: string) => gameData.technologies[n]?.displayName ?? n;
  const tech = gameData.technologies[r.tech];
  const options = r.choices.includes(r.tech) ? r.choices : [r.tech, ...r.choices];
  return (
    <section className="summary-section">
      <h4>Research</h4>
      <label className="small">
        Labs research{' '}
        <select value={chosen} onChange={(e) => onChoose(e.target.value)} aria-label="Technology the labs research">
          <option value="">Most advanced possible ({techName(r.choices[0] ?? r.tech)})</option>
          {options.map((n) => (
            <option key={n} value={n}>
              {techName(n)}
            </option>
          ))}
        </select>
      </label>
      <p>
        <b>{fmtRate(r.unitsPerSecond * 60)}</b> units/min
        {tech?.cost && <span className="muted small"> · {tech.cost.time} s per unit</span>}
      </p>
      {r.packs.length > 0 && (
        <table className="flows">
          <tbody>
            {r.packs.map((f) => (
              <tr key={f.name}>
                <td>{displayNameOf(f.name)}</td>
                <td>{fmtRate(f.perSecond * 60)}/min</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
