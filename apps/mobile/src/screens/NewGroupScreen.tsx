import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { isUserId } from '@speakeasy/shared';
import { useGroups } from '../store/groups.js';
import { useIdentity } from '../store/identity.js';
import { api } from '../services.js';
import { ApiError } from '../api/client.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';

interface Props {
  /** Called after createGroup + member adds succeed. */
  onCreated: (groupId: string) => void;
  onCancel: () => void;
}

/**
 * Phase 5e — minimal group create flow:
 *   1. Pick a name.
 *   2. Paste peer ids (one per line, or hyphen-separated word triplets
 *      delimited by whitespace / commas — the formatter normalises).
 *   3. Tap "Create" → server mints a group id, we add each peer one at
 *      a time, register the group locally, and navigate into it.
 *
 * Discovery / contact picker is deferred (spec §13). For now you exchange
 * peer ids out of band and paste them here.
 */
export function NewGroupScreen({ onCreated, onCancel }: Props) {
  const myUserId = useIdentity((s) => s.userId);
  const upsertGroup = useGroups((s) => s.upsert);
  const [name, setName] = useState('');
  const [membersInput, setMembersInput] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function parseMembers(raw: string): string[] {
    // Lowercase + canonicalise hyphens; split on any whitespace, comma,
    // or semicolon; drop self; dedupe.
    const tokens = raw
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .split(/[,\s;]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tokens) {
      if (t === myUserId) continue;
      if (!isUserId(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  async function handleCreate() {
    if (!myUserId) {
      setError('Not enrolled.');
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Give the group a name.');
      return;
    }
    const members = parseMembers(membersInput);
    if (members.length === 0) {
      setError('Add at least one member by their three-word ID.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const deviceToken = useIdentity.getState().deviceToken;
      if (!deviceToken) {
        setError('Sign in again — device token missing.');
        return;
      }
      const { group_id } = await api.createGroup(deviceToken);
      // Add members serially. Phase 5e doesn't model partial-failure UI;
      // any individual failure aborts (the group exists server-side
      // with whatever members we managed to add before the failure).
      for (const member of members) {
        await api.addGroupMember(deviceToken, group_id, member);
      }
      upsertGroup({
        id: group_id,
        name: trimmedName,
        members: [myUserId, ...members],
        createdAt: Date.now(),
      });
      onCreated(group_id);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(`Server rejected: ${err.code ?? err.status}`);
      } else {
        const e = err as { message?: string };
        setError(e.message ?? 'Group creation failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  const parsedMembers = parseMembers(membersInput);

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={12}>
            <Text style={[text.subtitle, styles.cancel]}>‹ Back</Text>
          </Pressable>
          <Text style={[text.heroBody, styles.title]}>NEW GROUP</Text>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={[text.subtitle, styles.label]}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={(s) => {
              setName(s);
              if (error) setError(undefined);
            }}
            placeholder="weekend plans"
            placeholderTextColor={colors.slate}
            autoCorrect={false}
            maxLength={64}
            returnKeyType="next"
          />

          <Text style={[text.subtitle, styles.label, styles.labelGap]}>Members</Text>
          <Text style={[text.footnote, styles.hint]}>
            One ID per line. Format: word-word-word.
          </Text>
          <TextInput
            style={[styles.input, styles.textarea]}
            value={membersInput}
            onChangeText={(s) => {
              setMembersInput(s);
              if (error) setError(undefined);
            }}
            placeholder={'silent-golden-hawk\nplanetary-timid-mire'}
            placeholderTextColor={colors.slate}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />

          {parsedMembers.length > 0 && (
            <Text style={[text.footnote, styles.parsedNote]}>
              {parsedMembers.length} member{parsedMembers.length === 1 ? '' : 's'} parsed
            </Text>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.bottom}>
          <Pressable
            onPress={handleCreate}
            style={[styles.startBtn, busy && styles.startBtnDisabled]}
            disabled={busy}
          >
            <Text style={styles.startBtnText}>{busy ? 'Creating…' : 'Create group'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  body: { flex: 1, padding: space.lg },
  header: { gap: space.md, marginBottom: space.lg },
  cancel: { color: colors.primary, fontFamily: fonts.inter500 },
  title: { color: colors.ink, fontFamily: fonts.inter500, letterSpacing: 1.2 },
  content: { gap: space.sm, paddingBottom: space.xl },
  label: { color: colors.ink, fontFamily: fonts.inter500 },
  labelGap: { marginTop: space.lg },
  hint: { color: colors.slate },
  input: {
    minHeight: 48,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: colors.pale,
    borderRadius: radius.pill,
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 16,
  },
  textarea: {
    minHeight: 120,
    borderRadius: radius.bubble,
    textAlignVertical: 'top',
  },
  parsedNote: { color: colors.primary, fontFamily: fonts.inter400 },
  error: {
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 12,
    marginTop: space.xs,
  },
  bottom: { gap: space.sm },
  startBtn: {
    paddingVertical: 14,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  startBtnDisabled: { opacity: 0.6 },
  startBtnText: {
    color: colors.cream,
    fontFamily: fonts.inter500,
    fontSize: 16,
  },
});
