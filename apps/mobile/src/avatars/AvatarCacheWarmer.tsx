import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import Svg from 'react-native-svg';
import { ANIMALS } from './components.js';
import { defaultAnimalForUser } from './default.js';
import { useConversations } from '../store/conversations.js';
import { useProfiles } from '../store/profiles.js';
import { useIdentity } from '../store/identity.js';
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

  // Every userId we'd want a notification avatar for.
  const userIds = useMemo(() => {
    const ids = new Set<string>();
    if (myUserId) ids.add(myUserId);
    for (const c of Object.values(conversations)) {
      if (c.peerUserId) ids.add(c.peerUserId);
    }
    return [...ids];
  }, [conversations, myUserId]);

  const doneRef = useRef<Set<string>>(new Set());
  const [current, setCurrent] = useState<
    { userId: string; animalId: string } | undefined
  >();
  const svgRef = useRef<Svg>(null);

  // Static poses — rasterization captures a single idle frame.
  const eyeOpen = useRef(new Animated.Value(1)).current;
  const mouthIdle = useRef(new Animated.Value(1)).current;
  const noAmp = useRef(new Animated.Value(0)).current;

  // Pick the next un-rasterized user.
  useEffect(() => {
    if (current) return;
    const next = userIds.find((id) => !doneRef.current.has(id));
    if (!next) return;
    const animalId = profiles[next]?.selectedAvatarId ?? defaultAnimalForUser(next);
    setCurrent({ userId: next, animalId });
  }, [userIds, current, profiles]);

  // Once the avatar SVG is mounted, rasterize it and cache the PNG.
  useEffect(() => {
    if (!current) return;
    const userId = current.userId;
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      doneRef.current.add(userId);
      setCurrent(undefined);
    };
    // Small delay so the off-screen SVG has been drawn before capture.
    const t = setTimeout(() => {
      const svg = svgRef.current;
      if (!svg || cancelled) {
        finish();
        return;
      }
      try {
        svg.toDataURL((base64: string) => {
          if (cancelled) return;
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
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [current]);

  if (!current) return null;
  const def = ANIMALS[current.animalId];
  if (!def) return null;
  return (
    <View
      style={{ position: 'absolute', left: -9999, top: -9999, opacity: 0 }}
      pointerEvents="none"
    >
      <Svg ref={svgRef} width={RASTER_SIZE} height={RASTER_SIZE} viewBox="0 0 100 100">
        {def.Render({ eyeScale: eyeOpen, mouthScale: mouthIdle, amplitude: noAmp })}
      </Svg>
    </View>
  );
}
