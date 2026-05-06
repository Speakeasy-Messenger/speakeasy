import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Attachment } from '@speakeasy/shared';
import { font, radius, space, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Render the attachments slot of a chat bubble.
 *
 *   1 image/gif → full-width image (bubble width).
 *   2 → side-by-side, each half width.
 *   3+ → 2-column grid; the 3rd photo spans full width on row 2 if odd.
 *
 * Files render as a small "card" — name + extension hint. Tapping a
 * file is a no-op for v1 (no in-app preview / download UI yet); the
 * sender's intent + the recipient's preview are sufficient to verify
 * the round-trip.
 */
interface Props {
  attachments: Attachment[];
  /** Outgoing bubbles use a brass background — captions + file names
   * inside need accent-fg, not the workspace text color. */
  variant: 'me' | 'them';
  /** Tap a photo/gif → opens fullscreen viewer in the host screen. */
  onTapPhoto?: (attachment: Attachment) => void;
  /** Tap a file → host writes to Downloads + alerts. */
  onTapFile?: (attachment: Attachment) => void;
}

const SIDE = 220; // logical-px square footprint per photo

export function AttachmentView({
  attachments,
  variant,
  onTapPhoto,
  onTapFile,
}: Props): React.JSX.Element | null {
  if (!attachments.length) return null;

  const photos = attachments.filter((a) => a.kind === 'image' || a.kind === 'gif');
  const files = attachments.filter((a) => a.kind === 'file');

  return (
    <View style={styles.root}>
      {photos.length > 0 ? <PhotoGrid photos={photos} onTap={onTapPhoto} /> : null}
      {files.map((f, i) => (
        <FileCard
          key={`${f.name ?? 'file'}-${i}`}
          attachment={f}
          variant={variant}
          onTap={onTapFile}
        />
      ))}
    </View>
  );
}

function PhotoGrid({
  photos,
  onTap,
}: {
  photos: Attachment[];
  onTap?: (a: Attachment) => void;
}) {
  if (photos.length === 1) {
    return <PhotoTile attachment={photos[0]!} width={SIDE} onTap={onTap} />;
  }
  return (
    <View style={styles.grid}>
      {photos.map((p, i) => {
        const fullWidth = photos.length % 2 === 1 && i === photos.length - 1;
        return (
          <PhotoTile
            key={i}
            attachment={p}
            width={fullWidth ? SIDE : (SIDE - 4) / 2}
            onTap={onTap}
          />
        );
      })}
    </View>
  );
}

function PhotoTile({
  attachment,
  width,
  onTap,
}: {
  attachment: Attachment;
  width: number;
  onTap?: (a: Attachment) => void;
}) {
  return (
    <Pressable onPress={onTap ? () => onTap(attachment) : undefined}>
      <Image
        source={{ uri: `data:${attachment.mime};base64,${attachment.data}` }}
        style={[styles.photo, { width, height: width }]}
      />
    </Pressable>
  );
}

function FileCard({
  attachment,
  variant,
  onTap,
}: {
  attachment: Attachment;
  variant: 'me' | 'them';
  onTap?: (a: Attachment) => void;
}) {
  const theme = useTheme();
  const isMe = variant === 'me';
  const fg = isMe ? theme.accentFg : theme.text;
  const muted = isMe ? theme.accentFg : theme.textMute;
  const name = attachment.name ?? 'file';
  const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : 'FILE';
  return (
    <Pressable
      style={[styles.fileCard, { borderColor: muted }]}
      onPress={onTap ? () => onTap(attachment) : undefined}
    >
      <View style={[styles.fileBadge, { borderColor: fg }]}>
        <Text style={[styles.fileBadgeText, { color: fg, fontFamily: font.semibold }]}>
          {ext?.slice(0, 4) ?? 'FILE'}
        </Text>
      </View>
      <View style={styles.fileMeta}>
        <Text
          style={{ color: fg, fontFamily: font.medium, fontSize: type.body.size }}
          numberOfLines={1}
        >
          {name}
        </Text>
        <Text
          style={{
            color: muted,
            fontFamily: font.regular,
            fontSize: type.caption.size,
            opacity: isMe ? 0.7 : 1,
          }}
        >
          {humanBytes(estimateBytes(attachment.data))}
        </Text>
      </View>
    </Pressable>
  );
}

/** Base64 → byte estimate. Each 4 b64 chars decode to 3 raw bytes. */
function estimateBytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  root: { gap: space.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, width: SIDE },
  photo: { borderRadius: radius.sm, backgroundColor: '#00000020' },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
    paddingVertical: space.xs,
    paddingHorizontal: space.s,
    borderWidth: 1,
    borderRadius: radius.sm,
  },
  fileBadge: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  fileBadgeText: { fontSize: 10, letterSpacing: 1 },
  fileMeta: { flex: 1, gap: 2 },
});
