import React from 'react';
import { View } from 'react-native';

/**
 * Class-component error boundary scoped around `<AnimalSvg>`. A single
 * bad avatar render — e.g. a paid-tier avatar's worklet hook firing
 * before reanimated's runtime is ready, or a per-animal `Render` with
 * a runtime bug — would otherwise crash the whole screen subtree
 * (rc.19 reproducer: `Error:>` thrown out of `AnimalSvg` →
 * `AvatarRenderer` → `PortraitTile` → `ConversationsScreen`,
 * preventing app launch entirely).
 *
 * On error: render a neutral, sized placeholder View so list rows
 * stay laid out, and persist a one-line marker via diag (best-effort)
 * so we can see *which* user/animal id triggered it.
 */
interface Props {
  children: React.ReactNode;
  size: number;
  /** For diag logging — caller passes the animal id or user id so
   * we know which avatar instance failed. */
  label?: string;
}

interface State {
  failed: boolean;
}

export class AvatarErrorBoundary extends React.Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(err: Error): void {
    // Lazy import — avoid pulling diag into the prod boundary's hot
    // path until we actually fail.
    void import('../diag/log.js')
      .then(({ diag }) => {
        diag('avatar', 'render boundary caught', {
          label: this.props.label,
          err: err.message ?? String(err),
        });
      })
      .catch(() => {
        /* swallow — diag logging is best-effort here */
      });
  }

  override render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <View
          style={{
            width: this.props.size,
            height: this.props.size,
          }}
        />
      );
    }
    return this.props.children;
  }
}
