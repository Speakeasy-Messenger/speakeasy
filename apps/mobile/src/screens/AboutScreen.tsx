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
import { AppBar } from '../components/AppBar.js';
import { SettingsListItem } from '../components/SettingsListItem.js';
import { useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
  onOpenDiagnostics?: () => void;
}

const PRIVACY_URL = 'https://speakeasyapp.xyz/privacy';
const TERMS_URL = 'https://speakeasyapp.xyz/terms';
const OPEN_SOURCE_URL = 'https://speakeasyapp.xyz/open-source';
const SUPPORT_EMAIL = 'hello@speakeasy.app';

// rc.82+: version reads from the native module (BuildConfig baked at
// build time from the git tag). Imported via function calls so each
// access pulls the current native value (matters in vitest where the
// mock module can be re-initialized across test files).
import { appVersion, appBuild } from '../version.js';
const VERSION = appVersion();
const BUILD = appBuild();

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
      <AppBar onBack={onBack} title="About" testID="about-appbar" />

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
