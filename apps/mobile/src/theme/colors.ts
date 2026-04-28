/**
 * Speakeasy palette — spec §14 (April 2026 revision: purple replaces gold).
 *
 *   primary  — brand voice: icon mark disc, sent bubbles, primary CTA
 *   soft     — support tint: received bubbles, hover/pressed, fade endpoints
 *   pale     — surface variant, dividers, light input fields, avatar tint
 *   cream    — primary background everywhere
 *   ink      — primary text colour
 *   slate    — structural metadata (labels, timestamps)
 */
export const colors = {
  ink: '#0F1117',
  cream: '#F7F6F3',
  primary: '#6C5CE7',
  soft: '#A79CFF',
  pale: '#E6E3F1',
  slate: '#6B7280',

  // Convenience aliases referenced by chat surfaces:
  chatListBg: '#F7F6F3',
  receivedBubble: '#E6E3F1',
  sentBubble: '#6C5CE7',
  divider: '#E6E3F1',
} as const;

export type ColorToken = keyof typeof colors;
