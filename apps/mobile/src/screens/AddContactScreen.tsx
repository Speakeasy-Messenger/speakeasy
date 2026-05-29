import React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FindSomeoneSheet } from '../components/FindSomeoneSheet.js';
import { useColors } from '../theme/index.js';

interface Props {
  handle: string;
  onClose: () => void;
  onOpenChat: (handle: string) => void;
  onCreateRoom: () => void;
}

/**
 * Deep-link landing surface for `speakeasy://add?handle=...`.
 *
 * This deliberately bypasses the conversation list. A scanned QR code
 * is an intent to add or start chatting with that exact handle, so the
 * Find Someone state machine opens immediately with the handle already
 * filled and resolving.
 */
export function AddContactScreen({
  handle,
  onClose,
  onOpenChat,
  onCreateRoom,
}: Props): React.ReactElement {
  const themed = useColors();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
      <FindSomeoneSheet
        visible
        initialHandle={handle}
        onClose={onClose}
        onPickPeer={onOpenChat}
        onCreateRoom={onCreateRoom}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
