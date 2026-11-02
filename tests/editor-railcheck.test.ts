import { describe, expect, it } from 'vitest';
import { buildPiece, straightRun } from '../src/rails/geometry';
import { railFromPiece } from '../src/editor/rails';
import { checkLayoutRails, signalOf } from '../src/editor/railCheck';
import { emptyLayout, type Layout, type PlacedEntity } from '../src/editor/model';

// Northbound track from (1, 20) to (1, 0), with a right-hand branch leaving at (1, 10).
const main = straightRun({ x: 1, y: 20, dir: 0 }, 10);
const branch = buildPiece({ x: 1, y: 10, dir: 0 }, 1)!;
const rails = [...main, branch].map((p, i) => railFromPiece(p, `r${i}`));

const signal = (name: string, x: number, y: number, direction: 0 | 1 | 2 | 3): PlacedEntity => ({ id: `${name}@${x},${y}`, name, x, y, direction });
const layoutWith = (...entities: PlacedEntity[]): Layout => ({ ...emptyLayout(), rails, entities });

describe('track checks in the editor', () => {
  it('counts the ends of open track as dead ends', () => {
    const c = checkLayoutRails(layoutWith())!;
    expect(c.pieces).toBe(11);
    expect(c.deadEnds).toHaveLength(3);
  });

  it('a signal building maps back to its joint and travel heading', () => {
    // East of the track at the joint (1, 12), tile (2, 11), guarding northbound trains, facing south.
    expect(signalOf(signal('rail-signal', 2, 11, 2))).toMatchObject({ x: 1, y: 12, dir: 0, kind: 'rail' });
  });

  it('wants a chain signal in front of a junction', () => {
    const rail = checkLayoutRails(layoutWith(signal('rail-signal', 2, 11, 2)))!;
    expect(rail.issues.map((i) => i.message).join()).toMatch(/chain signal/);
    const chain = checkLayoutRails(layoutWith(signal('rail-chain-signal', 2, 11, 2)))!;
    expect(chain.issues).toEqual([]);
    expect(chain.blocks).toBe(2);
  });

  it('flags signals and stops that do not stand beside track', () => {
    const c = checkLayoutRails(layoutWith(signal('rail-signal', 6, 11, 2), signal('rail-signal', 2, 11, 0)))!;
    expect(c.issues.map((i) => i.message)).toEqual([
      'Signal is not beside a rail joint',
      expect.stringMatching(/wrong way/),
    ]);
    const stop = checkLayoutRails(layoutWith({ id: 's', name: 'train-stop', x: 2, y: 14, direction: 0 }))!;
    expect(stop.issues).toEqual([]);
    const off = checkLayoutRails(layoutWith({ id: 's', name: 'train-stop', x: 5, y: 14, direction: 0 }))!;
    expect(off.issues).toHaveLength(1);
  });
});

describe('signals on 45° track', () => {
  // North-east diagonal track from (1, 21): straight 45° pieces.
  const diag = straightRun({ x: 1, y: 21, dir: 2 }, 6).map((p, i) => railFromPiece(p, `d${i}`));

  it('snap beside the track facing a diagonal, and check clean', async () => {
    const { signalAt } = await import('../src/editor/rails');
    // The joint (5, 17); north-east travel; right of it is (1, 1), so the signal stands at (6.5, 17.5).
    const found = signalAt(diag, 6, 17, 0)!;
    expect(found).toEqual({ direction: 2, diagonal: true });
    const s: PlacedEntity = { id: 's', name: 'rail-signal', x: 6, y: 17, ...found, direction: 2 };
    expect(signalOf(s)).toMatchObject({ x: 5, y: 17, dir: 2 });
    expect(checkLayoutRails({ ...emptyLayout(), rails: diag, entities: [s] })!.issues).toEqual([]);
  });

  it('go through blueprints with their diagonal facing', async () => {
    const { layoutToBlueprint, blueprintToClipboard } = await import('../src/blueprint/layout');
    const s: PlacedEntity = { id: 's', name: 'rail-signal', x: 6, y: 17, direction: 2, diagonal: true };
    const { blueprint } = layoutToBlueprint([s], { rails: diag });
    const sig = blueprint.entities!.find((e) => e.name === 'rail-signal')!;
    expect(sig.direction).toBe(10);
    const back = blueprintToClipboard(blueprint).clipboard!;
    expect(back.entities[0]).toMatchObject({ direction: 2, diagonal: true });
  });
});
