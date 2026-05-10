import React, { useRef } from 'react';
import {
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SettingsListItem } from '../components/SettingsListItem.js';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
  onOpenDiagnostics?: () => void;
}

const PRIVACY_URL = 'https://speakeasyapp.xyz/privacy';
const TERMS_URL = 'https://speakeasyapp.xyz/terms';
const OPEN_SOURCE_URL = 'https://speakeasyapp.xyz/open-source';
const SUPPORT_EMAIL = 'hello@speakeasy.app';

// Matches apps/mobile/android/app/build.gradle versionName +
// versionCode. Manual sync until a build-time bake step lands.
// Re-exported so other modules (e.g. ChatScreen for feedback
// app_version field) reference a single source of truth.
export const APP_VERSION = '0.5.0-rc.50';
export const APP_BUILD = '50';
const VERSION = APP_VERSION;
const BUILD = APP_BUILD;

/**
 * SETTINGS.md §9 — three sections + footer.
 *
 * The "What we don't do" paragraph is canonical text per §9.2;
 * never dilute, A/B test, compress, or move it behind feature
 * flags. Hard-coded in source.
 *
 * In `__DEV__` builds the version line tap-7-times unlocks the
 * DiagnosticsScreen per §9.5 / CLAUDECODENOTE.md §3. In production
 * the tap handler is compiled out.
 */
export function AboutScreen({
  onBack,
  onOpenDiagnostics,
}: Props): React.ReactElement {
  const themed = useColors();
  // Debug-only 7-tap unlock.
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleVersionTap() {
    // 7-tap unlock is enabled in all alpha builds — without it the
    // user has no way to reach Diagnostics on a release-mode APK,
    // which is what we ship for sideload testing. When a real
    // production-vs-alpha build flag exists this can re-gate to
    // "alpha-only".
    if (!onOpenDiagnostics) return;
    tapCountRef.current += 1;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    if (tapCountRef.current >= 7) {
      tapCountRef.current = 0;
      onOpenDiagnostics();
      return;
    }
    tapTimerRef.current = setTimeout(() => {
      tapCountRef.current = 0;
    }, 5000);
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="about-screen"
    >
      <View style={[styles.appbar, { borderBottomColor: themed.divider }]}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.back}>
          <Text style={[styles.backText, { color: themed.slate }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: themed.ink }]}>About</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          WHAT WE DON'T DO
        </Text>
        <Text style={[styles.aboutSummary, { color: themed.slate }]}>
          We don't ask for your phone or email. We don't store your photo. We
          don't keep your messages on our servers after they're delivered. We
          can't read what you say. We don't sell, share, or analyze your data
          — there's nothing to sell. We don't show ads.
        </Text>

        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          DOCUMENTS
        </Text>
        <SettingsListItem
          kind="drilldown"
          title="Privacy policy"
          description="Plain-language version of the above."
          onPress={() => void Linking.openURL(PRIVACY_URL)}
        />
        <SettingsListItem
          kind="drilldown"
          title="Terms of service"
          onPress={() => void Linking.openURL(TERMS_URL)}
        />
        <SettingsListItem
          kind="drilldown"
          title="Open source"
          description="Libraries we build on."
          onPress={() => void Linking.openURL(OPEN_SOURCE_URL)}
        />

        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          CONTACT
        </Text>
        <SettingsListItem
          kind="drilldown"
          title="Email us"
          description={SUPPORT_EMAIL}
          onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
        />

        {/* Alpha-only — surfaces the Diagnostics screen as a regular
            row instead of behind the 7-tap version unlock (which has
            been unreliable on release-mode builds). When alpha →
            production this block re-gates behind the alpha flag and
            the 7-tap unlock returns as the dev-only path. */}
        {onOpenDiagnostics ? (
          <>
            <Text style={[styles.sectionLabel, { color: themed.slate }]}>
              ALPHA
            </Text>
            <SettingsListItem
              kind="drilldown"
              title="Diagnostics"
              description="Logs, last crash, entitlement reset."
              onPress={onOpenDiagnostics}
              testID="about-diagnostics-row"
            />
          </>
        ) : null}

        <View style={styles.footer}>
          <Pressable
            onPress={handleVersionTap}
            hitSlop={8}
            testID="about-version"
          >
            <Text style={[styles.version, { color: themed.slate }]}>
              VERSION {VERSION} · BUILD {BUILD}
            </Text>
          </Pressable>
          <Text style={[styles.tagline, { color: themed.slate }]}>
            Say it. Leave nothing.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  back: { width: 32, paddingVertical: 4 },
  backText: { fontFamily: font.regular, fontSize: 28, lineHeight: 28 },
  title: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: typeScale.subtitle.size * typeScale.subtitle.letterSpacingEm,
  },
  content: { paddingBottom: 32 },
  sectionLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: 9.5,
    letterSpacing: 0.22 * 9.5,
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 10,
  },
  aboutSummary: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 21,
    paddingHorizontal: 16,
    paddingBottom: 18,
  },
  footer: {
    alignItems: 'center',
    paddingTop: 24,
    paddingBottom: 8,
  },
  version: {
    fontFamily: typeScale.meta.weight,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  tagline: {
    fontFamily: font.regular,
    fontSize: 12,
    fontStyle: 'italic',
  },
});
