/** Per-second flow of one item, fluid or power (watts for "electricity"). */
export interface Flow {
  name: string;
  perSecond: number;
}

/** Add flows with the same name together, dropping near-zero entries. */
export function sumFlows(flows: Iterable<Flow>, epsilon = 1e-9): Flow[] {
  const map = new Map<string, number>();
  for (const f of flows) map.set(f.name, (map.get(f.name) ?? 0) + f.perSecond);
  return [...map]
    .filter(([, v]) => Math.abs(v) > epsilon)
    .map(([name, perSecond]) => ({ name, perSecond }));
}

export function scaleFlows(flows: readonly Flow[], factor: number): Flow[] {
  return flows.map((f) => ({ name: f.name, perSecond: f.perSecond * factor }));
}

export const perMinute = (perSecond: number) => perSecond * 60;
