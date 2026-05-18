import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { defaultAnimalForUser } from '../avatars/default.js';
import { Handle } from './Handle.js';
import { PortraitTile } from './PortraitTile.js';
import { useBanner } from '../store/banner.js';
import { useGroups } from '../store/groups.js';
import { useProfiles } from '../store/profiles.js';
import { useColors } from '../theme/index.js';
import { font, motion, space, type as typeScale } from '../theme/tokens.js';

/**
 * In-app foreground notification toast (CLAUDECODENOTE.md §5).
 *
 * Direct: 28×28 animal portrait + brass `@handle` + 1-line preview.
 * Group: 32×32 room mark + group name + `@sender:` brass prefix
 * before the preview text (matches the conversation-list group
 * preview pattern).
 *
 * Sharp corners, 1px text-faint border, no shadow, surface bg.
 * Position: top of screen with safe-area inset, full-width minus
 * 16px horizontal margins. Slides in from -80 over 240ms ease-out;
 * slides out on the same curve after 4s auto-dismiss or on tap.
 *
 * Suppression rules (enforced in App.tsx's `notifyInbound`, not
 * here):
 *   - active conversation matches → no banner
 *   - per-conversation muted → no banner
 *   - in a call → no banner
 *
 * No close × button (per note). Tap → navigate; otherwise auto-
 * dismiss. One banner at a time — `useBanner.show()` replaces the
 * current banner so a flurry of arrivals collapses to the latest.
 */

const AUTO_DISMISS_MS = 4000;
const ANIM_MS = motion.screen;

interface Props {
  /** Tap handler — receives the active banner's target so the parent can
   * route accordingly. The banner itself never imports the navigator. */
  onTap: (target: import('../store/banner.js').BannerData['target']) => void;
}

export function InAppBanner({ onTap }: Props) {
  const insets = useSafeAreaInsets();
  const themed = useColors();
  const current = useBanner((s) => s.current);
  const dismiss = useBanner((s) => s.dismiss);

  // Single Animated.Value drives translateY + opacity in lockstep.
  // Re-keyed off `current?.id` so a new banner replaces an in-
  // flight one without queuing.
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!current) return;
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: ANIM_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    const t = setTimeout(() => {
      Animated.timing(progress, {
        toValue: 0,
        duration: ANIM_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) dismiss();
      });
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [current?.id, dismiss, progress]);

  if (!current) return null;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-80, 0],
  });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          paddingTop: insets.top + space.xs,
          opacity: progress,
          transform: [{ translateY }],
        },
      ]}
    >
      <Pressable
        onPress={() => {
          dismiss();
          onTap(current.target);
        }}
        style={[
          styles.card,
          {
            backgroundColor: themed.pale,
            borderColor: themed.divider,
          },
        ]}
        testID="in-app-banner"
      >
        <BannerContent banner={current} />
      </Pressable>
    </Animated.View>
  );
}

function BannerContent({
  banner,
}: {
  banner: import('../store/banner.js').BannerData;
}): React.ReactElement {
  const themed = useColors();
  if (banner.target.kind === 'group') {
    return <GroupBannerContent banner={banner} themed={themed} />;
  }
  return <DirectBannerContent banner={banner} themed={themed} />;
}

function DirectBannerContent({
  banner,
  themed,
}: {
  banner: import('../store/banner.js').BannerData;
  themed: ReturnType<typeof useColors>;
}): React.ReactElement {
  const profile = useProfiles((s) => s.byUserId[banner.sender]);
  const animalId =
    profile?.selectedAvatarId ?? defaultAnimalForUser(banner.sender);
  return (
    <>
      <PortraitTile kind="animal" id={animalId} size={28} />
      <View style={styles.body}>
        <Handle value={banner.sender} variant="body" />
        <Text
          style={[styles.preview, { color: themed.slate }]}
          numberOfLines={1}
        >
          {banner.text}
        </Text>
      </View>
    </>
  );
}

function GroupBannerContent({
  banner,
  themed,
}: {
  banner: import('../store/banner.js').BannerData;
  themed: ReturnType<typeof useColors>;
}): React.ReactElement {
  if (banner.target.kind !== 'group') {
    // narrow exit — the parent already gated on `kind`.
    return <></>;
  }
  const groupId = banner.target.groupId;
  const group = useGroups((s) => s.byId[groupId]);
  return (
    <>
      <PortraitTile kind="room" id={groupId} size={32} />
      <View style={styles.body}>
        <Text
          style={[styles.groupName, { color: themed.ink }]}
          numberOfLines={1}
        >
          {group?.name ?? groupId}
        </Text>
        <Text
          style={[styles.preview, { color: themed.slate }]}
          numberOfLines={1}
        >
          <Text style={{ color: themed.primary, fontFamily: font.medium }}>
            @{banner.sender}:
          </Text>{' '}
          {banner.text}
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.base,
    zIndex: 1000,
  },
  // Sharp corners, faint border, no shadow per note.
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    paddingVertical: space.m,
    paddingHorizontal: space.m,
    borderWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1, gap: space.xs, minWidth: 0 },
  groupName: {
    fontFamily: font.medium,
    fontSize: 13,
    letterSpacing: -0.005 * 13,
  },
  preview: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    lineHeight: 16,
  },
});
