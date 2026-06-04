import React from 'react';
import Svg, { G, Rect } from 'react-native-svg';

/**
 * Deterministic geometric mark for group conversations.
 * Spec: AVATAR-SYSTEM.md §7.1.
 *
 * Same visual vocabulary as Cipher S / Door / Peephole: flat brass
 * fills, sharp rectangles, slots, voids — composed in a 3×3 grid
 * driven by a hash of the room ID. Each room gets a unique mark; same
 * input → same mark forever.
 *
 * Why deterministic and not user-customizable: customization here would
 * create exactly the social-signaling pressure ("our group has the
 * cool icon") that breaks the no-identity ethos. The mark is the room.
 */

type Primitive = 'block' | 'slot-h' | 'slot-v' | 'cut' | 'void';
const PRIMITIVES: readonly Primitive[] = ['block', 'slot-h', 'slot-v', 'cut', 'void'];

/**
 * FNV-1a 32-bit hash. Stable across runs, no crypto guarantees needed —
 * we just want consistent dispersion across the 5-primitive × 9-cell ×
 * 2-rotation space (~3.4M shapes). The seed is also the input to the
 * cell selector + rotation flag below, so collisions on `roomId` would
 * produce identical marks. That's fine: only matters if two groups ever
 * end up with the same `roomId`, which the server prevents.
 */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function cellsFromSeed(seed: number): Primitive[] {
  const cells: Primitive[] = [];
  for (let i = 0; i < 9; i++) {
    const bits = (seed >> (i * 3)) & 0b111;
    cells.push(PRIMITIVES[bits % PRIMITIVES.length]!);
  }
  return cells;
}

interface Props {
  roomId: string;
  size: number;
  color?: string;
}

/**
 * The mark's primitives in the 0–100 viewBox, with no `<Svg>` wrapper —
 * so it can be composed inside another `<Svg>` (e.g. the notification
 * rasterizer's background tile in GroupMarkCacheWarmer). `RoomMark`
 * wraps this in an `<Svg>`; both share the same deterministic geometry.
 */
export function RoomMarkPrimitives({
  roomId,
  color = '#E5A645', // brass
}: {
  roomId: string;
  color?: string;
}): React.ReactElement {
  const seed = hash32(roomId);
  const cells = cellsFromSeed(seed);
  const rotate = (seed >> 27) & 1;
  const cellSize = 100 / 3;
  const inset = 2;

  return (
    <G transform={rotate ? 'rotate(90 50 50)' : undefined}>
      {cells.map((primitive, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const x = col * cellSize;
        const y = row * cellSize;

        switch (primitive) {
          case 'block':
            return (
              <Rect
                key={i}
                x={x + inset}
                y={y + inset}
                width={cellSize - inset * 2}
                height={cellSize - inset * 2}
                fill={color}
              />
            );
          case 'slot-h':
            return (
              <Rect
                key={i}
                x={x + inset}
                y={y + cellSize / 2 - cellSize / 6}
                width={cellSize - inset * 2}
                height={cellSize / 3}
                fill={color}
              />
            );
          case 'slot-v':
            return (
              <Rect
                key={i}
                x={x + cellSize / 2 - cellSize / 6}
                y={y + inset}
                width={cellSize / 3}
                height={cellSize - inset * 2}
                fill={color}
              />
            );
          case 'cut':
            // Block with a horizontal void cut through the middle. Two
            // rectangles flanking the slot keep the void aligned to the
            // canvas — using SVG masking would also work but is more
            // expensive on the rn-svg side.
            return (
              <React.Fragment key={i}>
                <Rect
                  x={x + inset}
                  y={y + inset}
                  width={cellSize - inset * 2}
                  height={cellSize / 3 - 2}
                  fill={color}
                />
                <Rect
                  x={x + inset}
                  y={y + cellSize / 2 + 2}
                  width={cellSize - inset * 2}
                  height={cellSize / 3 - 2}
                  fill={color}
                />
              </React.Fragment>
            );
          case 'void':
            return null;
        }
      })}
    </G>
  );
}

export function RoomMark({ roomId, size, color }: Props): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <RoomMarkPrimitives roomId={roomId} color={color} />
    </Svg>
  );
}
