import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text } from 'react-native';
import { AppBar } from '../components/AppBar.js';
import { SettingsListItem } from '../components/SettingsListItem.js';
import { useSettings } from '../store/settings.js';
import { useColors } from '../theme/index.js';
import { type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
}

/** SETTINGS.md §5 — two sections, all toggles. */
export function NotificationsScreen({ onBack }: Props): React.ReactElement {
  const themed = useColors();
  const inAppNotificationsEnabled = useSettings((s) => s.inAppNotificationsEnabled);
  const setInAppNotificationsEnabled = useSettings(
    (s) => s.setInAppNotificationsEnabled,
  );
  const messageSoundEnabled = useSettings((s) => s.messageSoundEnabled);
  const setMessageSoundEnabled = useSettings((s) => s.setMessageSoundEnabled);
  const messageVibrationEnabled = useSettings((s) => s.messageVibrationEnabled);
  const setMessageVibrationEnabled = useSettings(
    (s) => s.setMessageVibrationEnabled,
  );
  const notificationPrivacy = useSettings((s) => s.notificationPrivacy);
  const setNotificationPrivacy = useSettings((s) => s.setNotificationPrivacy);
  const ringtoneEnabled = useSettings((s) => s.ringtoneEnabled);
  const setRingtoneEnabled = useSettings((s) => s.setRingtoneEnabled);
  const vibrateOnIncoming = useSettings((s) => s.vibrateOnIncoming);
  const setVibrateOnIncoming = useSettings((s) => s.setVibrateOnIncoming);

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="notifications-screen"
    >
      <AppBar onBack={onBack} title="Notifications" testID="notifications-appbar" />

      <ScrollView>
        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          MESSAGES
        </Text>
        <SettingsListItem
          kind="toggle"
          title="Sound"
          description="A single brushed cymbal."
          value={messageSoundEnabled}
          onChange={setMessageSoundEnabled}
        />
        <SettingsListItem
          kind="toggle"
          title="Vibration"
          value={messageVibrationEnabled}
          onChange={setMessageVibrationEnabled}
        />
        <SettingsListItem
          kind="toggle"
          title="Banner when in another conversation"
          description="Brief preview, dismisses on tap or after 4 seconds."
          value={inAppNotificationsEnabled}
          onChange={setInAppNotificationsEnabled}
        />
        <SettingsListItem
          kind="toggle"
          title="Show preview text"
          description="When off, you'll see who messaged but not what they said."
          value={notificationPrivacy === 'rich'}
          onChange={(v) => setNotificationPrivacy(v ? 'rich' : 'private')}
        />

        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          CALLS
        </Text>
        <SettingsListItem
          kind="toggle"
          title="Ringtone"
          description="A looping brushed cymbal."
          value={ringtoneEnabled}
          onChange={setRingtoneEnabled}
        />
        <SettingsListItem
          kind="toggle"
          title="Vibrate on incoming"
          value={vibrateOnIncoming}
          onChange={setVibrateOnIncoming}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  sectionLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: 9.5,
    letterSpacing: 0.22 * 9.5,
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 10,
  },
});
