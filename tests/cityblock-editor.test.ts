import { describe, expect, it } from 'vitest';
import { analyse, buildDesign } from '../src/cityblock/block';
import { PRESETS, presetSpec } from '../src/cityblock/presets';
import { designToLayout } from '../src/cityblock/toEditor';
import { checkLayoutRails } from '../src/editor/railCheck';
import { analysePower } from '../src/editor/power';
import { buildOccupancy, canPlace } from '../src/editor/model';

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
