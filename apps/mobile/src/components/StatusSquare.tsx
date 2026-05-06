import React from 'react';
import { View } from 'react-native';
import { Peephole } from '../brand/Peephole.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Handle status indicator — BRANDING1.md §6.10.
 *
 * Not actually a pill (we don't do pills). It's a tiny brass square,
 * 6×6, no border, displayed inline next to a handle. Three states:
 *
 *   online  — brass square
 *   offline — text-faint square (same dimensions)
 *   sealed  — Peephole mark scaled to 8px (when the conversation has
 *             expired)
 */
type Variant = 'online' | 'offline' | 'sealed';

export interface StatusSquareProps {
  variant: Variant;
  /** Override the side length. Default 6 (per spec). Sealed: 8. */
  size?: number;
}

export function StatusSquare({ variant, size }: StatusSquareProps): React.JSX.Element {
  const theme = useTheme();
  if (variant === 'sealed') {
    return <Peephole size={size ?? 8} />;
  }
  const side = size ?? 6;
  return (
    <View
      style={{
        width: side,
        height: side,
        backgroundColor: variant === 'online' ? theme.accent : theme.textFaint,
      }}
    />
  );
}
