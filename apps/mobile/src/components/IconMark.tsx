import React from 'react';
import { Image, View } from 'react-native';
import { colors } from '../theme/index.js';

export interface IconMarkProps {
  /** Outer size in px. Default 64. */
  size?: number;
  /** Wrap in a cream rounded shell (app-icon style). Default false. */
  shell?: boolean;
  /**
   * Reserved for backwards compatibility — the previous SVG-based mark
   * supported a continuous "dissolve" loop. The new image-based mark
   * doesn't (yet); the prop is accepted but ignored so callers don't
   * have to be touched. Re-instate when we have a sprite sheet or
   * Lottie / Reanimated path that matches the static asset's fidelity.
   */
  animate?: boolean;
}

/**
 * The Speakeasy icon mark — spec §14.
 *
 * Rendered as the canonical PNG asset shipped at `assets/logo-mark.png`,
 * cropped from the brand sheet master with the dark navy background
 * removed (transparent). Same asset feeds the Android launcher icon
 * generation pipeline (see /tmp/build-icon-svg.mjs and the mipmap-*
 * directories).
 *
 * The image's intrinsic aspect ratio is ~0.96:1 (slightly portrait —
 * tall bubble, streaks extend right). The component preserves that ratio
 * while rendering at the requested width.
 */
const LOGO = require('../../assets/logo-mark.png');
const LOGO_ASPECT_RATIO = 1; // 432×432 — matches the launcher-foreground asset.

export function IconMark({ size = 64, shell = false }: IconMarkProps) {
  const width = size;
  const height = Math.round(size / LOGO_ASPECT_RATIO);

  const image = (
    <Image
      source={LOGO}
      style={{ width, height }}
      resizeMode="contain"
      accessible
      accessibilityLabel="Speakeasy"
    />
  );

  if (!shell) return image;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        backgroundColor: colors.cream,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Image
        source={LOGO}
        style={{ width: size * 0.78, height: size * 0.78 }}
        resizeMode="contain"
      />
    </View>
  );
}
