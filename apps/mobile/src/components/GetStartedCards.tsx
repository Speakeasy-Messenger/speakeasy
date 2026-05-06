import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { font, radius, space, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { useOnboardingCards } from '../store/onboarding-cards.js';

/**
 * Horizontal "Get started" card row for the sparse-conversations
 * empty state. Renders three actionable cards: invite friends,
 * start a group, start a 1:1. Each card has an X dismiss; dismissals
 * persist via `useOnboardingCards`. The parent (ConversationsScreen)
 * decides when to show the row (currently: <5 conversations + at
 * least one un-dismissed card).
 */

interface Props {
  onInviteFriends: () => void;
  onNewGroup: () => void;
  onNewChat: () => void;
}

interface CardSpec {
  id: 'invite' | 'newGroup' | 'newChat';
  title: string;
  subtitle: string;
  icon: 'mail' | 'group' | 'plus';
  onPress: (props: Props) => void;
}

const CARDS: readonly CardSpec[] = [
  {
    id: 'newChat',
    title: 'New chat',
    subtitle: 'Message a peer by handle',
    icon: 'plus',
    onPress: (p) => p.onNewChat(),
  },
  {
    id: 'newGroup',
    title: 'New group',
    subtitle: 'Up to 100 people',
    icon: 'group',
    onPress: (p) => p.onNewGroup(),
  },
  {
    id: 'invite',
    title: 'Invite friends',
    subtitle: 'Share your @handle',
    icon: 'mail',
    onPress: (p) => p.onInviteFriends(),
  },
] as const;

export function GetStartedCards(props: Props): React.JSX.Element | null {
  const dismissed = useOnboardingCards((s) => s.dismissed);
  const dismiss = useOnboardingCards((s) => s.dismiss);
  const theme = useTheme();

  const visible = CARDS.filter((c) => !dismissed[c.id]);
  if (visible.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text
        style={[
          styles.label,
          {
            color: theme.textMute,
            fontFamily: font.medium,
            fontSize: type.meta.size,
            letterSpacing: type.meta.letterSpacingEm * type.meta.size,
          },
        ]}
      >
        GET STARTED
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {visible.map((card) => (
          <Pressable
            key={card.id}
            onPress={() => card.onPress(props)}
            style={[
              styles.card,
              { backgroundColor: theme.surface, borderColor: theme.textFaint },
            ]}
            testID={`get-started-${card.id}`}
          >
            <Pressable
              onPress={() => dismiss(card.id)}
              hitSlop={8}
              style={styles.dismiss}
              testID={`get-started-${card.id}-dismiss`}
            >
              <Text
                style={{
                  color: theme.textMute,
                  fontFamily: font.medium,
                  fontSize: 14,
                  lineHeight: 14,
                }}
              >
                ×
              </Text>
            </Pressable>
            <View style={styles.iconWrap}>
              <CardIcon name={card.icon} color={theme.accent} />
            </View>
            <Text
              style={{
                color: theme.text,
                fontFamily: font.semibold,
                fontSize: type.body.size,
              }}
              numberOfLines={1}
            >
              {card.title}
            </Text>
            <Text
              style={{
                color: theme.textMute,
                fontFamily: font.regular,
                fontSize: type.caption.size,
              }}
              numberOfLines={2}
            >
              {card.subtitle}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function CardIcon({
  name,
  color,
}: {
  name: 'mail' | 'group' | 'plus';
  color: string;
}): React.JSX.Element {
  const stroke = color;
  const sw = 1.5;
  const cap = 'square' as const;
  const join = 'miter' as const;
  if (name === 'mail') {
    return (
      <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
        <Path
          d="M3 6 H21 V18 H3 Z"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap={cap}
          strokeLinejoin={join}
        />
        <Path
          d="M3 6 L12 13 L21 6"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap={cap}
          strokeLinejoin={join}
        />
      </Svg>
    );
  }
  if (name === 'group') {
    return (
      <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
        <Path
          d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap={cap}
          strokeLinejoin={join}
        />
        <Path
          d="M3 19c0-3 3-5 6-5s6 2 6 5"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap={cap}
          strokeLinejoin={join}
        />
        <Path
          d="M16 11a3 3 0 1 0 0-6"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap={cap}
          strokeLinejoin={join}
        />
        <Path
          d="M16 14c2 0 5 2 5 5"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap={cap}
          strokeLinejoin={join}
        />
      </Svg>
    );
  }
  // plus
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Line
        x1={12}
        y1={5}
        x2={12}
        y2={19}
        stroke={stroke}
        strokeWidth={sw}
        strokeLinecap={cap}
      />
      <Line
        x1={5}
        y1={12}
        x2={19}
        y2={12}
        stroke={stroke}
        strokeWidth={sw}
        strokeLinecap={cap}
      />
    </Svg>
  );
}

// Compact dimensions — this panel sticks to the bottom of the
// conversations list so it can't crowd the chat rows.
const CARD_W = 132;

const styles = StyleSheet.create({
  wrap: { paddingTop: space.xs, paddingBottom: space.s, gap: 4 },
  label: {
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
  },
  row: {
    paddingHorizontal: space.lg,
    gap: space.xs,
  },
  card: {
    width: CARD_W,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingVertical: space.s,
    paddingHorizontal: space.m,
    gap: 2,
    position: 'relative',
  },
  dismiss: {
    position: 'absolute',
    top: 4,
    right: 6,
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrap: { marginBottom: 2 },
});
