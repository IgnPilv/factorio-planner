// Saved designs: named groups of buildings kept in the browser, which can be
// placed back into the layout and exported together as one blueprint book.

import type { Clipboard, PlacedEntity, PlacedRail } from '../editor/model';
import { copyToClipboard } from '../editor/model';
import { decodeAllBlueprints, encodeBlueprintString, encodeBookString, makeBook, type Blueprint } from './format';
import { blueprintToClipboard, layoutToBlueprint } from './layout';

export interface Design {
  id: string;
  name: string;
  clip: Clipboard;
  /** ms since epoch */
  created: number;
}

const STORAGE_KEY = 'factorio-planner.designs.v1';

let counter = 0;
const designId = () => `d${Date.now().toString(36)}${(counter++).toString(36)}`;

export function loadDesigns(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Design[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (d): d is Design =>
        d && typeof d.id === 'string' && typeof d.name === 'string' && d.clip && Array.isArray(d.clip.entities) && Number.isFinite(d.clip.w) && Number.isFinite(d.clip.h),
    );
  } catch {
    return [];
  }
}

export function saveDesigns(designs: Design[], storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(designs));
  } catch {
    /* storage full or blocked: designs stay for this session only */
  }
}

export function designFromEntities(entities: readonly PlacedEntity[], name: string, rails: readonly PlacedRail[] = []): Design | null {
  const clip = copyToClipboard(entities, rails);
  return clip ? { id: designId(), name, clip, created: Date.now() } : null;
}

const asPlaced = (clip: Clipboard): PlacedEntity[] => clip.entities.map((e, i) => ({ ...e, id: `c${i}` }));

export function designBlueprint(d: Design): Blueprint {
  const rails = (d.clip.rails ?? []).map((r, i) => ({ ...r, id: `r${i}` }));
  return layoutToBlueprint(asPlaced(d.clip), { label: d.name, rails }).blueprint;
}

export function designString(d: Design): string {
  return encodeBlueprintString(designBlueprint(d));
}

/** All designs as one blueprint book string, in library order. */
export function libraryBookString(designs: Design[], label = 'Factorio Planner'): string {
  return encodeBookString(makeBook(designs.map(designBlueprint), label));
}

export interface LibraryImport {
  designs: Design[];
  /** Blueprints with nothing the planner knows. */
  empty: number;
  unknown: Record<string, number>;
}

/** Designs from a blueprint or book string (every blueprint in a book). */
export function designsFromString(str: string): LibraryImport {
  const designs: Design[] = [];
  const unknown: Record<string, number> = {};
  let empty = 0;
  decodeAllBlueprints(str).forEach((bp, i) => {
    const res = blueprintToClipboard(bp);
    for (const [n, c] of Object.entries(res.unknown)) unknown[n] = (unknown[n] ?? 0) + c;
    if (!res.clipboard) {
      empty++;
      return;
    }
    designs.push({ id: designId(), name: bp.label?.trim() || `Blueprint ${i + 1}`, clip: res.clipboard, created: Date.now() });
  });
  return { designs, empty, unknown };
}
