import React from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useColors } from '../theme/index.js';
import { AvatarRenderer } from '../avatars/AvatarRenderer.js';
import { RoomMark } from '../avatars/RoomMark.js';

/**
 * Single source for "user thumbnail" rendering.
 * Spec: CONVERSATIONS.md §2.5.
 *
 * - 1:1 surfaces pass `kind="animal"` + the peer's animalId; the tile
 *   renders the breathing/blink-animated avatar at 78% of its bounding
 *   size.
 * - Group surfaces pass `kind="room"` + the group's roomId; the tile
 *   renders a deterministic geometric room mark at 78%.
 *
 * Sharp corners always (brand §2.4 forbids softening avatars). Surface
 * fill + 1px text-faint border. The 78% inner-size leaves a small
 * margin so the silhouette never touches the tile edge.
 *
 * Sizes used across the app: 18 (group sender attribution), 28
 * (AppBars), 36 (list rows), 96 (settings/profile), 128+ (call self-
 * view).
 */

interface AnimalProps {
  kind: 'animal';
  /** AnimalId from `apps/mobile/src/avatars/components.tsx` ANIMALS. */
  id: string;
  /** Suppress blink — useful in picker grids where 12 simultaneously-
   * blinking tiles would feel cluttered. */
  skipBlink?: boolean;
  /** Audio amplitude in [0, 1] when in a call context. Idle by default. */
  amplitude?: Animated.Value | number;
}

interface RoomProps {
  kind: 'room';
  /** Stable group id (the server's room UUID). */
  id: string;
}

type Props = (AnimalProps | RoomProps) & {
  size: number;
};

export function PortraitTile(props: Props): React.ReactElement {
  const themed = useColors();
  const inner = Math.round(props.size * 0.78);

  return (
    <View
      style={[
        styles.tile,
        {
          width: props.size,
          height: props.size,
          backgroundColor: themed.pale,
          borderColor: themed.divider,
        },
      ]}
    >
      {props.kind === 'animal' ? (
        <AvatarRenderer
          animalId={props.id}
          size={inner}
          skipBlink={props.skipBlink}
          amplitude={props.amplitude}
        />
      ) : (
        <RoomMark roomId={props.id} size={inner} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    // Sharp corners — brand §2.4. Never soften.
    borderRadius: 0,
  },
});
