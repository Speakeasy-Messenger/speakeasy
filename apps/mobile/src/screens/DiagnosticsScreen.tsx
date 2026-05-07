import React, { useEffect, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
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
import { colors, fonts, radius, space } from '../theme/index.js';

interface Props {
  onBack: () => void;
}

/**
 * Reads from the in-process diagnostic ring buffer (apps/mobile/src/diag/log.ts).
 * Live-updates as new events arrive. The user can paste the formatted
 * snapshot back to us when something silently fails on-device — without
 * requiring USB / adb logcat access.
 *
 * Not a permanent feature; lives behind a discoverable affordance on
 * the Conversations screen. Will become opt-in once the alpha is
 * stable enough that we don't routinely need to peek at runtime state.
 */
export function DiagnosticsScreen({ onBack }: Props) {
  const [entries, setEntries] = useState<DiagEntry[]>(() => getDiagSnapshot());
  const [lastCrash, setLastCrash] = useState<CapturedCrash | null>(null);
  // Brief visual confirmation after Copy. Reset after 1.5s; the user
  // gets a clear "yes that worked" without a separate Alert prompt.
  const [copied, setCopied] = useState<'none' | 'log' | 'crash'>('none');

  useEffect(() => {
    const off = subscribeDiag((e) => setEntries(e.slice()));
    void readLastJsCrash().then(setLastCrash);
    return off;
  }, []);

  function handleClearCrash() {
    setLastCrash(null);
    void clearLastJsCrash();
  }

  function handleCopyLog() {
    // Bundle the formatted snapshot with a short header so when the
    // user pastes it back to us we know what build / when. Keeps the
    // clipboard payload self-contained.
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
    if (lastCrash.diagLog) lines.push('', '— diag log at crash time —', lastCrash.diagLog);
    Clipboard.setString(lines.join('\n'));
    setCopied('crash');
    setTimeout(() => setCopied('none'), 1500);
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Diagnostics</Text>
        <Text style={styles.subtitle}>
          {entries.length} event{entries.length === 1 ? '' : 's'} captured. Long-press a
          row to copy.
        </Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {lastCrash ? (
          <View style={styles.crashCard}>
            <View style={styles.crashHeader}>
              <Text style={styles.crashTitle}>
                Last crash {lastCrash.isFatal ? '(fatal)' : ''}
              </Text>
              <View style={styles.crashHeaderActions}>
                <Pressable onPress={handleCopyCrash} hitSlop={8}>
                  <Text style={styles.crashClear}>
                    {copied === 'crash' ? 'Copied' : 'Copy'}
                  </Text>
                </Pressable>
                <Pressable onPress={handleClearCrash} hitSlop={8}>
                  <Text style={styles.crashClear}>Dismiss</Text>
                </Pressable>
              </View>
            </View>
            <Text selectable style={styles.crashMeta}>
              {lastCrash.capturedAt}
            </Text>
            <Text selectable style={styles.crashError}>
              {lastCrash.errorName}: {lastCrash.errorMessage}
            </Text>
            {lastCrash.errorStack ? (
              <Text selectable style={styles.crashStack}>
                {lastCrash.errorStack}
              </Text>
            ) : null}
            {lastCrash.diagLog ? (
              <>
                <Text style={styles.crashSubsection}>diag log at crash time:</Text>
                <Text selectable style={styles.crashStack}>
                  {lastCrash.diagLog}
                </Text>
              </>
            ) : null}
          </View>
        ) : null}

        {entries.length === 0 ? (
          <Text style={styles.empty}>No diagnostic events yet.</Text>
        ) : (
          <Text selectable style={styles.log}>
            {formatDiag(entries)}
          </Text>
        )}
      </ScrollView>

      <View style={styles.bottom}>
        <Pressable
          onPress={handleCopyLog}
          disabled={entries.length === 0}
          style={[
            styles.btn,
            styles.btnPrimary,
            entries.length === 0 && styles.btnDisabled,
          ]}
        >
          <Text style={styles.btnTextPrimary}>
            {copied === 'log' ? 'Copied to clipboard' : 'Copy log'}
          </Text>
        </Pressable>
        <Pressable
          onPress={clearDiag}
          style={[styles.btn, styles.btnSecondary]}
        >
          <Text style={styles.btnTextSecondary}>Clear</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    gap: space.xs,
    borderBottomColor: colors.pale,
    borderBottomWidth: 1,
  },
  back: { color: colors.primary, fontFamily: fonts.inter500, fontSize: 14 },
  title: { color: colors.ink, fontFamily: fonts.inter500, fontSize: 18 },
  subtitle: { color: colors.slate, fontFamily: fonts.inter400, fontSize: 12 },
  scroll: { flex: 1 },
  scrollContent: { padding: space.md, paddingBottom: space.xl },
  empty: {
    color: colors.slate,
    fontFamily: fonts.inter400,
    fontSize: 13,
    textAlign: 'center',
    marginTop: space.xl,
  },
  log: {
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 11,
    lineHeight: 16,
  },
  // Spec §1: no third color. The crash card sits on the workspace
  // canvas; it gets a brass accent border + the standard surface bg
  // (not a saturated red).
  crashCard: {
    backgroundColor: colors.pale,
    borderColor: colors.primary,
    borderWidth: 1,
    borderRadius: radius.bubble,
    padding: space.md,
    marginBottom: space.md,
    gap: space.xs,
  },
  crashHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  crashHeaderActions: { flexDirection: 'row', gap: space.md },
  crashTitle: { color: colors.ink, fontFamily: fonts.inter500, fontSize: 14 },
  crashClear: { color: colors.primary, fontFamily: fonts.inter500, fontSize: 12 },
  crashMeta: { color: colors.slate, fontFamily: fonts.inter400, fontSize: 11 },
  crashError: { color: colors.ink, fontFamily: fonts.inter500, fontSize: 12 },
  crashSubsection: {
    color: colors.slate,
    fontFamily: fonts.inter500,
    fontSize: 11,
    marginTop: space.sm,
  },
  crashStack: {
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 10,
    lineHeight: 14,
  },
  bottom: { padding: space.lg, gap: space.sm },
  btn: {
    paddingVertical: 12,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  btnSecondary: { borderWidth: 1, borderColor: colors.primary },
  btnTextSecondary: {
    color: colors.primary,
    fontFamily: fonts.inter500,
    fontSize: 14,
  },
  btnPrimary: { backgroundColor: colors.primary },
  btnTextPrimary: {
    color: colors.cream,
    fontFamily: fonts.inter500,
    fontSize: 14,
  },
  btnDisabled: { opacity: 0.5 },
});
