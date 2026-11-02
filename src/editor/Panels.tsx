// Side panels: layout summary (power and production) and the quick search box.

import { useEffect, useRef, useState } from 'react';
import { layoutTotals, type EntityRate } from '../calc';
import { gameData, wikiIconUrl } from '../data';
import { ENTITIES } from './catalog';
import { formatWatts, type PowerReport, type PowerStatus } from './power';
import { quickSearch, type SearchHit } from './search';
import { displayNameOf, fmtRate } from './views';

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
      <h4>Net production</h4>
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
export function QuickSearch({ onPick }: { onPick: (hit: SearchHit) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = quickSearch(query);

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
          } else if (e.key === 'Enter' && hits[active]) {
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
              <button className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => pick(h)}>
                <img src={wikiIconUrl(h.label)} alt="" width={20} height={20} loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
                <span className="hit-label">{h.label}</span>
                <span className="hit-kind">{h.kind === 'building' ? `${ENTITIES[h.building].width}×${ENTITIES[h.building].height}` : `in ${h.detail}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
