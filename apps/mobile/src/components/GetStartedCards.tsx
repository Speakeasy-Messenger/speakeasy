import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { font, radius, space, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { useOnboardingCards } from '../store/onboarding-cards.js';

/**
 * "Get started" prompt for the sparse-conversations empty state.
 *
 * One calm panel, not a row of competing cards: a headline, a lead
 * brass action (New chat), and two quieter secondary actions (New
 * group, Share handle). A single dismiss collapses the whole prompt.
 *
 * The parent (ConversationsScreen) decides when to show it (currently:
 * <5 conversations + the prompt not yet dismissed).
 *
 * Dismissal persists via `useOnboardingCards`. The store is still
 * keyed by the three legacy card ids — dismissing the panel marks all
 * three, so `ConversationsScreen`'s "every card dismissed" FAB-lift
 * check (which reads `GET_STARTED_CARD_IDS`) keeps working unchanged.
 */

interface Props {
  onShareHandle: () => void;
  onNewGroup: () => void;
  onNewChat: () => void;
}

/**
 * Legacy onboarding-card ids. The prompt is now a single unit, but the
 * persisted dismissal store and `ConversationsScreen`'s all-dismissed
 * check still address these three — kept for store compatibility.
 */
export const GET_STARTED_CARD_IDS: readonly string[] = [
  'newChat',
  'newGroup',
  'invite',
];

export function GetStartedCards(props: Props): React.JSX.Element | null {
  const dismissed = useOnboardingCards((s) => s.dismissed);
  const dismiss = useOnboardingCards((s) => s.dismiss);
  const theme = useTheme();

  // Visible until the prompt has been dismissed. A fresh install has
  // no ids dismissed; one dismiss tap marks all three.
  if (GET_STARTED_CARD_IDS.every((id) => dismissed[id])) return null;

  const dismissAll = () => GET_STARTED_CARD_IDS.forEach((id) => dismiss(id));

  return (
    <View style={styles.wrap}>
      <View
        style={[
          styles.panel,
          { backgroundColor: theme.surface, borderColor: theme.textFaint },
        ]}
        testID="get-started"
      >
        <Pressable
          onPress={dismissAll}
          hitSlop={10}
          style={styles.dismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss get started"
          testID="get-started-dismiss"
        >
          <Text
            style={{
              color: theme.textMute,
              fontFamily: font.medium,
              fontSize: 16,
              lineHeight: 16,
            }}
          >
            ×
          </Text>
        </Pressable>

        <Text
          style={[
            styles.head,
            { color: theme.text, fontSize: type.title.size },
          ]}
        >
          Start a conversation
          <Text style={{ color: theme.accent }}>.</Text>
        </Text>
        <Text
          style={[
            styles.supp,
            { color: theme.textMute, fontSize: type.caption.size },
          ]}
        >
          Speakeasy stays quiet until you reach someone.
        </Text>

        {/* Lead action — brass fill, ink foreground (mode-invariant). */}
        <Pressable
          onPress={props.onNewChat}
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: pressed ? theme.accentPressed : theme.accent },
          ]}
          accessibilityRole="button"
          accessibilityLabel="New chat"
          testID="get-started-new-chat"
        >
          <CardIcon name="plus" color={theme.accentFg} size={18} />
          <Text
            style={[
              styles.primaryLabel,
              { color: theme.accentFg, fontSize: type.body.size },
            ]}
          >
            New chat
          </Text>
        </Pressable>

        {/* Secondary actions — quieter bordered pair. */}
        <View style={styles.secondary}>
          <SecondaryLink
            label="New group"
            icon="group"
            onPress={props.onNewGroup}
            testID="get-started-new-group"
            theme={theme}
          />
          <SecondaryLink
            label="Share handle"
            icon="mail"
            onPress={props.onShareHandle}
            testID="get-started-share-handle"
            theme={theme}
          />
        </View>
      </View>
    </View>
  );
}

function SecondaryLink({
  label,
  icon,
  onPress,
  testID,
  theme,
}: {
  label: string;
  icon: 'group' | 'mail';
  onPress: () => void;
  testID: string;
  theme: ReturnType<typeof useTheme>;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.link,
        {
          borderColor: theme.textFaint,
          backgroundColor: pressed ? theme.surfacePressed : 'transparent',
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <CardIcon name={icon} color={theme.accent} size={16} />
      <Text
        style={[
          styles.linkLabel,
          { color: theme.text, fontSize: type.handle.size },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function CardIcon({
  name,
  color,
  size,
}: {
  name: 'mail' | 'group' | 'plus';
  color: string;
  size: number;
}): React.JSX.Element {
  const sw = 1.5;
  const cap = 'square' as const;
  const join = 'miter' as const;
  if (name === 'mail') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M3 6 H21 V18 H3 Z" stroke={color} strokeWidth={sw} strokeLinecap={cap} strokeLinejoin={join} />
        <Path d="M3 6 L12 13 L21 6" stroke={color} strokeWidth={sw} strokeLinecap={cap} strokeLinejoin={join} />
      </Svg>
    );
  }
  if (name === 'group') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke={color} strokeWidth={sw} strokeLinecap={cap} strokeLinejoin={join} />
        <Path d="M3 19c0-3 3-5 6-5s6 2 6 5" stroke={color} strokeWidth={sw} strokeLinecap={cap} strokeLinejoin={join} />
        <Path d="M16 11a3 3 0 1 0 0-6" stroke={color} strokeWidth={sw} strokeLinecap={cap} strokeLinejoin={join} />
        <Path d="M16 14c2 0 5 2 5 5" stroke={color} strokeWidth={sw} strokeLinecap={cap} strokeLinejoin={join} />
      </Svg>
    );
  }
  // plus
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line x1={12} y1={5} x2={12} y2={19} stroke={color} strokeWidth={sw} strokeLinecap={cap} />
      <Line x1={5} y1={12} x2={19} y2={12} stroke={color} strokeWidth={sw} strokeLinecap={cap} />
    </Svg>
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
    letterSpacing: type.title.letterSpacingEm * type.title.size,
  },
  // Negative marginTop pulls the supporting line up against the
  // headline — the panel `gap` is right for action spacing but too
  // loose for a headline + its own sub-line.
  supp: { fontFamily: font.regular, marginTop: -space.s, lineHeight: 18 },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.s,
    paddingVertical: space.m,
  },
  primaryLabel: { fontFamily: font.semibold },
  secondary: { flexDirection: 'row', gap: space.s },
  link: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.s,
    borderWidth: 1,
    paddingVertical: space.m,
  },
  linkLabel: { fontFamily: font.medium },
});
