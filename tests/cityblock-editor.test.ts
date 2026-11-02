import { describe, expect, it } from 'vitest';
import { layoutToBlueprint } from '../src/blueprint/layout';
import type { Blueprint } from '../src/blueprint/format';
import { blockBlueprint } from '../src/cityblock/export';
import { analyse, avoidRails, buildDesign, joinedRoboports } from '../src/cityblock/block';
import { analyseRobots } from '../src/editor/robots';
import { PRESETS, presetSpec } from '../src/cityblock/presets';
import { designToLayout } from '../src/cityblock/toEditor';
import { checkLayoutRails } from '../src/editor/railCheck';
import { analysePower } from '../src/editor/power';
import { blockOf, buildOccupancy, canPlace, emptyLayout, inCorridor, parseLayout, type Layout } from '../src/editor/model';

describe('city block presets', () => {
  for (const p of PRESETS)
    describe(p.label, () => {
      const spec = presetSpec(p);

      it('passes every check', () => {
        const bad = analyse(buildDesign(spec)).checks.filter((c) => c.status === 'fail' || c.status === 'warn');
        expect(bad.map((c) => c.title)).toEqual([]);
      });

      it('opens in the editor with signals and stops beside the track and nothing overlapping', () => {
        const layout = designToLayout(buildDesign({ ...spec, tiles: 2 }));
        const check = checkLayoutRails(layout)!;
        expect(check.issues).toEqual([]);
        expect(check.signals).toBeGreaterThan(0);
        for (const e of layout.entities) {
          const others = layout.entities.filter((o) => o !== e);
          expect(canPlace(buildOccupancy(others, layout.rails), new Set(), e.name, e.x, e.y, e.direction).ok, `${e.name} at ${e.x},${e.y}`).toBe(true);
        }
        if (spec.station) expect(layout.entities.some((e) => e.name === 'train-stop')).toBe(true);
      });

      it('powers all blocks as one network in the editor', () => {
        const layout = designToLayout(buildDesign({ ...spec, tiles: 2 }));
        expect(analysePower(layout.entities, {}).networks.length).toBe(1);
      });
    });
});

describe('block grid in the editor', () => {
  it('opened designs carry their grid, and nothing but track stands in the corridors', () => {
    for (const p of PRESETS) {
      const layout = designToLayout(buildDesign(presetSpec(p)));
      expect(layout.blockGrid).toMatchObject({ pitch: p.spec.pitch });
      const check = checkLayoutRails(layout)!;
      expect(check.issues.filter((i) => i.message.includes('corridor'))).toEqual([]);
      // The patch is cut at its outer edge: those ends are open, not dead.
      expect(check.deadEnds).toEqual([]);
      expect(check.edgeEnds.length).toBeGreaterThan(0);
    }
  });

  it('flags a building placed in a corridor and survives save and load', () => {
    const layout: Layout = { ...emptyLayout(), blockGrid: { pitch: 100, offset: 0, corridor: 12 } };
    layout.entities.push({ id: 'a', name: 'assembling-machine-1', x: 2, y: 40, direction: 0 });
    layout.entities.push({ id: 'b', name: 'assembling-machine-1', x: 40, y: 40, direction: 0 });
    const issues = checkLayoutRails(layout)!.issues;
    expect(issues.map((i) => i.entityId)).toEqual(['a']);
    expect(parseLayout(JSON.stringify(layout)).blockGrid).toEqual(layout.blockGrid);
    expect(blockOf(layout.blockGrid!, -1, 150)).toEqual([-1, 1]);
    expect(inCorridor(layout.blockGrid!, 5, 50)).toBe(true);
    expect(inCorridor(layout.blockGrid!, 6, 50)).toBe(false);
    expect(inCorridor(layout.blockGrid!, -6, 50)).toBe(true);
    expect(inCorridor(layout.blockGrid!, -7, 50)).toBe(false);
  });
});

describe('blueprints snapped to the block grid', () => {
  it('editor export and the City blocks cell use the same absolute grid', () => {
    const p = PRESETS[1]!;
    const d = buildDesign(presetSpec(p));
    const layout = designToLayout(d);
    const P = layout.blockGrid!.pitch;
    const mod = (v: number) => ((v % P) + P) % P;
    const worldRail = new Set(layout.rails!.map((r) => `${r.name}|${mod(r.x)}|${mod(r.y)}|${r.direction}`));
    const check = (bp: Blueprint) => {
      expect(bp['absolute-snapping']).toBe(true);
      expect(bp['snap-to-grid']).toEqual({ x: P, y: P });
      const rel = bp['position-relative-to-grid'] ?? { x: 0, y: 0 };
      const rails = bp.entities!.filter((e) => e.name === 'straight-rail');
      expect(rails.length).toBeGreaterThan(0);
      for (const e of rails) expect(worldRail.has(`${e.name}|${mod(e.position.x + rel.x)}|${mod(e.position.y + rel.y)}|${e.direction ?? 0}`)).toBe(true);
    };
    // One block's worth of track, picked in the editor.
    const cell = layout.rails!.filter((r) => r.x >= 100 && r.x < 200 && r.y >= 100 && r.y < 200);
    const { blueprint } = layoutToBlueprint([], { rails: cell, grid: layout.blockGrid });
    check(blueprint);
    check(blockBlueprint(d).json.blueprint);
  });
});

describe('one robot network across blocks', () => {
  for (const p of PRESETS)
    it(`${p.label}: joined roboports pass every check and form one network`, () => {
      const base = presetSpec(p);
      const spec = { ...base, buildings: avoidRails(base, [...base.buildings.filter((b) => b.name !== 'roboport'), ...joinedRoboports(base)]) };
      expect(spec.buildings.filter((b) => b.name === 'roboport')).toHaveLength(joinedRoboports(base).length);
      const result = analyse(buildDesign(spec));
      expect(result.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => c.title)).toEqual([]);
      expect(result.checks.find((c) => c.id === 'robots-neighbours')!.title).toMatch(/One global/);
      const layout = designToLayout(buildDesign({ ...spec, tiles: 2 }));
      expect(analyseRobots(layout.entities).networks).toHaveLength(1);
    });
});

describe('turnaround loops at the city edge', () => {
  for (const p of PRESETS)
    it(`${p.label}: a closed network with no open ends that passes every check`, () => {
      const spec = { ...presetSpec(p), edgeLoops: true };
      const result = analyse(buildDesign(spec));
      expect(result.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => `${c.title}: ${c.detail}`)).toEqual([]);
      for (const tiles of [1, 2]) {
        const layout = designToLayout(buildDesign({ ...spec, tiles }));
        const check = checkLayoutRails(layout)!;
        expect(check.issues.map((i) => i.message)).toEqual([]);
        expect(check.deadEnds).toEqual([]);
        expect(check.edgeEnds).toEqual([]);
        for (const e of layout.entities) {
          const others = layout.entities.filter((o) => o !== e);
          expect(canPlace(buildOccupancy(others, layout.rails), new Set(), e.name, e.x, e.y, e.direction).ok, `${e.name} at ${e.x},${e.y}`).toBe(true);
        }
      }
    });
});
