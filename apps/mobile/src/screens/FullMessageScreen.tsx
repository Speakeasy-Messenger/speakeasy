import React from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { RichMessageText } from '../components/RichMessageText.js';
import { space, useColors } from '../theme/index.js';
import { font } from '../theme/tokens.js';

interface Props {
  /** The full message text, passed through from the bubble's "See more". */
  text: string;
  onBack: () => void;
}

/**
 * Full-text view for a long message, reached via the "See more"
 * affordance on a truncated chat bubble. Read-only; links stay tappable
 * (RichMessageText with no `onSeeMore`, so it renders the text in full).
 */
export function FullMessageScreen({ text, onBack }: Props): React.ReactElement {
  const themed = useColors();
  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="full-message-screen"
    >
      <View style={[styles.appbar, { borderBottomColor: themed.divider }]}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.back}>
          <Text style={[styles.backText, { color: themed.slate }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: themed.ink }]}>Message</Text>
        <View style={{ width: 32 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <RichMessageText
          text={text}
          style={[styles.body, { color: themed.ink }]}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { width: 32, alignItems: 'flex-start' },
  backText: { fontSize: 28, lineHeight: 28 },
  title: { fontFamily: font.medium, fontSize: 17 },
  content: { padding: space.lg },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 24 },
});
