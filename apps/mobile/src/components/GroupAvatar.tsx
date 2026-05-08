import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { PortraitTile } from './PortraitTile.js';

/**
 * Group avatar — deterministic geometric room mark inside a sharp
 * surface tile. Phase 2 brand overhaul (AVATAR-SYSTEM.md §7):
 * replaces the previous group-photo (JPEG-blob) renderer.
 *
 * Construction is purely client-side from `groupId`. No network
 * fetch, no caching — same input always produces the same mark, so
 * every member sees the same room mark for a given group.
 *
 * Same prop shape as the previous version (`groupId`, `name`, `size`,
 * `style`) so existing callsites compile unchanged. The `name` prop
 * is now ignored — the room mark is derived from `groupId`, not from
 * a fallback initial.
 */

interface Props {
  groupId: string;
  /** @deprecated — kept on the prop type so existing callsites
   * compile. Room marks supersede name-derived initials. */
  name?: string;
  size?: number;
  /** @deprecated — PortraitTile renders its own View. Wrap externally
   * if you need additional layout. */
  style?: StyleProp<ViewStyle>;
}

export function GroupAvatar({ groupId, size = 36 }: Props): React.ReactElement {
  return <PortraitTile kind="room" id={groupId} size={size} />;
}
