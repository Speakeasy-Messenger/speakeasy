import React, { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { AppBar } from '../components/AppBar.js';
import {
  clearDiag,
  formatDiag,
  getDiagSnapshot,
  subscribeDiag,
  type DiagEntry,
} from '../diag/log.js';
import {
  clearLastJsCrash,
  readLastJsCrash,
  type CapturedCrash,
} from '../diag/install-error-handler.js';
import { useColors } from '../theme/index.js';
import { font, space, type as typeScale } from '../theme/tokens.js';
import { useOwnership } from '../store/ownership.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { descriptorFor } from '../avatars/catalog.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { api } from '../services.js';

interface Props {
  onBack: () => void;
  /** Avatar/handle/room-mark preview screen — kept as the third
   * action button per the mockup (replaces "Force crash" which is
   * less useful for our alpha workflow). */
  onOpenAvatarPreview?: () => void;
}

/**
 * Diagnostics — alpha-channel only (CLAUDECODENOTE.md §3).
 *
 * Reachable via the 7-tap-version unlock on the About footer. NOT
 * `__DEV__`-gated at the route level (see RootNavigator.tsx) — the
 * tap-gate is the access control, the diag buffer's redaction
 * (peerFp + textLen, never plaintext) is the data-leak defense.
 * Any tester who finds the unlock can open this screen and copy
 * the buffer; that buffer must never contain plaintext peer handles
 * or message previews. See `diag/log.ts:diagFingerprint`.
 *
 * Layout follows the rebrand mockup:
 *
 *   - Last-crash card pinned at the top (when a captured crash
 *     exists)
 *   - Three sharp-bordered action buttons in a dock (Copy logs /
 *     Clear logs / Avatar preview)
 *   - LIVE LOG section label
 *   - Dense `timestamp · brass-tag · message` rows
 *
 * Soft constraints carried through:
 *   - No automatic log shipping (Copy logs only — clipboard)
 *   - No PII redaction yet — TODO: walk the diag call sites and
 *     ensure tags + messages don't include handles, message
 *     content, or room IDs
 */
export function DiagnosticsScreen({ onBack, onOpenAvatarPreview }: Props) {
  const themed = useColors();
  const [entries, setEntries] = useState<DiagEntry[]>(() => getDiagSnapshot());
  const [lastCrash, setLastCrash] = useState<CapturedCrash | null>(null);
  const [copied, setCopied] = useState<'none' | 'log' | 'crash'>('none');

  useEffect(() => {
    const off = subscribeDiag((e) => setEntries(e.slice()));
    void readLastJsCrash().then(setLastCrash);
    return off;
  }, []);

  function handleCopyLog() {
    const header = `speakeasy diagnostics — ${new Date().toISOString()} — ${entries.length} events`;
    Clipboard.setString(`${header}\n\n${formatDiag(entries)}`);
    setCopied('log');
    setTimeout(() => setCopied('none'), 1500);
  }

  function handleCopyCrash() {
    if (!lastCrash) return;
    const lines = [
      `speakeasy crash — ${lastCrash.capturedAt}`,
      `${lastCrash.errorName}: ${lastCrash.errorMessage}`,
    ];
    if (lastCrash.errorStack) lines.push('', lastCrash.errorStack);
    if (lastCrash.diagLog)
      lines.push('', '— diag log at crash time —', lastCrash.diagLog);
    Clipboard.setString(lines.join('\n'));
    setCopied('crash');
    setTimeout(() => setCopied('none'), 1500);
  }

  function handleClearLog() {
    clearDiag();
    setEntries([]);
  }

  function handleClearCrash() {
    setLastCrash(null);
    void clearLastJsCrash();
  }

  function handleWipeEntitlements() {
    // Phase A only — fake purchases persist to AsyncStorage; once we
    // wire RevenueCat the source-of-truth is the platform store and
    // this affordance becomes a wrapper around `Purchases.logOut()`.
    //
    // Confirmation prompt + post-wipe alert because earlier silent
    // wipes left users wondering whether the tap registered. The
    // post-wipe alert also explains the side effect (avatar may
    // change if their selection was a paid one).
    Alert.alert(
      'Reset purchases?',
      'Clears your local fake-purchase state. Your selected avatar will be reset if it was a paid one (Phase A has no real entitlements yet).',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await useOwnership.getState().reset();
              // If the user is currently wearing a paid avatar, fall
              // back to a free one so they don't show as locked-out
              // of their own face.
              const userId = useIdentity.getState().userId;
              const deviceToken = useIdentity.getState().deviceToken;
              if (userId) {
                const own = useProfiles.getState().byUserId[userId];
                const current = own?.selectedAvatarId;
                const desc = current ? descriptorFor(current) : undefined;
                if (desc && desc.tier !== 'free') {
                  const free = defaultAnimalForUser(userId);
                  useProfiles.getState().set(userId, {
                    selectedAvatarId: free,
                    fetchedAt: Date.now(),
                  });
                  if (deviceToken) {
                    void api.setAvatar(deviceToken, free).catch(() => {
                      /* server hiccup is OK — local state is the source
                       * of truth until next setAvatar */
                    });
                  }
                }
              }
              Alert.alert(
                'Reset.',
                'Locked tiles will appear in Change my face → Rare / Legendary.',
              );
            })();
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView
      testID="diagnostics-screen"
      style={[styles.root, { backgroundColor: themed.cream }]}
    >
      <AppBar onBack={onBack} title="Diagnostics" testID="diagnostics-appbar" />

      <View style={[styles.actionsBar, { borderBottomColor: themed.divider }]}>
        <ActionButton
          label={copied === 'log' ? 'Copied' : 'Copy logs'}
          onPress={handleCopyLog}
          themed={themed}
          testID="diag-copy-logs"
        />
        <ActionButton
          label="Clear"
          onPress={handleClearLog}
          themed={themed}
          testID="diag-clear-logs"
        />
        {onOpenAvatarPreview ? (
          <ActionButton
            label="Avatar preview"
            onPress={onOpenAvatarPreview}
            themed={themed}
            testID="diag-avatar-preview"
          />
        ) : null}
      </View>

      {/* Dedicated row for the Reset-purchases affordance. Was crammed
          into the top action bar in earlier alphas; the label was
          truncating on narrow screens and users reported it looked
          unresponsive. As its own row with full width + brass border
          it's unambiguous. */}
      <Pressable
        onPress={handleWipeEntitlements}
        style={({ pressed }) => [
          styles.bigAction,
          {
            borderColor: themed.divider,
            backgroundColor: pressed ? themed.soft : 'transparent',
          },
        ]}
        testID="diag-wipe-entitlements"
      >
        <Text style={[styles.bigActionTitle, { color: themed.ink }]}>
          Reset purchases
        </Text>
        <Text style={[styles.bigActionSub, { color: themed.slate }]}>
          Clear local fake-purchase state. Phase A only — RevenueCat
          replaces this in Phase C.
        </Text>
      </Pressable>

      <FlatList
        data={entries}
        keyExtractor={(e, i) => `${e.tag}-${e.t}-${i}`}
        ListHeaderComponent={
          lastCrash ? (
            <CrashCard
              crash={lastCrash}
              onCopy={handleCopyCrash}
              onClear={handleClearCrash}
              copied={copied === 'crash'}
              themed={themed}
            />
          ) : null
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: themed.slate }]}>
            No events captured yet.
          </Text>
        }
        renderItem={({ item }) => <DiagRow entry={item} themed={themed} />}
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
  );
}

function ActionButton({
  label,
  onPress,
  themed,
  testID,
}: {
  label: string;
  onPress: () => void;
  themed: ReturnType<typeof useColors>;
  testID: string;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.actionBtn,
        {
          borderColor: themed.divider,
          backgroundColor: pressed ? themed.soft : 'transparent',
        },
      ]}
      testID={testID}
    >
      <Text style={[styles.actionLabel, { color: themed.ink }]}>{label}</Text>
    </Pressable>
  );
}

function CrashCard({
  crash,
  onCopy,
  onClear,
  copied,
  themed,
}: {
  crash: CapturedCrash;
  onCopy: () => void;
  onClear: () => void;
  copied: boolean;
  themed: ReturnType<typeof useColors>;
}): React.ReactElement {
  return (
    <View>
      <View style={styles.sectionLabelWrap}>
        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          LAST CRASH · {timeAgo(crash.capturedAt)}
        </Text>
      </View>
      <View
        style={[
          styles.crashCard,
          { borderColor: themed.divider, backgroundColor: themed.pale },
        ]}
        testID="diag-crash-card"
      >
        <Text
          style={[styles.crashTitle, { color: themed.ink }]}
          numberOfLines={2}
        >
          {crash.errorName}: {crash.errorMessage}
        </Text>
        {crash.errorStack ? (
          <Text style={[styles.crashStack, { color: themed.slate }]}>
            {crash.errorStack.split('\n').slice(0, 4).join('\n')}
          </Text>
        ) : null}
        <View style={styles.crashActions}>
          <Pressable
            onPress={onCopy}
            hitSlop={4}
            style={({ pressed }) => [
              styles.actionBtn,
              styles.actionBtnSmall,
              {
                borderColor: themed.divider,
                backgroundColor: pressed ? themed.soft : 'transparent',
              },
            ]}
            testID="diag-crash-copy"
          >
            <Text style={[styles.actionLabel, { color: themed.ink }]}>
              {copied ? 'Copied' : 'Copy crash'}
            </Text>
          </Pressable>
          <Pressable
            onPress={onClear}
            hitSlop={4}
            style={({ pressed }) => [
              styles.actionBtn,
              styles.actionBtnSmall,
              {
                borderColor: themed.divider,
                backgroundColor: pressed ? themed.soft : 'transparent',
              },
            ]}
            testID="diag-crash-clear"
          >
            <Text style={[styles.actionLabel, { color: themed.slate }]}>
              Dismiss
            </Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.sectionLabelWrap}>
        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          LIVE LOG
        </Text>
      </View>
    </View>
  );
}

function DiagRow({
  entry,
  themed,
}: {
  entry: DiagEntry;
  themed: ReturnType<typeof useColors>;
}): React.ReactElement {
  return (
    <View style={[styles.row, { borderBottomColor: themed.divider }]}>
      <Text style={[styles.rowTs, { color: themed.divider }]}>
        {formatTs(entry.t)}
      </Text>
      <Text style={[styles.rowTag, { color: themed.primary }]}>
        {entry.tag}
      </Text>
      <Text
        style={[styles.rowMsg, { color: themed.ink }]}
        numberOfLines={3}
      >
        {entry.msg}
        {entry.ctx ? ` ${formatData(entry.ctx)}` : ''}
      </Text>
    </View>
  );
}

function formatTs(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatData(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function timeAgo(at: number | string): string {
  const ms = typeof at === 'string' ? Date.parse(at) : at;
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Sharp-bordered transparent action buttons docked under the bar.
  actionsBar: {
    flexDirection: 'row',
    gap: space.s,
    paddingHorizontal: space.base,
    paddingVertical: space.m,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: space.m,
    paddingHorizontal: space.s,
    borderWidth: 1,
    alignItems: 'center',
  },
  actionBtnSmall: {
    flex: 0,
    paddingVertical: space.s,
    paddingHorizontal: space.base,
  },
  actionLabel: {
    fontFamily: font.medium,
    fontSize: 12,
    letterSpacing: 0.02 * 12,
  },
  sectionLabelWrap: {
    paddingHorizontal: space.base,
    paddingTop: space.base,
    paddingBottom: space.m,
  },
  sectionLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: 9.5,
    letterSpacing: 0.22 * 9.5,
    textTransform: 'uppercase',
  },
  crashCard: {
    marginHorizontal: space.base,
    paddingHorizontal: space.base,
    paddingVertical: space.m,
    borderWidth: 1,
    gap: space.s,
  },
  crashTitle: {
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 18,
  },
  crashStack: {
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  crashActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  listContent: { paddingBottom: space.xxl },
  bigAction: {
    marginHorizontal: space.base,
    marginTop: space.m,
    paddingVertical: space.base,
    paddingHorizontal: space.base,
    borderWidth: 1,
  },
  bigActionTitle: {
    fontFamily: font.medium,
    fontSize: 15,
    letterSpacing: -0.005 * 15,
  },
  bigActionSub: {
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
    gap: space.m,
    paddingHorizontal: space.base,
    paddingVertical: space.s,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTs: {
    fontFamily: font.regular,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  rowTag: {
    fontFamily: font.medium,
    fontSize: 11,
    letterSpacing: 0.02 * 11,
    flexShrink: 0,
  },
  rowMsg: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
  },
  empty: {
    fontFamily: font.regular,
    fontSize: 13,
    textAlign: 'center',
    paddingTop: space.xxl,
    paddingHorizontal: space.xl,
  },
});
