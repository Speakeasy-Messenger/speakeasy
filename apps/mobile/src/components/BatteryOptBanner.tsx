import React, { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { font, radius, space, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { useOnboardingCards } from '../store/onboarding-cards.js';
import {
  isIgnoringBatteryOptimizations,
  requestDisableBatteryOptimization,
} from '../native/power.js';

/**
 * One-time, dismissable nudge to whitelist Speakeasy from Android battery
 * optimization. Without the exemption, Doze / App-Standby defers the
 * data-only 'rich' pushes' headless handler, so background notifications
 * batch up and only appear on the next foreground — the delayed-
 * notifications report. See native/power.ts + power/PowerModule.kt.
 *
 * Self-hiding: rendered only when the device is NOT already exempt, not
 * dismissed, and on Android (off-Android the check fails to `true`). It
 * re-checks on every foreground, so once the user grants the exemption in
 * the system dialog and returns, the banner disappears on its own without
 * needing a manual dismiss.
 */
const CARD_ID = 'batteryOpt';

export function BatteryOptBanner(): React.JSX.Element | null {
  const dismissed = useOnboardingCards((s) => s.isDismissed(CARD_ID));
  const dismiss = useOnboardingCards((s) => s.dismiss);
  const theme = useTheme();
  // null = not yet checked. We hide while unknown so the banner never
  // flashes before the async check resolves.
  const [exempt, setExempt] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    const check = () => {
      void isIgnoringBatteryOptimizations().then((v) => {
        if (active) setExempt(v);
      });
    };
    check();
    // Re-check when returning from the system dialog (or any foreground)
    // so granting the exemption dismisses the banner automatically.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => {
      active = false;
      sub.remove();
    };
  }, []);

  // Hidden while unknown, when already exempt (covers off-Android, which
  // resolves `true`), or once dismissed.
  if (exempt === null || exempt || dismissed) return null;

  return (
    <View style={styles.wrap}>
      <View
        style={[styles.panel, { backgroundColor: theme.surface, borderColor: theme.textFaint }]}
        testID="battery-opt"
      >
        <Pressable
          onPress={() => dismiss(CARD_ID)}
          hitSlop={10}
          style={styles.dismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          testID="battery-opt-dismiss"
        >
          <Text
            style={{ color: theme.textMute, fontFamily: font.medium, fontSize: 16, lineHeight: 16 }}
          >
            ×
          </Text>
        </Pressable>

        <Text style={[styles.head, { color: theme.text, fontSize: type.body.size }]}>
          Notifications arriving late?
        </Text>
        <Text style={[styles.supp, { color: theme.textMute, fontSize: type.caption.size }]}>
          Android can delay messages until you open the app. Mark Speakeasy as unrestricted in
          battery settings so they reach you on time.
        </Text>

        <Pressable
          onPress={() => {
            void requestDisableBatteryOptimization();
          }}
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: pressed ? theme.accentPressed : theme.accent },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Open battery settings"
          testID="battery-opt-allow"
        >
          <Text style={[styles.primaryLabel, { color: theme.accentFg, fontSize: type.body.size }]}>
            Open battery settings
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingVertical: space.s },
  panel: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: space.base,
    gap: space.m,
  },
  dismiss: {
    position: 'absolute',
    top: space.s,
    right: space.s,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  head: {
    fontFamily: font.semibold,
    letterSpacing: type.title.letterSpacingEm * type.body.size,
  },
  supp: { fontFamily: font.regular, marginTop: -space.s, lineHeight: 18 },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.s,
    paddingVertical: space.m,
  },
  primaryLabel: { fontFamily: font.semibold },
});
