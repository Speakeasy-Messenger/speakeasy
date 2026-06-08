import React, { useRef } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppBar } from '../components/AppBar.js';
import { SettingsListItem } from '../components/SettingsListItem.js';
import { useColors } from '../theme/index.js';
import { font, space, type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
  onOpenDiagnostics?: () => void;
}

const PRIVACY_URL = 'https://speakeasyapp.xyz/privacy';
const TERMS_URL = 'https://speakeasyapp.xyz/terms';
const OPEN_SOURCE_URL = 'https://speakeasyapp.xyz/open-source';
const SUPPORT_EMAIL = 'info@speakeasyapp.xyz';

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
 * Diagnostics is a hidden, support-only surface: it's reached ONLY by
 * tapping the version line 5 times in a row (§9.5). There is no visible
 * Diagnostics row in production — keeping the logs/entitlement-reset tools
 * out of the everyday UI. The version line has a deliberately generous
 * tap target (padding + hitSlop) so the gesture is reliable on a release
 * APK, which is what an earlier always-visible row was a workaround for.
 */
const DIAGNOSTICS_TAP_COUNT = 5;
const DIAGNOSTICS_TAP_WINDOW_MS = 5000;

export function AboutScreen({
  onBack,
  onOpenDiagnostics,
}: Props): React.ReactElement {
  const themed = useColors();
  // Hidden 5-tap unlock for the Diagnostics screen.
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleVersionTap() {
    if (!onOpenDiagnostics) return;
    tapCountRef.current += 1;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    if (tapCountRef.current >= DIAGNOSTICS_TAP_COUNT) {
      tapCountRef.current = 0;
      onOpenDiagnostics();
      return;
    }
    tapTimerRef.current = setTimeout(() => {
      tapCountRef.current = 0;
    }, DIAGNOSTICS_TAP_WINDOW_MS);
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
        <Text style={[styles.feedbackNote, { color: themed.slate }]}>
          Found a bug or have an idea? Message @feedback inside the app — it
          goes straight to the team, no email needed.
        </Text>

        {/* Diagnostics has NO visible row — it's reached only by the
            hidden 5-tap on the version line below (see handleVersionTap).
            Keeps support-only tooling out of the everyday UI. */}

        <View style={styles.footer}>
          <Pressable
            onPress={handleVersionTap}
            style={styles.versionTap}
            hitSlop={{ top: 16, bottom: 16, left: 32, right: 32 }}
            accessibilityRole="button"
            accessibilityLabel={`Version ${VERSION}, build ${BUILD}`}
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
    paddingHorizontal: space.base,
    paddingTop: space.lg,
    paddingBottom: space.m,
  },
  aboutSummary: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 21,
    paddingHorizontal: space.base,
    paddingBottom: space.lg,
  },
  feedbackNote: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: space.base,
    paddingTop: space.s,
  },
  footer: {
    alignItems: 'center',
    paddingTop: 24,
    paddingBottom: 8,
  },
  // Generous touch target for the hidden 5-tap Diagnostics unlock —
  // the label itself is small (10pt), so the Pressable pads it out to a
  // comfortable, reliably-hittable area (paired with hitSlop above).
  versionTap: {
    paddingVertical: 12,
    paddingHorizontal: 32,
    alignItems: 'center',
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
