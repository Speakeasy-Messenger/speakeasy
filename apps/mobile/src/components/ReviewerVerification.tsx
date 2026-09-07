import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { font, space, type as typeScale } from '../theme/tokens.js';

export const UNSUPPORTED_DEVICE_MESSAGE =
  "This device can't be verified. Speakeasy needs a device with a screen lock and secure hardware.";

interface Props {
  onSubmit: (args: { code: string }) => Promise<void>;
  colors: { text: string; muted: string; faint: string };
  renderButton: (button: {
    label: string;
    onPress: () => void;
    disabled: boolean;
    loading: boolean;
    testID: string;
  }) => React.ReactNode;
  testIDPrefix: string;
  onBusyChange?: (busy: boolean) => void;
}

/** Shared unsupported-device state. Reviewer access is an explicit secondary action. */
export function ReviewerVerification({
  onSubmit,
  colors,
  renderButton,
  testIDPrefix,
  onBusyChange,
}: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string>();

  async function submit() {
    if (inFlight.current || !/^[0-9a-f]{32}$/.test(code)) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(undefined);
    try {
      await onSubmit({ code });
    } catch {
      setError("That code didn't work. Check it and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <View style={styles.block}>
      <Text style={[styles.help, { color: colors.text }]} testID={`${testIDPrefix}-unsupported`}>
        {UNSUPPORTED_DEVICE_MESSAGE}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(true)}
        testID={`${testIDPrefix}-reviewer`}
      >
        <Text style={[styles.help, { color: colors.muted }]}>
          Reviewing this app? Enter a verification code.
        </Text>
      </Pressable>
      {expanded ? (
        <>
          <TextInput
            value={code}
            onChangeText={(value) => setCode(value.trim().toLowerCase().slice(0, 32))}
            placeholder="Verification code"
            accessibilityLabel="Reviewer verification code"
            keyboardType="ascii-capable"
            maxLength={32}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            placeholderTextColor={colors.faint}
            style={[styles.input, { color: colors.text, borderColor: colors.faint }]}
            testID={`${testIDPrefix}-code`}
          />
          {error ? (
            <Text
              style={[styles.error, { color: colors.text }]}
              accessibilityRole="alert"
              testID={`${testIDPrefix}-error`}
            >
              {error}
            </Text>
          ) : null}
          {renderButton({
            label: 'Verify code',
            onPress: () => void submit(),
            disabled: busy || !/^[0-9a-f]{32}$/.test(code),
            loading: busy,
            testID: `${testIDPrefix}-verify`,
          })}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.s },
  help: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    lineHeight: 1.5 * typeScale.caption.size,
  },
  input: {
    fontFamily: font.regular,
    fontSize: 18,
    borderBottomWidth: 1,
    paddingVertical: space.s,
    padding: 0,
  },
  error: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
  },
});
