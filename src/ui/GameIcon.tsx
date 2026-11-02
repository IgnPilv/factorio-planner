import { useSyncExternalStore } from 'react';
import { gameData, wikiIconUrl } from '../data';
import { iconPath, iconUrl, iconsVersion, subscribeIcons, type IconKind } from '../data/icons';

/** Re-renders the caller when game icons are loaded or forgotten. */
export function useIconsVersion(): number {
  return useSyncExternalStore(subscribeIcons, iconsVersion);
}

function labelOf(name: string, kind?: IconKind): string {
  const d = gameData;
  if (kind === 'recipe') return d.recipes[name]?.displayName ?? name;
  return d.items[name]?.displayName ?? d.entities[name]?.displayName ?? d.technologies[name]?.displayName ?? d.recipes[name]?.displayName ?? name;
}

/**
 * Icon of an item, recipe, building or technology. Uses the icons loaded from the
 * player's game files; until those exist, the wiki's image (hidden if it fails).
 */
export function GameIcon({ name, kind, size = 24, className = 'icon' }: { name: string; kind?: IconKind; size?: number; className?: string }) {
  useIconsVersion();
  const local = iconUrl(iconPath(name, kind));
  if (local) return <img className={className} src={local} alt="" width={size} height={size} draggable={false} />;
  return (
    <img key={name} className={className} src={wikiIconUrl(labelOf(name, kind))} alt="" width={size} height={size} loading="lazy"
      onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
  );
}
