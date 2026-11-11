import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { gamePathOf, modNameOf, modZipIcons } from '../src/icons';

describe('icon paths', () => {
  it('maps game folders to game paths', () => {
    expect(gamePathOf('Factorio/data/space-age/graphics/icons/foundry.png')).toBe('__space-age__/graphics/icons/foundry.png');
    expect(gamePathOf('data/base/graphics/icons/iron-plate.png')).toBe('__base__/graphics/icons/iron-plate.png');
    expect(gamePathOf('graphics/icons/iron-plate.png')).toBe('__base__/graphics/icons/iron-plate.png');
  });

  it('names mods from their zip or folder', () => {
    expect(modNameOf('Krastorio2_2.0.3.zip')).toBe('Krastorio2');
    expect(modNameOf('aai-containers_0.3.2')).toBe('aai-containers');
    expect(modNameOf('helmod')).toBe('helmod');
  });

  it('reads only wanted icons from a mod zip, named by its info.json', () => {
    const zip = zipSync({
      'aai-containers_0.3.2/info.json': strToU8('{"name":"aai-containers"}'),
      'aai-containers_0.3.2/graphics/icons/container.png': new Uint8Array([1, 2, 3]),
      'aai-containers_0.3.2/graphics/icons/other.png': new Uint8Array([4]),
    });
    const got = modZipIcons(zip, 'renamed-download.zip', new Set([
      '__aai-containers__/graphics/icons/container.png', '__base__/graphics/icons/iron-plate.png',
    ]));
    expect([...got.keys()]).toEqual(['__aai-containers__/graphics/icons/container.png']);
    expect(Array.from(got.values()[Symbol.iterator]().next().value!)).toEqual([1, 2, 3]);
  });
});
