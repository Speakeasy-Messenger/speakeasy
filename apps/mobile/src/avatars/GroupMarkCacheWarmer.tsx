import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Svg, { G, Rect } from 'react-native-svg';
import { RoomMarkPrimitives } from './RoomMark.js';
import { useConversations } from '../store/conversations.js';
import { useColors } from '../theme/index.js';
import { writeAvatarPng } from '../push/avatar-cache.js';
import { diag } from '../diag/log.js';

const RASTER_SIZE = 128;

/**
 * Invisible sibling of [AvatarCacheWarmer]: rasterizes each GROUP's
 * deterministic RoomMark to a cached PNG, keyed by the group/conversation
 * id, so the headless push handler can show the room's own mark on group
 * notifications instead of the sender's portrait or the generic app icon
 * (`react-native-svg` can't render headlessly).
 *
 * The cache key is the conversation id (= the group id), which is exactly
 * the `conversation_id` the push carries — so the headless handler
 * resolves it via `resolveAvatarPath(conversationId)` with no extra
 * mapping. Composition mirrors `AvatarCacheWarmer` (pale tile + the mark
 * inset to 60% so Android's circular crop leaves a margin).
 *
 * One group at a time, each once per session. Mounted once near the app
 * root, beside `AvatarCacheWarmer`.
 */
export function GroupMarkCacheWarmer(): React.ReactElement | null {
  const byId = useConversations((s) => s.byId);
  const themed = useColors();

  const groupIds = useMemo(
    () =>
      Object.entries(byId)
        .filter(([, c]) => c.kind === 'group')
        .map(([id]) => id),
    [byId],
  );

  const doneRef = useRef<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | undefined>();
  const svgRef = useRef<Svg>(null);

  useEffect(() => {
    if (current) return;
    const next = groupIds.find((id) => !doneRef.current.has(id));
    if (next) setCurrent(next);
  }, [groupIds, current]);

  useEffect(() => {
    if (!current) return;
    const groupId = current;
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      doneRef.current.add(groupId);
      setCurrent(undefined);
    };
    // Same 500 ms paint settle as AvatarCacheWarmer — an off-screen SVG
    // snapshotted too early returns an empty bitmap on cold start.
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
            diag('avatar-cache', 'group toDataURL returned empty — skipping', { groupId });
            finish();
            return;
          }
          void writeAvatarPng(groupId, base64)
            .then(() => diag('avatar-cache', 'group cached', { groupId }))
            .catch((err) =>
              diag('avatar-cache', 'group write failed', { groupId, err: String(err) }),
            )
            .finally(finish);
        });
      } catch (err) {
        diag('avatar-cache', 'group toDataURL failed', { groupId, err: String(err) });
        finish();
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [current]);

  if (!current) return null;
  return (
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
      <Svg ref={svgRef} width={RASTER_SIZE} height={RASTER_SIZE} viewBox="0 0 100 100">
        <Rect x={0} y={0} width={100} height={100} fill={themed.pale} />
        <G transform="translate(20 20) scale(0.60)">
          <RoomMarkPrimitives roomId={current} />
        </G>
      </Svg>
    </View>
  );
}
