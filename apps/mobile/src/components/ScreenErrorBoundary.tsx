import React from 'react';
import { Pressable, Text, View } from 'react-native';

/**
 * App-level error boundary wrapping the whole screen tree (just inside
 * `NavigationContainer`, around `Stack.Navigator`). Without it, a runtime
 * throw during ANY screen's render — an unexpected store shape, a
 * malformed message/attachment, a null deref in a list row — propagates
 * to the React root and, in a release build (no RedBox), takes the entire
 * app down to a native crash. The only other boundary in the app is
 * `AvatarErrorBoundary`, scoped to a single avatar; this is its
 * screen-level counterpart (production-audit finding, rc.84).
 *
 * On error: render a self-contained recoverable fallback (hard-coded
 * colors + no theme/context/store reads, so it can't fail for the same
 * reason the tree did) with a "Try again" action that remounts the
 * navigator from its initial route, and persist a one-line marker via
 * diag (best-effort) so the failure shows up in Diagnostics.
 */

// Brand palette, inlined deliberately — the fallback must not depend on
// the theme provider, which may be part of what failed.
const INK = '#14091A';
const BONE = '#F2E9D8';
const BRASS = '#E5A645';

interface Props {
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

export class ScreenErrorBoundary extends React.Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(err: Error): void {
    // Lazy import so diag isn't pulled into the boundary's mount path
    // until we actually fail.
    void import('../diag/log.js')
      .then(({ diag }) => {
        diag('app', 'screen boundary caught', {
          err: err.message ?? String(err),
        });
      })
      .catch(() => {
        /* swallow — diag logging is best-effort here */
      });
  }

  private handleReset = (): void => {
    // Clearing `failed` remounts the children — the navigator comes back
    // at its initial route for the current auth state. Recovers cleanly
    // from a transient throw; a persistent one simply re-shows this
    // fallback rather than leaving a dead app.
    this.setState({ failed: false });
  };

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: INK,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
        }}
        testID="screen-error-boundary"
      >
        <Text
          style={{
            color: BONE,
            fontSize: 18,
            fontWeight: '700',
            textAlign: 'center',
            marginBottom: 10,
          }}
        >
          Something went wrong
        </Text>
        <Text
          style={{
            color: BONE,
            opacity: 0.7,
            fontSize: 14,
            lineHeight: 20,
            textAlign: 'center',
            marginBottom: 28,
          }}
        >
          The app hit an unexpected error. Your messages and identity are
          safe on this device.
        </Text>
        <Pressable
          onPress={this.handleReset}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          style={{
            backgroundColor: BRASS,
            paddingVertical: 14,
            paddingHorizontal: 40,
            borderRadius: 12,
          }}
          testID="screen-error-retry"
        >
          <Text style={{ color: INK, fontSize: 15, fontWeight: '700' }}>
            Try again
          </Text>
        </Pressable>
      </View>
    );
  }
}
