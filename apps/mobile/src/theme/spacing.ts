/** 4px scale, used by everything. */
export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export const radius = {
  /** Avatars and buttons — spec §14: rounded squares only, 10px. */
  avatar: 10,
  /** Input pill */
  pill: 999,
  /** Sent / received chat bubble corners */
  bubble: 16,
  bubbleTail: 4,
  /** Icon-mark inner corner radius (front / back rect) at standard scale */
  iconMark: 5,
  /** App-icon shell */
  appIcon: 22, // expressed as % of width when applied
} as const;
