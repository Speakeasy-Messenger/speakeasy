import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Contacts from 'react-native-contacts';
import QRCode from 'react-native-qrcode-svg';
import { colors, fonts, radius, space, text } from '../theme/index.js';
import { useIdentity } from '../store/identity.js';
import { encodeAdd } from '../utils/handle-link.js';

interface Props {
  onBack: () => void;
}

interface ContactRow {
  id: string;
  displayName: string;
  /** Best phone or email; used for sort affordance only. */
  detail?: string;
}

/**
 * Invite a friend via the OS share sheet. The list of contacts is
 * cosmetic — tapping a row fires `Share.share()` with prefilled text
 * including the user's @handle, and the OS share sheet picks the
 * recipient + transport (Messages / WhatsApp / Mail / etc.). Contact
 * data NEVER leaves the device — this screen does no server-side
 * lookup or hashing (that's the Signal-style discovery v2 conversation
 * we deferred).
 *
 * If the user denies READ_CONTACTS, we fall back to a single "Share my
 * handle" button that fires the share sheet without the picker — the
 * recipient is chosen on the OS side anyway, so the flow still works.
 */
export function InviteFriendsScreen({ onBack }: Props) {
  const myUserId = useIdentity((s) => s.userId);
  const [permission, setPermission] = useState<'pending' | 'granted' | 'denied'>('pending');
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const readContactsPerm = PermissionsAndroid.PERMISSIONS.READ_CONTACTS;
        const granted =
          Platform.OS === 'android' && readContactsPerm
            ? await PermissionsAndroid.request(readContactsPerm, {
                title: 'Find friends from your contacts',
                message:
                  'Speakeasy never sends your contacts to a server. We just show them here so you can pick who to invite.',
                buttonPositive: 'OK',
                buttonNegative: 'Cancel',
              })
            : PermissionsAndroid.RESULTS.GRANTED;
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          setPermission('denied');
          return;
        }
        const all = await Contacts.getAll();
        const rows: ContactRow[] = all
          .map((c) => {
            const name =
              c.displayName ||
              [c.givenName, c.familyName].filter(Boolean).join(' ').trim() ||
              c.phoneNumbers[0]?.number ||
              '';
            const detail =
              c.phoneNumbers[0]?.number || c.emailAddresses[0]?.email || undefined;
            return { id: c.recordID, displayName: name, detail };
          })
          .filter((r) => r.displayName.length > 0)
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        setContacts(rows);
        setPermission('granted');
      } catch (err) {
        setPermission('denied');
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.detail?.toLowerCase().includes(q),
    );
  }, [contacts, filter]);

  async function shareInvite(prefix?: string) {
    if (!myUserId) {
      Alert.alert('Not enrolled.');
      return;
    }
    const greeting = prefix ? `Hey ${prefix}, ` : '';
    // GitHub's `/releases/latest` redirect always points at the
    // latest tagged release. Including it in the share message gives
    // the recipient a direct download path. (TinyURL wrapping is a
    // future nice-to-have — the URL is short enough that SMS
    // 160-char limit isn't a concern for the typical greeting.)
    const downloadUrl =
      'https://github.com/Speakeasy-Messenger/speakeasy/releases/latest';
    const message =
      `${greeting}join me on Speakeasy: my handle is @${myUserId}.\n` +
      `Download: ${downloadUrl}`;
    try {
      await Share.share({ message });
    } catch (err) {
      // Most "errors" here are just the user dismissing the sheet.
    }
  }

  // QR encodes `speakeasy://add?handle=<myUserId>`. Phone-camera apps
  // on both iOS and Android detect URLs in QR codes and offer to open
  // them — that hands off to Speakeasy's deep-link intent (Android)
  // / URL scheme (iOS), which routes the recipient to NewChat with
  // the handle prefilled.
  const qrUrl = myUserId ? encodeAdd(myUserId) : undefined;

  function MyQrCard(): React.JSX.Element | null {
    if (!myUserId) return null;
    return (
      <View style={styles.qrCard} testID="invite-qr-card">
        <Text style={[text.sectionLabel, styles.qrLabel]}>SCAN TO ADD ME</Text>
        <View style={styles.qrFrame}>
          {qrUrl ? (
            <QRCode
              value={qrUrl}
              size={180}
              color={colors.ink}
              backgroundColor={colors.cream}
            />
          ) : null}
        </View>
        <Text style={styles.qrHandle} testID="invite-qr-handle">
          @{myUserId}
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={text.heroBody}>Invite friends</Text>
      </View>

      <MyQrCard />

      {permission === 'pending' ? (
        <View style={styles.center}>
          <Text style={styles.muted}>Looking up your contacts…</Text>
        </View>
      ) : permission === 'denied' ? (
        <View style={styles.center}>
          <Text style={[text.subtitle, styles.mutedTitle]}>
            Contacts permission denied.
          </Text>
          <Text style={styles.muted}>
            That's fine — tap below to share your @{myUserId} via your usual
            messaging app instead.
          </Text>
          <Pressable
            onPress={() => void shareInvite()}
            style={styles.primaryBtn}
            testID="invite-share-no-contacts"
          >
            <Text style={styles.primaryBtnText}>Share my handle</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.searchWrap}>
            <TextInput
              value={filter}
              onChangeText={setFilter}
              placeholder="Search contacts"
              placeholderTextColor={colors.slate}
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.search}
            />
          </View>
          <FlatList
            data={filtered}
            keyExtractor={(c) => c.id}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <Text style={[text.subtitle, styles.mutedCenter]}>
                No contacts match.
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => void shareInvite(item.displayName)}
                style={styles.row}
                testID={`invite-row-${item.id}`}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {item.displayName.slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {item.displayName}
                  </Text>
                  {item.detail ? (
                    <Text style={styles.rowDetail} numberOfLines={1}>
                      {item.detail}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.invite}>Invite</Text>
              </Pressable>
            )}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    paddingBottom: space.sm,
  },
  backBtn: { padding: space.xs },
  backText: { fontFamily: fonts.inter500, fontSize: 15, color: colors.primary },

  qrCard: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    marginHorizontal: space.lg,
    marginTop: space.xs,
    marginBottom: space.md,
    backgroundColor: colors.pale,
    borderRadius: radius.avatar,
  },
  qrLabel: {
    color: colors.slate,
    letterSpacing: 2,
  },
  qrFrame: {
    padding: space.md,
    backgroundColor: colors.cream,
    borderRadius: 8,
  },
  qrHandle: {
    color: colors.ink,
    fontFamily: fonts.inter500,
    fontSize: 16,
    letterSpacing: 0.4,
  },

  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
    gap: space.md,
  },
  muted: {
    color: colors.slate,
    fontFamily: fonts.inter400,
    fontSize: 14,
    textAlign: 'center',
  },
  mutedTitle: { color: colors.ink, fontFamily: fonts.inter500 },
  mutedCenter: { color: colors.slate, textAlign: 'center', paddingTop: space.lg },

  searchWrap: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  search: {
    paddingHorizontal: space.md,
    paddingVertical: 12,
    backgroundColor: colors.pale,
    borderRadius: radius.pill,
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 14,
  },

  listContent: { paddingHorizontal: space.lg, paddingBottom: space.xxl },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: colors.pale,
    borderRadius: radius.avatar,
    marginBottom: space.xs,
  },
  // Avatars are 4-radius squares per the rebrand spec (was circles).
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.avatar,
    backgroundColor: colors.soft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontFamily: fonts.inter500, color: colors.primary, fontSize: 15 },
  rowBody: { flex: 1 },
  rowName: { fontFamily: fonts.inter500, color: colors.ink, fontSize: 15 },
  rowDetail: { fontFamily: fonts.inter400, color: colors.slate, fontSize: 12 },
  invite: { fontFamily: fonts.inter500, color: colors.primary, fontSize: 13 },

  primaryBtn: {
    paddingVertical: 14,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  primaryBtnText: { color: colors.cream, fontFamily: fonts.inter500, fontSize: 15 },
});
