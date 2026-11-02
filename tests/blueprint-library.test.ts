import { describe, expect, it } from 'vitest';
import { decodeAllBlueprints, decodeJsonString, encodeBlueprintString, encodeJsonString, makeBlueprint } from '../src/blueprint/format';
import { designFromEntities, designsFromString, designString, libraryBookString, loadDesigns, saveDesigns } from '../src/blueprint/library';
import type { PlacedEntity } from '../src/editor/model';

const ents: PlacedEntity[] = [
  { id: 'a', name: 'transport-belt', x: 10, y: 10, direction: 1 },
  { id: 'b', name: 'assembling-machine-2', x: 11, y: 9, direction: 0, recipe: 'iron-gear-wheel' },
];

describe('design library', () => {
  it('saves a selection relative to its corner', () => {
    const d = designFromEntities(ents, 'Gears')!;
    expect(d.name).toBe('Gears');
    expect(d.clip.w).toBe(4);
    expect(d.clip.h).toBe(3);
    expect(d.clip.entities[0]).toMatchObject({ x: 0, y: 1 });
    expect(designFromEntities([], 'x')).toBeNull();
  });

  it('exports designs as a blueprint book and reads it back', () => {
    const a = designFromEntities(ents, 'Gears')!;
    const b = designFromEntities([ents[0]!], 'Belt')!;
    const book = decodeJsonString(libraryBookString([a, b], 'Mine')) as { blueprint_book: { item: string; label: string; active_index: number; blueprints: { index: number; blueprint: { label: string } }[] } };
    expect(book.blueprint_book.item).toBe('blueprint-book');
    expect(book.blueprint_book.label).toBe('Mine');
    expect(book.blueprint_book.blueprints.map((x) => [x.index, x.blueprint.label])).toEqual([[0, 'Gears'], [1, 'Belt']]);

    const back = designsFromString(libraryBookString([a, b]));
    expect(back.designs.map((d) => d.name)).toEqual(['Gears', 'Belt']);
    expect(back.designs[0]!.clip).toEqual(a.clip);
  });

  it('reads nested books and single blueprints', () => {
    const bp = (label: string) => makeBlueprint([{ name: 'iron-chest', position: { x: 0.5, y: 0.5 } }], { label });
    const nested = encodeJsonString({
      blueprint_book: {
        item: 'blueprint-book',
        blueprints: [
          { index: 1, blueprint: bp('second') },
          { index: 0, blueprint_book: { item: 'blueprint-book', blueprints: [{ index: 0, blueprint: bp('inner') }] } },
          { index: 2, blueprint: { item: 'blueprint', label: 'odd', entities: [{ entity_number: 1, name: 'mystery', position: { x: 0, y: 0 } }], version: 0 } },
        ],
      },
    });
    expect(decodeAllBlueprints(nested).map((b) => b.label)).toEqual(['inner', 'second', 'odd']);
    const res = designsFromString(nested);
    expect(res.designs.map((d) => d.name)).toEqual(['inner', 'second']);
    expect(res.empty).toBe(1);
    expect(res.unknown).toEqual({ mystery: 1 });
    expect(designsFromString(encodeBlueprintString(bp(''))).designs[0]!.name).toBe('Blueprint 1');
  });

  it('a design string is a normal blueprint', () => {
    const d = designFromEntities(ents, 'Gears')!;
    const [bp] = decodeAllBlueprints(designString(d));
    expect(bp!.label).toBe('Gears');
    expect(bp!.entities).toHaveLength(2);
  });

  it('persists to storage and ignores junk', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const d = designFromEntities(ents, 'Gears')!;
    saveDesigns([d], storage);
    expect(loadDesigns(storage)).toEqual([d]);
    store.set('factorio-planner.designs.v1', '[{"id":1},"x",null]');
    expect(loadDesigns(storage)).toEqual([]);
    store.set('factorio-planner.designs.v1', '{oops');
    expect(loadDesigns(storage)).toEqual([]);
  });
});
