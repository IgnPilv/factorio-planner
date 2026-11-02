import { describe, expect, it } from 'vitest';
import { gameData } from '../src/data';
import { gamePathOf, iconPath, neededIconPaths } from '../src/data/icons';

describe('game icons', () => {
  it('maps picked files to game paths', () => {
    expect(gamePathOf('Factorio/data/base/graphics/icons/iron-plate.png')).toBe('__base__/graphics/icons/iron-plate.png');
    expect(gamePathOf('data\\core\\graphics\\icons\\mip\\no-item.png')).toBe('__core__/graphics/icons/mip/no-item.png');
    expect(gamePathOf('graphics/technology/automation.png')).toBe('__base__/graphics/technology/automation.png');
    expect(gamePathOf('icons/iron-plate.png')).toBeUndefined();
  });

  it('has an icon for every building, recipe, technology and visible item', () => {
    for (const e of Object.values(gameData.entities)) expect(iconPath(e.name, 'entity'), e.name).toMatch(/\.png$/);
    for (const r of Object.values(gameData.recipes)) expect(iconPath(r.name, 'recipe'), r.name).toMatch(/\.png$/);
    for (const t of Object.values(gameData.technologies)) expect(iconPath(t.name, 'technology'), t.name).toMatch(/\.png$/);
    for (const i of Object.values(gameData.items)) if (!i.hidden) expect(iconPath(i.name, 'item'), i.name).toMatch(/\.png$/);
  });

  it('uses the recipe icon for multi-product recipes and the leveled-tech base image', () => {
    expect(iconPath('advanced-oil-processing', 'recipe')).toBe('__base__/graphics/icons/fluid/advanced-oil-processing.png');
    expect(iconPath('iron-gear-wheel', 'recipe')).toBe('__base__/graphics/icons/iron-gear-wheel.png');
    expect(iconPath('mining-productivity-1', 'technology')).toBe('__base__/graphics/technology/mining-productivity.png');
    expect(iconPath('rocket-silo', 'technology')).toContain('/technology/');
    expect(neededIconPaths().size).toBeGreaterThan(300);
  });
});
