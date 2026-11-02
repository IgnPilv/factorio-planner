import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_VERSION,
  decodeBlueprintString,
  decodeJsonString,
  decodeVersion,
  encodeBlueprintString,
  encodeJsonString,
  encodeVersion,
  makeBlueprint,
} from '../src/blueprint/format';
import { blueprintToClipboard, layoutToBlueprint } from '../src/blueprint/layout';
import { clipboardAt, emptyLayout, pasteClipboard, type PlacedEntity } from '../src/editor/model';

// Real Factorio 2.0 blueprint strings, taken from the test suite of
// Factorio-Draftsman (github.com/redruin1/factorio-draftsman, MIT).
// A belt feeding a fast inserter into an electric furnace, a second fast
// inserter taking the output, and a medium pole. Version 2.0.47.
const FURNACE_2_0 =
  '0eNqVkuFqhTAMhd8lv+tFvdZNX+UyRtXcEWijtHXsIn33Vbe5gQrzZ5qeLyeHTNDoEQdL7KGegNqeHdS3CRy9sdLzGyuDUANqbL2lNrmPllWLEAQQd/gBdRZeBCB78oRf6qV4vPJoGrTxg/ihGOxoNMkKG3qNIGDoXRT3PM+LwOeLFPCIuosMQWxw+YrzVrEbeuuTBrXfguQ36LoPup4G5fugYgXdlfMJsUPrY2PDKf8YEtCRjTks3SzfwUpxmP5hZgerlv91mKWnLD6djrCYDcaDIY8myn7vT8A7WrcIZJlXRVXJUqaZTIsQPgElXN/P';
// Three big poles wired together, beacons with speed modules, an assembler. Version 2.0.28.1.
const BEACONS_2_0 =
  '0eNrNlNtugzAMht/F16Eqh4TDq1RVxcFl0SCgBNqxinefCxtdByrrXRFChNjf79jGF0iKFmstVQPRBWRaKQPR7gJG5iourt9UXCJEkGBMm9AzkCrDD4jsfs8AVSMbiaPPsOgOqi0T1GTAfnyxwLTRMrVQoc47i9RQH+MUgUFdGSIQmaSI6oqAQUfObkhSSXs8oj4Y+UkYeztdPZupOZNaInNrUqyrYlHFH1U8u19guU+x/Ics7ylWED5icfanGnMA5xv+jXA3fAki/gEJ7iBU8gbLscYy+9UTpkbMrLLK2gItF26GZKcOUp1IutLd6HhbUWOYJk7fIRoKubhD3dXTPQ/fXw9fiLUcBOsQX7xuDsL18IMXLqG9neKPjcEyKaTKrTJO36S6BjE/TWjfV5Qmz1nqYezsHMaZy/ie7ejJPHrbj4e4pmcabgxOqM2A5MIJvTDk3OHCdehH+wIapKEo';

describe('blueprint string format', () => {
  it('decodes real 2.0 strings', () => {
    const bp = decodeBlueprintString(FURNACE_2_0);
    expect(bp.item).toBe('blueprint');
    expect(decodeVersion(bp.version)).toEqual([2, 0, 47, 0]);
    expect(bp.entities).toHaveLength(7);
    const inserter = bp.entities!.find((e) => e.name === 'fast-inserter')!;
    expect(inserter).toMatchObject({ position: { x: 6.5, y: 3.5 }, direction: 12 });

    const beacons = decodeBlueprintString(BEACONS_2_0);
    expect(beacons.wires).toEqual([[2, 5, 3, 5], [3, 5, 4, 5]]);
    expect(beacons.entities![5]!.items).toEqual([
      { id: { name: 'speed-module-3' }, items: { in_inventory: [{ inventory: 1, stack: 0 }, { inventory: 1, stack: 1 }] } },
    ]);
  });

  it('re-encodes real strings to the same JSON', () => {
    for (const s of [FURNACE_2_0, BEACONS_2_0]) {
      const json = decodeJsonString(s);
      expect(decodeJsonString(encodeJsonString(json))).toEqual(json);
      expect(encodeJsonString(json)[0]).toBe('0');
    }
  });

  it('packs versions like the game', () => {
    expect(encodeVersion(2, 0, 47, 0)).toBe(562949956501504);
    expect(encodeVersion(2, 0, 28, 1)).toBe(562949955256321);
    expect(decodeVersion(BLUEPRINT_VERSION)).toEqual([2, 0, 0, 0]);
  });

  it('accepts raw JSON and books, rejects junk', () => {
    expect(decodeBlueprintString(JSON.stringify({ blueprint: { item: 'blueprint', version: 1 } })).item).toBe('blueprint');
    const book = encodeJsonString({
      blueprint_book: { item: 'blueprint-book', active_index: 1, blueprints: [{ index: 0, blueprint: { label: 'a' } }, { index: 1, blueprint: { label: 'b' } }] },
    });
    expect(decodeBlueprintString(book).label).toBe('b');
    expect(() => decodeBlueprintString('0notbase64!!')).toThrow();
    expect(() => decodeBlueprintString(encodeJsonString({ upgrade_planner: {} }))).toThrow(/upgrade planner/);
  });

  it('numbers entities and wires from 1 and omits north', () => {
    const bp = makeBlueprint(
      [
        { name: 'small-electric-pole', position: { x: 0.5, y: 0.5 }, direction: 0 },
        { name: 'small-electric-pole', position: { x: 5.5, y: 0.5 } },
      ],
      { wires: [[0, 5, 1, 5]] },
    );
    expect(bp.entities!.map((e) => e.entity_number)).toEqual([1, 2]);
    expect('direction' in bp.entities![0]!).toBe(false);
    expect(bp.wires).toEqual([[1, 5, 2, 5]]);
    expect(bp.icons).toEqual([{ index: 1, signal: { type: 'item', name: 'small-electric-pole' } }]);
  });
});

let n = 0;
const ent = (name: string, x: number, y: number, direction: 0 | 1 | 2 | 3 = 0, extra: Partial<PlacedEntity> = {}): PlacedEntity => ({
  id: `t${n++}`,
  name,
  x,
  y,
  direction,
  ...extra,
});

describe('layout to blueprint', () => {
  it('uses centre positions for odd and even sizes', () => {
    const { blueprint } = layoutToBlueprint([
      ent('assembling-machine-2', 10, 10), // 3x3
      ent('transport-belt', 13, 10, 1), // 1x1
      ent('splitter', 14, 10, 1), // 1x2 when facing east (2x1 north)
      ent('steam-engine', 20, 10, 1), // 3x5 -> 5x3 facing east
    ]);
    const pos = Object.fromEntries(blueprint.entities!.map((e) => [e.name, e.position]));
    expect(pos['assembling-machine-2']).toEqual({ x: 1.5, y: 1.5 });
    expect(pos['transport-belt']).toEqual({ x: 3.5, y: 0.5 });
    expect(pos['splitter']).toEqual({ x: 4.5, y: 1 });
    expect(pos['steam-engine']).toEqual({ x: 12.5, y: 1.5 });
  });

  it('writes 16-way directions, flipping inserters to face their pickup', () => {
    const { blueprint } = layoutToBlueprint([
      ent('transport-belt', 0, 0, 1), // east
      ent('transport-belt', 1, 0, 2), // south
      ent('fast-inserter', 2, 0, 1), // moves items east -> picks up from the west
    ]);
    const [a, b, c] = blueprint.entities!;
    expect(a!.direction).toBe(4);
    expect(b!.direction).toBe(8);
    expect(c!.direction).toBe(12);
  });

  it('marks underground belt pairs and pipe-to-ground facings', () => {
    const { blueprint } = layoutToBlueprint([
      ent('underground-belt', 0, 0, 1),
      ent('underground-belt', 4, 0, 1),
      ent('pipe-to-ground', 0, 5, 0),
      ent('pipe-to-ground', 0, 9, 0),
    ]);
    const [ugIn, ugOut, p1, p2] = blueprint.entities!;
    expect(ugIn).toMatchObject({ type: 'input', direction: 4 });
    expect(ugOut).toMatchObject({ type: 'output', direction: 4 });
    expect(p1!.direction).toBeUndefined(); // top one faces north, tunnel runs south
    expect(p2!.direction).toBe(8);
  });

  it('writes recipes and modules for machines, not for drills or furnaces', () => {
    const { blueprint } = layoutToBlueprint([
      ent('assembling-machine-2', 0, 0, 0, { recipe: 'iron-gear-wheel', modules: ['speed-module', 'speed-module'] }),
      ent('electric-mining-drill', 4, 0, 0, { recipe: 'iron-ore', modules: ['productivity-module', '', 'speed-module'] }),
      ent('electric-furnace', 8, 0, 0, { recipe: 'iron-plate' }),
      ent('beacon', 12, 0, 0, { modules: ['speed-module-3', 'speed-module-3'] }),
    ]);
    const [am, drill, furnace, beacon] = blueprint.entities!;
    expect(am!.recipe).toBe('iron-gear-wheel');
    expect(am!.items).toEqual([{ id: { name: 'speed-module' }, items: { in_inventory: [{ inventory: 4, stack: 0 }, { inventory: 4, stack: 1 }] } }]);
    expect(drill!.recipe).toBeUndefined();
    expect(drill!.items).toEqual([
      { id: { name: 'productivity-module' }, items: { in_inventory: [{ inventory: 2, stack: 0 }] } },
      { id: { name: 'speed-module' }, items: { in_inventory: [{ inventory: 2, stack: 2 }] } },
    ]);
    expect(furnace!.recipe).toBeUndefined();
    expect(beacon!.items).toEqual(decodeBlueprintString(BEACONS_2_0).entities![5]!.items);
  });

  it('wires poles as a spanning tree within reach', () => {
    const { blueprint } = layoutToBlueprint([
      ent('small-electric-pole', 0, 0),
      ent('small-electric-pole', 5, 0),
      ent('small-electric-pole', 10, 0),
      ent('small-electric-pole', 5, 4), // in reach of all three
      ent('small-electric-pole', 40, 0), // out of reach
    ]);
    expect(blueprint.wires).toHaveLength(3);
    for (const w of blueprint.wires!) expect([w[1], w[3]]).toEqual([5, 5]);
    expect(blueprint.wires!.flatMap((w) => [w[0], w[2]])).not.toContain(5);
  });
});

describe('blueprint import', () => {
  it('turns the real furnace blueprint into editor buildings', () => {
    const { clipboard, unknown } = blueprintToClipboard(decodeBlueprintString(FURNACE_2_0));
    expect(unknown).toEqual({});
    const by = (name: string) => clipboard!.entities.filter((e) => e.name === name);
    // belt at x 5.5, inserter at 6.5, furnace centred on 8.5 -> tiles 7..9
    expect(by('electric-furnace')[0]).toMatchObject({ x: 2, y: 1 });
    // the inserters pick up from the west, so items travel east in editor terms
    for (const ins of by('fast-inserter')) expect(ins.direction).toBe(1);
    expect(by('fast-inserter').map((e) => e.x).sort()).toEqual([1, 5]);
  });

  it('round-trips a layout through a string', () => {
    const layout = [
      ent('assembling-machine-3', 0, 0, 1, { recipe: 'electronic-circuit', modules: ['productivity-module-3', '', '', 'speed-module-3'] }),
      ent('long-handed-inserter', 3, 1, 3),
      ent('underground-belt', 4, 0, 2),
      ent('underground-belt', 4, 5, 2),
      ent('splitter', 6, 0, 3),
      ent('medium-electric-pole', 8, 4),
      ent('offshore-pump', 10, 0, 2),
      ent('boiler', 12, 0, 1),
    ];
    const s = encodeBlueprintString(layoutToBlueprint(layout).blueprint);
    const { clipboard } = blueprintToClipboard(decodeBlueprintString(s));
    const strip = (es: Omit<PlacedEntity, 'id'>[]) => es.map(({ name, x, y, direction, recipe, modules }) => ({ name, x, y, direction, recipe, modules }));
    expect(strip(clipboard!.entities)).toEqual(strip(layout.map(({ id: _id, ...e }) => e)));
  });

  it('reads 1.1 blueprints (8-way directions, module maps)', () => {
    const { clipboard } = blueprintToClipboard({
      item: 'blueprint',
      version: encodeVersion(1, 1, 110, 0),
      entities: [
        { entity_number: 1, name: 'transport-belt', position: { x: 0.5, y: 0.5 }, direction: 2 },
        { entity_number: 2, name: 'assembling-machine-2', position: { x: 2.5, y: 1.5 }, items: { 'speed-module': 2 } },
        { entity_number: 3, name: 'filter-inserter', position: { x: 5.5, y: 0.5 } },
      ],
    });
    expect(clipboard!.entities[0]!.direction).toBe(1);
    expect(clipboard!.entities[1]!.modules).toEqual(['speed-module', 'speed-module']);
    expect(clipboard!.entities).toHaveLength(2);
  });

  it('pastes into a layout', () => {
    const { clipboard } = blueprintToClipboard(decodeBlueprintString(FURNACE_2_0));
    const res = pasteClipboard(emptyLayout(), clipboard!, 0, 0);
    expect(res.blocked).toBe(0);
    expect(res.placed).toHaveLength(7);
    expect(clipboardAt(clipboard!, 0, 0)).toHaveLength(7);
  });
});
