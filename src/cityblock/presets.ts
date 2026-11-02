// Ready-made city-block designs. Every preset passes all the checks in
// block.ts (tests/cityblock-editor.test.ts keeps it that way).

import { avoidRails, corridorSubstations, DEFAULT_SPEC, gridBuildings, type BlockSpec } from './block';

export interface Preset {
  label: string;
  spec: Partial<BlockSpec>;
  substations: number;
  roboports: number;
}

export const PRESETS: (Preset & { note: string })[] = [
  { label: 'Compact 66', note: '1-2 trains, 54×54 to build in, 3×3 substations, 2×2 roboports', spec: { pitch: 66, corridor: 12, trackSpacing: 6, locomotives: 1, wagons: 2, junctions: true, station: false }, substations: 3, roboports: 2 },
  { label: 'Standard 100', note: '1-4 trains, 88×88 to build in, 5×5 substations, 2×2 roboports', spec: { pitch: 100, corridor: 12, trackSpacing: 6, locomotives: 1, wagons: 4, junctions: true, station: false }, substations: 5, roboports: 2 },
  { label: 'Standard 100 + station', note: 'As Standard, with a drive-through 1-4 station in every block, 6×6 substations', spec: { pitch: 100, corridor: 12, trackSpacing: 6, locomotives: 1, wagons: 4, junctions: true, station: true }, substations: 6, roboports: 2 },
  { label: 'Large 150', note: '2-8 trains, 138×138 to build in, 8×8 substations, 3×3 roboports', spec: { pitch: 150, corridor: 12, trackSpacing: 6, locomotives: 2, wagons: 8, junctions: true, station: false }, substations: 8, roboports: 3 },
];


export function presetSpec(p: Preset): BlockSpec {
  const spec = { ...DEFAULT_SPEC, ...p.spec };
  return { ...spec, buildings: avoidRails(spec, [...gridBuildings(spec, p.substations, p.roboports), ...corridorSubstations(spec)]) };
}

