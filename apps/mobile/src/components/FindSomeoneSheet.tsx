import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isUserId } from '@speakeasy/shared';
import { Handle } from './Handle.js';
import { PortraitTile } from './PortraitTile.js';
import { StatusSquare } from './StatusSquare.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { ApiError } from '../api/client.js';
import { api } from '../services.js';
import { useBlocks } from '../store/blocks.js';
import { useIdentity } from '../store/identity.js';
import { diag } from '../diag/log.js';
import { useColors } from '../theme/index.js';
import { font, scrim, space, type as typeScale } from '../theme/tokens.js';

/**
 * NEW-CONVERSATION.md §3 — Find Someone sheet.
 *
 * Bottom-sheet that converts a *known* handle into an open chat.
 * Speakeasy has no directory: this is exact-match-only by design,
 * and the empty state copy says so plainly.
 *
 * State machine (per spec §3.2):
 *   empty → invalid | checking → found | not_found | self | error
 *
 * Reuses the onboarding `GET /v1/users/availability` endpoint per
 * spec §3.4 — semantics flip in find context: `available: false` +
 * `reason: 'taken'` means "this handle is claimed" = found.
 */

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * Mode 'find' (default): tapping the result card opens a 1:1 chat.
   * Mode 'add-to-room': tapping returns the handle to the parent so
   * it can be added to the pending member list. Used by the Create
   * Room screen + Group Settings.
   * Mode 'block' (BURN.md §11.5 / BLOCK.md): tapping returns the
   * handle to the parent which then opens the BlockConfirmSheet.
   * Used by the BlockList screen's "Block someone" row.
   */
  mode?: 'find' | 'add-to-room' | 'block';
  /**
   * Pre-fill the input — used by the deep-link entry path
   * (`speakeasy://add?handle=…`) and by the clipboard prefill prompt.
   */
  initialHandle?: string;
  /** When mode='find': fired on tap of the result card. */
  onPickPeer?: (handle: string) => void;
  /** When mode='add-to-room': fired when the user picks a handle. */
  onPickAdd?: (handle: string) => void;
  /** When mode='block': fired when the user picks a handle. */
  onPickBlock?: (handle: string) => void;
  /** When mode='find': fired on tap of the "or create a room →" link. */
  onCreateRoom?: () => void;
  /**
   * In add-to-room mode: handles that are already in the pending
   * member list, so the result card renders the "already added"
   * variant per spec §3.3 / §4.3 instead of "in the room".
   */
  alreadyAddedHandles?: readonly string[];
  /**
   * Add-to-room mode shows the room name as part of the title:
   * "Add to <roomName>." Falls back to "Add someone." when undefined.
   */
  roomName?: string;
}

type LookupState =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'checking' }
  | { kind: 'found' }
  | { kind: 'blocked_by_you' }
  | { kind: 'not_found' }
  | { kind: 'self' }
  | { kind: 'already_added' }
  | { kind: 'network_error' };

export function FindSomeoneSheet({
  visible,
  onClose,
  mode = 'find',
  initialHandle,
  onPickPeer,
  onPickAdd,
  onPickBlock,
  onCreateRoom,
  alreadyAddedHandles,
  roomName,
}: Props): React.ReactElement {
  const themed = useColors();
  // Edge-to-edge: pad the sheet's bottom past the nav bar (the sheet is
  // position:absolute bottom:0, so it sits on the true screen edge).
  const insets = useSafeAreaInsets();
  const myUserId = useIdentity((s) => s.userId);
  const isBlocked = useBlocks((s) => s.isBlocked);
  const unblock = useBlocks((s) => s.unblock);
  const [input, setInput] = useState('');
  const [state, setState] = useState<LookupState>({ kind: 'empty' });

  // Entry-cache per spec §3.4 — 60s memoization keyed by handle so
  // repeat lookups within the sheet are instant.
  const cacheRef = useRef<Map<string, { at: number; found: boolean }>>(new Map());

  // Reset whenever the sheet opens. Apply initialHandle once if given.
  useEffect(() => {
    if (!visible) return;
    setInput(initialHandle ?? '');
    setState({ kind: 'empty' });
  }, [visible, initialHandle]);

  // Diag — overlay lifecycle. The rc.27→rc.29 freeze reports were
  // *because the React Native Modal never rendered* on Samsung dark-
  // mode + statusBarTranslucent: the JS thread hung mid-render and
  // every touch handler died. rc.30 drops Modal entirely and uses an
  // inline absolute-fill overlay rendered as part of the parent
  // screen's tree, so this log fires the same as any other component.
  useEffect(() => {
    diag('ui', 'find-sheet visibility', { visible: String(visible), mode });
  }, [visible, mode]);

  // Android back button — dismiss the sheet when visible. Intercept
  // the hardware-back event ahead of the navigator's default handler,
  // matching what RN's Modal used to do for us.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      diag('ui', 'find-sheet backHandler → close');
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  // Focused-border colour: brass while focused, faint otherwise.
  const [focused, setFocused] = useState(false);

  // 300ms debounce + lookup. Re-runs whenever input changes.
  useEffect(() => {
    if (!visible) return;
    const candidate = input.trim().toLowerCase();
    if (!candidate) {
      setState({ kind: 'empty' });
      return;
    }
    if (myUserId && candidate === myUserId) {
      setState({ kind: 'self' });
      return;
    }
    if (alreadyAddedHandles?.includes(candidate)) {
      setState({ kind: 'already_added' });
      return;
    }
    // BLOCK.md §9: a handle the local user has blocked surfaces as
    // a muted result card with an "unblock" link, *before* the
    // server lookup fires. Skips burning rate-limit budget on
    // handles we already know are reachable from our perspective.
    if (isUserId(candidate) && isBlocked(candidate)) {
      setState({ kind: 'blocked_by_you' });
      return;
    }
    if (!isUserId(candidate)) {
      setState({
        kind: 'invalid',
        reason: 'letters, numbers, dots, hyphens, underscores only',
      });
      return;
    }
    // Cache hit?
    const cached = cacheRef.current.get(candidate);
    if (cached && Date.now() - cached.at < 60_000) {
      setState({ kind: cached.found ? 'found' : 'not_found' });
      return;
    }
    setState({ kind: 'checking' });
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.checkAvailability(candidate);
        if (cancelled) return;
        // Spec §3.4: in find context, `available: false` + reason
        // `'taken'` means the handle is claimed → found. Other
        // not-available reasons (`'reserved'`, `'invalid'`) are
        // treated as not_found (we shouldn't surface reserved
        // handles as reachable peers).
        const found = !r.available && r.reason === 'taken';
        cacheRef.current.set(candidate, { at: Date.now(), found });
        setState({ kind: found ? 'found' : 'not_found' });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setState({ kind: 'network_error' });
        } else {
          setState({ kind: 'network_error' });
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [input, visible, myUserId, alreadyAddedHandles, isBlocked]);

  const candidate = input.trim().toLowerCase();

  function handleResultTap() {
    if (state.kind !== 'found') return;
    if (mode === 'add-to-room') {
      onPickAdd?.(candidate);
    } else if (mode === 'block') {
      onPickBlock?.(candidate);
    } else {
      onPickPeer?.(candidate);
    }
    onClose();
  }

  const titleText =
    mode === 'add-to-room'
      ? roomName
        ? `Add to ${roomName}.`
        : 'Add someone.'
      : mode === 'block'
        ? 'Block someone.'
        : 'Find someone.';

  const subtitleText =
    mode === 'add-to-room'
      ? "They'll see the room when you create it."
      : mode === 'block'
        ? "They won't know they were blocked."
        : "Speakeasy doesn't have a directory. Type their handle exactly.";

  // Render nothing when invisible — saves a frame's worth of layout.
  if (!visible) return <View testID="find-sheet-hidden" />;

  return (
    <View
      style={styles.overlay}
      testID="find-sheet-overlay"
    >
      {/* No <Modal> — Android Samsung One UI dark mode +
          statusBarTranslucent + slide animation reproducibly hung the
          JS thread on render in rc.27→rc.29. Replaced with an inline
          absolute-fill View rendered as a sibling of the screen's
          content. Behavior identical to a bottom sheet, but fully
          inside our React tree — no native Modal portal involved. */}
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: scrim.modal }]}
          onPress={() => {
            diag('ui', 'find-sheet scrim tap → close');
            onClose();
          }}
          testID="find-sheet-scrim"
        />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: themed.cream,
              borderTopColor: themed.divider,
              paddingBottom: insets.bottom + space.xxl,
            },
          ]}
          testID="find-sheet"
        >
        <View style={styles.sheetHeader}>
          {/* Long-press the grab handle to copy diag to clipboard.
              Backup escape hatch in case the user perceives the modal
              as frozen — works regardless of scrim/× responsiveness. */}
          <Pressable
            onLongPress={() => {
              void (async () => {
                try {
                  const { formatDiag, getDiagSnapshot } = await import(
                    '../diag/log.js'
                  );
                  const Clipboard = (
                    await import('@react-native-clipboard/clipboard')
                  ).default;
                  Clipboard.setString(formatDiag(getDiagSnapshot()));
                  diag('ui', 'find-sheet grab long-press → diag copied');
                } catch (err) {
                  diag('ui', 'find-sheet grab long-press → copy failed', {
                    err: String(err),
                  });
                }
              })();
            }}
            delayLongPress={1200}
            hitSlop={16}
            style={styles.grabPressable}
            testID="find-sheet-grab"
          >
            <View style={[styles.grab, { backgroundColor: themed.divider }]} />
          </Pressable>
          {/* Visible × close button — unmistakable dismiss affordance.
              Sized 44×44 (Android tap-target minimum) and outlined so
              it's impossible to miss. */}
          <Pressable
            onPress={() => {
              diag('ui', 'find-sheet × tap → close');
              onClose();
            }}
            hitSlop={12}
            style={({ pressed }) => [
              styles.closeBtn,
              { borderColor: themed.divider },
              pressed && { backgroundColor: themed.soft },
            ]}
            testID="find-sheet-close"
          >
            <Text style={[styles.closeGlyph, { color: themed.ink }]}>×</Text>
          </Pressable>
        </View>

        <Text style={[styles.title, { color: themed.ink }]}>
          {/* Brass period — brand punctuation per spec §3.1. */}
          {titleText.replace(/\.$/, '')}
          <Text style={{ color: themed.primary }}>.</Text>
        </Text>
        <Text style={[styles.subtitle, { color: themed.slate }]}>
          {subtitleText}
        </Text>

        <View
          style={[
            styles.inputRow,
            {
              borderBottomColor: focused ? themed.primary : themed.divider,
            },
          ]}
        >
          <Text style={[styles.atGlyph, { color: themed.primary }]}>@</Text>
          <TextInput
            testID="find-sheet-input"
            style={[styles.input, { color: themed.ink }]}
            value={input}
            onChangeText={(s) => setInput(s.replace(/^@/, '').toLowerCase())}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            // autoFocus removed — Android can race the keyboard reveal
            // against the Modal's slide-up animation, leaving touch
            // input intercepted by the keyboard layer until the user
            // taps elsewhere. Causes the rc.25 "FAB freeze" feel.
            selectionColor={themed.primary}
            placeholderTextColor={themed.slate}
          />
        </View>

        <View style={styles.stateRegion}>
          <StateView
            state={state}
            handle={candidate}
            mode={mode}
            onTap={handleResultTap}
            onUnblock={() => {
              unblock(candidate);
              // Dropping the block flips the candidate back through
              // validation → server lookup, so the state will move
              // to `checking → found` on the next render.
              setState({ kind: 'empty' });
              setInput((s) => s); // force re-eval of the effect
            }}
          />
        </View>

        {mode === 'find' ? (
          <View style={[styles.footer, { borderTopColor: themed.divider }]}>
            <Pressable
              testID="find-sheet-create-room"
              onPress={() => {
                onClose();
                onCreateRoom?.();
              }}
              hitSlop={6}
            >
              <Text style={[styles.footerText, { color: themed.slate }]}>
                or{' '}
                <Text style={{ color: themed.ink, fontFamily: font.medium }}>
                  create a room
                </Text>{' '}
                <Text style={{ color: themed.primary }}>→</Text>
              </Text>
            </Pressable>
          </View>
        ) : null}
        </View>
    </View>
  );
}

interface StateViewProps {
  state: LookupState;
  handle: string;
  mode: 'find' | 'add-to-room' | 'block';
  onTap: () => void;
  onUnblock: () => void;
}

function StateView({
  state,
  handle,
  mode,
  onTap,
  onUnblock,
}: StateViewProps): React.ReactElement | null {
  const themed = useColors();
  switch (state.kind) {
    case 'empty':
      return null;
    case 'invalid':
      return (
        <View style={styles.miniRow}>
          <View style={[styles.miniSquare, { backgroundColor: themed.slate }]} />
          <Text style={[styles.miniText, { color: themed.slate }]}>
            {state.reason}
          </Text>
        </View>
      );
    case 'checking':
      return (
        <Text style={[styles.miniText, { color: themed.slate }]}>
          looking
          <Text style={{ color: themed.primary }}>…</Text>
        </Text>
      );
    case 'self':
      return (
        <Text style={[styles.miniText, { color: themed.slate }]}>
          that's you
        </Text>
      );
    case 'already_added':
      return (
        <ResultCard
          handle={handle}
          subtext="ALREADY ADDED"
          dimmed
          onPress={undefined}
          testID="find-sheet-already-added"
        />
      );
    case 'blocked_by_you':
      return (
        <View>
          <ResultCard
            handle={handle}
            subtext="YOU BLOCKED THEM"
            dimmed
            onPress={undefined}
            testID="find-sheet-blocked"
          />
          <Pressable
            onPress={onUnblock}
            hitSlop={8}
            testID="find-sheet-unblock"
            style={{ marginTop: 12 }}
          >
            <Text
              style={[
                styles.tapHint,
                { color: themed.primary, marginTop: 0 },
              ]}
            >
              UNBLOCK
            </Text>
          </Pressable>
        </View>
      );
    case 'not_found':
      return (
        <View style={styles.miniRow}>
          <View style={[styles.miniSquare, { backgroundColor: themed.slate }]} />
          <Text style={[styles.miniText, { color: themed.slate }]}>
            no one by that name
          </Text>
        </View>
      );
    case 'network_error':
      return (
        <View style={styles.miniRow}>
          <View style={[styles.miniSquare, { backgroundColor: themed.slate }]} />
          <Text style={[styles.miniText, { color: themed.slate }]}>
            can't reach the room. try again.
          </Text>
        </View>
      );
    case 'found':
      return (
        <>
          <ResultCard
            handle={handle}
            subtext={
              mode === 'add-to-room'
                ? 'TAP TO ADD'
                : mode === 'block'
                  ? 'TAP TO BLOCK'
                  : 'IN THE ROOM'
            }
            onPress={onTap}
            testID="find-sheet-result"
          />
          <Text style={[styles.tapHint, { color: themed.slate }]}>
            {mode === 'add-to-room'
              ? 'TAP TO ADD'
              : mode === 'block'
                ? 'TAP TO BLOCK'
                : 'TAP TO OPEN'}
          </Text>
        </>
      );
  }
}

interface ResultCardProps {
  handle: string;
  subtext: string;
  dimmed?: boolean;
  onPress: (() => void) | undefined;
  testID?: string;
}

function ResultCard({
  handle,
  subtext,
  dimmed,
  onPress,
  testID,
}: ResultCardProps): React.ReactElement {
  const themed = useColors();
  const animalId = defaultAnimalForUser(handle);
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? themed.soft : themed.pale,
          borderColor: themed.divider,
          opacity: dimmed ? 0.5 : 1,
        },
      ]}
    >
      <PortraitTile kind="animal" id={animalId} size={36} />
      <View style={styles.cardBody}>
        <View style={styles.cardLine}>
          <Handle value={handle} variant="subtitle" />
          {!dimmed ? <StatusSquare variant="offline" /> : null}
        </View>
        <Text style={[styles.cardSub, { color: themed.slate }]}>
          {subtext}
        </Text>
      </View>
      {!dimmed ? (
        <Text style={[styles.cardArrow, { color: themed.primary }]}>›</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Overlay — fills the parent screen's tree (rendered as a sibling
  // of the FAB stack inside ConversationsScreen). pointerEvents="box-
  // none" lets taps land on the scrim Pressable / sheet directly,
  // which is fine because the View itself has no styles that need
  // touch interception.
  overlay: {
    ...StyleSheet.absoluteFillObject,
    elevation: 1000, // Android: float above the FAB
    zIndex: 1000,    // iOS / web: same
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.xl,
    paddingTop: space.base,
    paddingBottom: space.xxl,
    borderTopWidth: StyleSheet.hairlineWidth,
    // Fixed minHeight (instead of '60%') — percentage minHeight inside
    // a Modal can compute to 0 on some Android builds, leaving the
    // sheet invisibly tall and the user staring at a darkened scrim
    // wondering what to do.
    minHeight: 480,
  },
  // Header row: grab handle centered, close × on the right.
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.base,
    minHeight: 44,
  },
  grabPressable: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grab: {
    width: 36,
    height: 3,
  },
  closeBtn: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  closeGlyph: {
    fontFamily: font.regular,
    fontSize: 28,
    lineHeight: 30,
  },
  title: {
    fontFamily: font.bold,
    fontSize: 22,
    letterSpacing: -0.025 * 22,
    marginBottom: space.s,
  },
  subtitle: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 24,
    maxWidth: 36 * 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.xs,
    paddingBottom: space.s,
    borderBottomWidth: 1,
    marginBottom: space.m,
  },
  atGlyph: {
    fontFamily: font.bold,
    fontSize: 24,
    lineHeight: 28,
  },
  input: {
    flex: 1,
    fontFamily: font.bold,
    fontSize: 24,
    letterSpacing: -0.025 * 24,
    padding: 0,
  },
  stateRegion: {
    minHeight: 80,
    paddingTop: 4,
  },
  miniRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
    marginTop: space.base,
  },
  miniSquare: { width: 6, height: 6 },
  miniText: {
    fontFamily: font.regular,
    fontSize: 13,
    marginTop: space.base,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.base,
    marginTop: space.s,
    padding: space.base,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardBody: { flex: 1, gap: space.xs },
  cardLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
  },
  cardSub: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
  },
  cardArrow: {
    fontFamily: font.bold,
    fontSize: 18,
  },
  tapHint: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginTop: 12,
  },
  footer: {
    marginTop: 'auto',
    paddingTop: space.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerText: {
    fontFamily: font.regular,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 12,
  },
});
