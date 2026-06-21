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
  // FindSomeoneSheet.handleResultTap calls onPickPeer() and THEN onClose().
  // Here every callback is a `navigation.replace(...)` (this sheet IS the
  // screen, not an overlay), so the trailing onClose → replace('Home')
  // clobbers the onPickPeer → replace('Chat') and the user lands back on an
  // empty Home instead of the chat they tapped. Latch on the first
  // navigating action so the trailing onClose becomes a no-op. (Bug surfaced
  // running the iOS deep-link/QR add flow on the simulator, 2026-06.)
  const navigatedRef = React.useRef(false);
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
      <FindSomeoneSheet
        visible
        initialHandle={handle}
        onClose={() => {
          if (navigatedRef.current) return;
          onClose();
        }}
        onPickPeer={(picked) => {
          navigatedRef.current = true;
          onOpenChat(picked);
        }}
        onCreateRoom={() => {
          navigatedRef.current = true;
          onCreateRoom();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
