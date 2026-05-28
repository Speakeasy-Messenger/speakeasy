/**
 * The discrete animation stage of a message bubble per spec §14
 * motion #2 (sent → seen → disappearing → almost-gone → gone).
 *
 * Lives in its own file (separate from DisappearingMessageBubble.tsx)
 * so consumers that only need the TYPE — like the conversations
 * store — can import it without dragging `import 'react-native'`
 * into their module-load graph. That import chain trips up
 * vitest's rollup parser on the Flow `import typeof` syntax in
 * react-native's ESM definitions, even when the import is type-only.
 * (TS erases `import type` at runtime but rollup parses everything.)
 */
export type DisappearingStage =
  | 'sent'
  | 'seen'
  | 'disappearing'
  | 'almost-gone'
  | 'gone';
