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
  type BlueprintEntityInput,
} from '../src/blueprint/format';
import { blueprintToClipboard, layoutToBlueprint, vanillaName } from '../src/blueprint/layout';
import { railPiece, signalAt, type PlacedRail } from '../src/editor/rails';
import { checkRails } from '../src/rails/geometry';
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
    expect(BLUEPRINT_VERSION).toBe(562949954076673);
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
      ent('radar', 16, 0),
      ent('arithmetic-combinator', 20, 0, 1),
      ent('decider-combinator', 23, 0, 2),
      ent('gate', 26, 0, 1),
      ent('stone-wall', 27, 0),
      ent('small-lamp', 28, 0),
      ent('laser-turret', 30, 0),
      ent('heat-pipe', 33, 0),
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
        { entity_number: 3, name: 'filter-inserter', position: { x: 5.5, y: 0.5 }, direction: 2, filters: [{ index: 1, name: 'coal' }] },
        { entity_number: 4, name: 'logistic-chest-requester', position: { x: 6.5, y: 0.5 } },
        { entity_number: 5, name: 'straight-rail', position: { x: 9, y: 1 } },
      ],
    });
    expect(clipboard!.entities[0]!.direction).toBe(1);
    expect(clipboard!.entities[1]!.modules).toEqual(['speed-module', 'speed-module']);
    // renamed in 2.0; 1.1 inserters also face their pickup side
    expect(clipboard!.entities[2]).toMatchObject({ name: 'fast-inserter', direction: 3, filters: ['coal'] });
    expect(clipboard!.entities[3]!.name).toBe('requester-chest');
    expect(clipboard!.entities).toHaveLength(4);
  });

  it('keeps 2.0 names as they are', () => {
    const { unknown } = blueprintToClipboard({
      item: 'blueprint',
      version: BLUEPRINT_VERSION,
      entities: [{ entity_number: 1, name: 'stack-inserter', position: { x: 0.5, y: 0.5 } }],
    });
    expect(unknown).toEqual({ 'stack-inserter': 1 });
  });

  it('pastes into a layout', () => {
    const { clipboard } = blueprintToClipboard(decodeBlueprintString(FURNACE_2_0));
    const res = pasteClipboard(emptyLayout(), clipboard!, 0, 0);
    expect(res.blocked).toBe(0);
    expect(res.placed).toHaveLength(7);
    expect(clipboardAt(clipboard!, 0, 0)).toHaveLength(7);
  });
});

describe('against blueprints made by the game', () => {
  it('import then export reproduces positions, directions and belt types', async () => {
    const { GAME_BLUEPRINTS } = await import('./fixtures/game-blueprints');
    const { ENTITIES } = await import('../src/editor/catalog');
    let checked = 0;
    for (const s of GAME_BLUEPRINTS) {
      const bp = decodeBlueprintString(s);
      bp.entities = (bp.entities ?? []).filter((e) => ENTITIES[e.name]);
      const { clipboard } = blueprintToClipboard(bp);
      const out = layoutToBlueprint(clipboard!.entities.map((e, i) => ({ ...e, id: `g${i}` }))).blueprint.entities!;
      const dx = bp.entities[0]!.position.x - out[0]!.position.x;
      const dy = bp.entities[0]!.position.y - out[0]!.position.y;
      bp.entities.forEach((o, i) => {
        const r = out[i]!;
        expect([r.name, r.position.x + dx, r.position.y + dy, r.direction ?? 0, r.type]).toEqual([o.name, o.position.x, o.position.y, o.direction ?? 0, o.type]);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('inserter filters, splitter settings and chest requests', () => {
  it('writes the 2.0 fields', () => {
    const { blueprint } = layoutToBlueprint([
      ent('fast-inserter', 0, 0, 0, { filters: ['iron-plate', 'copper-plate'], filterMode: 'blacklist' }),
      ent('splitter', 2, 0, 0, { inputPriority: 'right', outputPriority: 'left', filters: ['electronic-circuit'] }),
      ent('requester-chest', 5, 0, 0, { requests: [{ name: 'steel-plate', count: 3 }] }),
      ent('splitter', 7, 0, 0, { filters: ['iron-plate'] }), // a filter without output priority is dropped
    ]);
    const [ins, spl, req, spl2] = blueprint.entities!;
    expect(ins).toMatchObject({
      use_filters: true,
      filter_mode: 'blacklist',
      filters: [
        { index: 1, name: 'iron-plate', quality: 'normal', comparator: '=' },
        { index: 2, name: 'copper-plate', quality: 'normal', comparator: '=' },
      ],
    });
    expect(spl).toMatchObject({ input_priority: 'right', output_priority: 'left', filter: { name: 'electronic-circuit' } });
    expect(req!.request_filters).toEqual({ sections: [{ index: 1, filters: [{ index: 1, name: 'steel-plate', quality: 'normal', comparator: '=', count: 3 }] }] });
    expect(spl2!.filter).toBeUndefined();
  });

  it('round-trips through a string', () => {
    const layout = [
      ent('inserter', 0, 0, 2, { filters: ['coal'] }),
      ent('splitter', 2, 0, 1, { outputPriority: 'right', filters: ['stone'] }),
      ent('buffer-chest', 5, 0, 0, { requests: [{ name: 'iron-plate', count: 100 }, { name: 'copper-plate', count: 50 }] }),
    ];
    const { clipboard } = blueprintToClipboard(decodeBlueprintString(encodeBlueprintString(layoutToBlueprint(layout).blueprint)));
    const [a, b, c] = clipboard!.entities;
    expect(a).toMatchObject({ filters: ['coal'] });
    expect(a!.filterMode).toBeUndefined();
    expect(b).toMatchObject({ outputPriority: 'right', filters: ['stone'] });
    expect(c!.requests).toEqual([{ name: 'iron-plate', count: 100 }, { name: 'copper-plate', count: 50 }]);
  });

  it('reads and reproduces the settings in blueprints made by the game', async () => {
    const { GAME_LOGISTICS_BLUEPRINTS } = await import('./fixtures/game-blueprints');
    const { ENTITIES } = await import('../src/editor/catalog');
    const seen = new Set<string>();
    for (const s of GAME_LOGISTICS_BLUEPRINTS) {
      const bp = decodeBlueprintString(s);
      bp.entities = (bp.entities ?? []).filter((e) => ENTITIES[e.name]);
      const { clipboard } = blueprintToClipboard(bp);
      const out = layoutToBlueprint(clipboard!.entities.map((e, i) => ({ ...e, id: `g${i}` }))).blueprint.entities!;
      bp.entities.forEach((o, i) => {
        const r = out[i]!;
        if (o.request_filters) {
          seen.add('requests');
          const strip = (rf: unknown) => (rf as { sections: { filters: { name: string; count: number }[] }[] }).sections.flatMap((x) => x.filters.map((f) => [f.name, f.count]));
          expect(strip(r.request_filters)).toEqual(strip(o.request_filters));
        }
        if (o.output_priority) {
          seen.add('splitter');
          expect([r.output_priority, (r.filter as { name: string } | undefined)?.name]).toEqual([o.output_priority, (o.filter as { name: string } | undefined)?.name]);
        }
      });
    }
    expect([...seen].sort()).toEqual(['requests', 'splitter']);
  });

  it('reads 1.1 inserter filters and requests', () => {
    const { clipboard } = blueprintToClipboard({
      item: 'blueprint',
      version: encodeVersion(1, 1, 100),
      entities: [
        { entity_number: 1, name: 'fast-inserter', position: { x: 0.5, y: 0.5 }, filters: [{ index: 1, name: 'coal' }] },
        { entity_number: 2, name: 'requester-chest', position: { x: 1.5, y: 0.5 }, request_filters: [{ index: 1, name: 'coal', count: 50 }] },
      ],
    });
    expect(clipboard!.entities[0]!.filters).toEqual(['coal']);
    expect(clipboard!.entities[1]!.requests).toEqual([{ name: 'coal', count: 50 }]);
  });
});

describe('blueprints with rails', () => {
  it('skips signals, stops and trains when some track cannot be read', () => {
    const { clipboard, unknown } = blueprintToClipboard({
      item: 'blueprint',
      version: encodeVersion(0, 18, 1),
      entities: [
        { entity_number: 1, name: 'curved-rail', position: { x: 1, y: 1 } },
        { entity_number: 2, name: 'rail-signal', position: { x: 2.5, y: 0.5 } },
        { entity_number: 3, name: 'roboport', position: { x: 10, y: 10 } },
        { entity_number: 4, name: 'advanced-substation', position: { x: 20, y: 20 } },
      ],
    });
    expect(clipboard!.entities.map((e) => e.name)).toEqual(['roboport', 'substation']);
    expect(unknown).toEqual({ '1.x curve or diagonal (could not rebuild)': 1, 'rail-signal': 1 });
  });

  it('converts 1.x straight rails along an axis and keeps their signals', () => {
    const { clipboard, unknown } = blueprintToClipboard({
      item: 'blueprint',
      version: encodeVersion(1, 1, 100),
      entities: [
        { entity_number: 1, name: 'straight-rail', position: { x: 1, y: 1 } },
        { entity_number: 2, name: 'straight-rail', position: { x: 1, y: 3 } },
        { entity_number: 3, name: 'rail-signal', position: { x: 2.5, y: 1.5 } },
      ],
    });
    expect(unknown).toEqual({});
    expect(clipboard!.rails).toHaveLength(2);
    expect(clipboard!.entities.map((e) => e.name)).toEqual(['rail-signal']);
    // East of a north-south track, a signal guards northbound trains, so it faces south.
    expect(clipboard!.entities[0]!.direction).toBe(2);
  });

  // Regression: 1.x centres straight rails on even tiles (2.0 uses odd ones),
  // so a real 1.x rail grid imported as nothing but roboports.
  it('reads 1.x straight rails centred on even tiles', () => {
    const { clipboard, unknown } = blueprintToClipboard({
      item: 'blueprint',
      version: encodeVersion(0, 17, 79),
      entities: [
        { entity_number: 1, name: 'straight-rail', position: { x: 0, y: 0 } },
        { entity_number: 2, name: 'straight-rail', position: { x: 0, y: 2 } },
        { entity_number: 3, name: 'straight-rail', position: { x: 4, y: 6 }, direction: 2 },
        { entity_number: 4, name: 'rail-chain-signal', position: { x: 1.5, y: 0.5 } },
        { entity_number: 5, name: 'curved-rail', position: { x: 20, y: 20 } },
        { entity_number: 6, name: 'roboport', position: { x: 10, y: 10 } },
      ],
    });
    expect(clipboard!.rails).toHaveLength(3);
    expect(clipboard!.rails!.map((r) => r.direction)).toEqual([0, 0, 4]);
    expect(clipboard!.entities.map((e) => e.name).sort()).toEqual(['rail-chain-signal', 'roboport']);
    expect(unknown).toEqual({ '1.x curve or diagonal (could not rebuild)': 1 });
  });

  it('rebuilds a 1.x S-bend with 2.0 track that joins the straight track at both ends', () => {
    // Two 1.x curves shifting the line 6 tiles sideways, with straight track before and after.
    const entities: BlueprintEntityInput[] = [
      { name: 'curved-rail', position: { x: 1, y: 1 }, direction: 0 },
      { name: 'curved-rail', position: { x: -3, y: -5 }, direction: 4 },
    ];
    for (let i = 0; i < 10; i++) {
      entities.push({ name: 'straight-rail', position: { x: 2, y: 6 + 2 * i } });
      entities.push({ name: 'straight-rail', position: { x: -4, y: -10 - 2 * i } });
    }
    // Signals for both directions on the lower straight: right-hand traffic both ways.
    entities.push({ name: 'rail-signal', position: { x: 3.5, y: 20.5 }, direction: 4 });
    entities.push({ name: 'rail-signal', position: { x: 0.5, y: 21.5 }, direction: 0 });
    const { clipboard, unknown, railRoutes } = blueprintToClipboard({ item: 'blueprint', version: encodeVersion(1, 1, 110), entities: entities.map((e, i) => ({ ...e, entity_number: i + 1 })) });
    expect(unknown).toEqual({});
    expect(railRoutes).toMatchObject({ rebuilt: 1, failed: 0, legacyPieces: 2 });
    const rails = clipboard!.rails!;
    expect(rails.some((r) => r.name === 'curved-rail-a')).toBe(true);
    const report = checkRails(rails.map((r, i) => railPiece({ ...r, id: `r${i}` })));
    expect(report.issues).toEqual([]);
    // Only the two far ends of the line are open: the new curves join the old straights.
    expect(report.deadEnds).toHaveLength(2);
    // The rebuilt section is signalled both ways: a chain signal in, a rail signal out, each beside a track joint.
    const sigs = clipboard!.entities.filter((e) => e.name.startsWith('rail'));
    expect(sigs).toHaveLength(6);
    expect(sigs.map((e) => e.name).sort()).toEqual(['rail-chain-signal', 'rail-chain-signal', 'rail-signal', 'rail-signal', 'rail-signal', 'rail-signal']);
    for (const s of sigs) expect(signalAt(rails as PlacedRail[], s.x, s.y, s.direction)).toEqual({ direction: s.direction, diagonal: false });
    expect(railRoutes!.signals).toBe(4);
  });

  it('moves buildings off rebuilt track and leaves no signal floating', () => {
    const entities: BlueprintEntityInput[] = [
      { name: 'curved-rail', position: { x: 1, y: 1 }, direction: 0 },
      { name: 'curved-rail', position: { x: -3, y: -5 }, direction: 4 },
      // Northbound signals: one on the straight, one beside the old 1.x curve.
      { name: 'rail-signal', position: { x: 3.5, y: 20.5 }, direction: 4 },
      { name: 'rail-chain-signal', position: { x: 1.5, y: -1.5 }, direction: 4 },
    ];
    for (let i = 0; i < 10; i++) {
      entities.push({ name: 'straight-rail', position: { x: 2, y: 6 + 2 * i } });
      entities.push({ name: 'straight-rail', position: { x: -4, y: -10 - 2 * i } });
    }
    // A lamp where the 2.0 track will run (the 2.0 S-bend is longer, so it doesn't follow the old curves exactly).
    entities.push({ name: 'small-lamp', position: { x: 0.5, y: 2.5 } });
    const { clipboard, railRoutes, unknown, preview } = blueprintToClipboard({ item: 'blueprint', version: encodeVersion(1, 1, 110), entities: entities.map((e, i) => ({ ...e, entity_number: i + 1 })) });
    expect(railRoutes!.moved).toBeGreaterThan(0);
    // Every signal guards track, facing the way it was set: none is left floating beside the old curve.
    for (const e of clipboard!.entities.filter((x) => x.name.startsWith('rail')))
      expect(signalAt(clipboard!.rails as PlacedRail[], e.x, e.y, e.direction)).toEqual({ direction: e.direction, diagonal: !!e.diagonal });
    expect(unknown).toEqual({ 'rail-chain-signal (beside 1.x curve, track rebuilt)': 1 });
    // The preview map marks the rebuilt track, the moved lamp, the new junction signals and the dropped signal.
    expect(preview!.rebuiltRails.length).toBeGreaterThan(0);
    for (const i of preview!.rebuiltRails) expect(clipboard!.rails![i]!.name).not.toBe(undefined);
    expect(preview!.movedEntities.map((i) => clipboard!.entities[i]!.name)).toEqual(['small-lamp']);
    expect(preview!.addedSignals.every((i) => clipboard!.entities[i]!.name.startsWith('rail'))).toBe(true);
    expect(preview!.dropped).toHaveLength(1);
    // Everything in the clipboard can be pasted: nothing sits on the track or on another building.
    const res = pasteClipboard({ ...emptyLayout(), water: [] }, clipboard!, 0, 0);
    expect(res.blocked).toBe(0);
  });

  it('places modded buildings as their base-game counterparts', () => {
    expect(vanillaName('substation-2')).toBe('substation');
    expect(vanillaName('assembling-machine-4')).toBe('assembling-machine-3');
    expect(vanillaName('logistic-train-stop')).toBe('train-stop');
    expect(vanillaName('logistic-train-stop-input')).toBeNull();
    expect(vanillaName('some-mod-thing')).toBeUndefined();
    const { clipboard, replaced } = blueprintToClipboard({
      item: 'blueprint',
      version: encodeVersion(1, 1, 110),
      entities: [
        { entity_number: 1, name: 'substation-2', position: { x: 1, y: 1 } },
        { entity_number: 2, name: 'logistic-train-stop-input', position: { x: 5.5, y: 5.5 } },
      ],
    });
    expect(clipboard!.entities.map((e) => e.name)).toEqual(['substation']);
    expect(replaced).toEqual({ 'substation-2 → substation': 1 });
  });
});
