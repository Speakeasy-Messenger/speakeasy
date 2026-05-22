import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import Svg, { G, Rect } from 'react-native-svg';
import { ANIMALS } from './components.js';
import { defaultAnimalForUser } from './default.js';
import { useConversations } from '../store/conversations.js';
import { useProfiles } from '../store/profiles.js';
import { useIdentity } from '../store/identity.js';
import { useColors } from '../theme/index.js';
import { writeAvatarPng } from '../push/avatar-cache.js';
import { diag } from '../diag/log.js';

const RASTER_SIZE = 128;

/**
 * Invisible component — rasterizes each conversation peer's (and the
 * local user's) animal avatar to a cached PNG so the headless push
 * handler can render real avatars in MessagingStyle notifications
 * (`react-native-svg` can't be rendered headlessly).
 *
 * Processes one avatar at a time, each userId once per app session.
 * Mounted once, near the app root.
 */
export function AvatarCacheWarmer(): React.ReactElement | null {
  const conversations = useConversations((s) => s.byId);
  const profiles = useProfiles((s) => s.byUserId);
  const myUserId = useIdentity((s) => s.userId);
  const themed = useColors();

  // Every userId we'd want a notification avatar for: the local user,
  // every conversation peer, and everyone we hold a profile for. The
  // profile set matters because a peer's first-ever message arrives as
  // a headless push before any conversation row exists — if we've seen
  // them in a group or a profile lookup, their avatar is already warm
  // and that first notification shows the real portrait, not the app
  // icon.
  const userIds = useMemo(() => {
    const ids = new Set<string>();
    if (myUserId) ids.add(myUserId);
    for (const c of Object.values(conversations)) {
      if (c.peerUserId) ids.add(c.peerUserId);
    }
    for (const id of Object.keys(profiles)) ids.add(id);
    return [...ids];
  }, [conversations, profiles, myUserId]);

  const doneRef = useRef<Set<string>>(new Set());
  const [current, setCurrent] = useState<
    { userId: string; animalId: string } | undefined
  >();
  const svgRef = useRef<Svg>(null);

  // Static poses — rasterization captures a single idle frame.
  const eyeOpen = useRef(new Animated.Value(1)).current;
  const mouthIdle = useRef(new Animated.Value(1)).current;
  const noAmp = useRef(new Animated.Value(0)).current;

  // Pick the next un-rasterized (user, avatar) pair. Keyed on the pair —
  // not the userId alone — so that when a user's avatar changes (the
  // local user picking a paid animal, or a peer's real profile arriving
  // from the server after the warmer first ran against the deterministic
  // default) the cached PNG is re-rasterized instead of keeping a stale
  // common animal.
  useEffect(() => {
    if (current) return;
    const next = userIds
      .map((id) => ({
        userId: id,
        animalId: profiles[id]?.selectedAvatarId ?? defaultAnimalForUser(id),
      }))
      .find((u) => !doneRef.current.has(`${u.userId}:${u.animalId}`));
    if (next) setCurrent(next);
  }, [userIds, current, profiles]);

  // Once the avatar SVG is mounted, rasterize it and cache the PNG.
  useEffect(() => {
    if (!current) return;
    const { userId, animalId } = current;
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      doneRef.current.add(`${userId}:${animalId}`);
      setCurrent(undefined);
    };
    // Wait for the SVG host view to actually paint before snapshotting.
    // 200 ms was empirically too tight on cold start — some users saw
    // the notification fall back to the app icon because `toDataURL`
    // returned an empty bitmap on a not-yet-painted off-screen view.
    const t = setTimeout(() => {
      const svg = svgRef.current;
      if (!svg || cancelled) {
        finish();
        return;
      }
      try {
        svg.toDataURL((base64: string) => {
          if (cancelled) return;
          if (!base64) {
            diag('avatar-cache', 'toDataURL returned empty — skipping', { userId });
            finish();
            return;
          }
          void writeAvatarPng(userId, base64)
            .then(() => diag('avatar-cache', 'cached', { userId }))
            .catch((err) =>
              diag('avatar-cache', 'write failed', { userId, err: String(err) }),
            )
            .finally(finish);
        });
      } catch (err) {
        diag('avatar-cache', 'toDataURL failed', { userId, err: String(err) });
        finish();
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [current]);

  if (!current) return null;
  const def = ANIMALS[current.animalId];
  if (!def) return null;
  return (
    // Render in-tree at the very top-left with opacity 0 (rather than
    // translated to -9999 px) so Android actually paints the SVG —
    // off-screen RN views were intermittently being skipped by the
    // platform compositor, leaving `toDataURL` with a blank bitmap.
    <View
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: RASTER_SIZE,
        height: RASTER_SIZE,
        opacity: 0,
      }}
      pointerEvents="none"
    >
      {/* Surface-fill square with the animal inset to 60%, giving the
          rasterized notification avatar a generous ring of margin.
          MessagingStyle Person icons are cropped to a circle by Android;
          the extra margin keeps the animal centred well inside the
          mask instead of bleeding into the cropped corners. The headless
          push handler reads this PNG straight into the notification. */}
      <Svg ref={svgRef} width={RASTER_SIZE} height={RASTER_SIZE} viewBox="0 0 100 100">
        <Rect x={0} y={0} width={100} height={100} fill={themed.pale} />
        <G transform="translate(20 20) scale(0.60)">
          {def.Render({ eyeScale: eyeOpen, mouthScale: mouthIdle, amplitude: noAmp })}
        </G>
      </Svg>
    </View>
  );
}
