import { useEffect, useState } from 'react';
import { AccessibilityInfo, type EmitterSubscription } from 'react-native';

/**
 * Phase 5j Private Call — observe the OS-level reduce-motion
 * accessibility setting (iOS Settings → Accessibility → Motion →
 * Reduce Motion; Android System → Accessibility → Remove animations).
 * Returns a boolean that flips live as the user toggles the setting
 * — no app restart needed.
 *
 * Locked behavior per /plan-design-review D12 (soft honor):
 *  - Mouth amplitude animation: still works (core "avatar is
 *    speaking" signal; the feature must function for these users).
 *  - Blink + eyeScale state changes: still apply, but instantaneous
 *    (no eased interpolation between emotion states).
 *  - BrandPulse: static brass mark, no pulse.
 *  - SpeechRing + RingingRings: invisible (decorative sweeping
 *    motion that triggers vestibular issues for some users).
 *
 * Used by: CallScreen's BrandPulse/RingingRings/SpeechRing wrappers,
 * any future per-animal Render that animates `eyeScale` over time.
 *
 * Defensive: AccessibilityInfo is a native module; in test envs that
 * don't mock it (vitest unit tests typically), the initial fetch
 * throws or resolves false. We default to `false` and swallow init
 * errors so the hook is safe to call from any component.
 */
export function useReducedMotion(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    let sub: EmitterSubscription | undefined;

    // Initial value — async; the boolean settles within a frame on
    // both platforms.
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setEnabled(value);
      })
      .catch(() => {
        // Native module missing (test envs) — keep the default false.
      });

    // Live updates. AccessibilityInfo.addEventListener returns an
    // EmitterSubscription with a .remove() method; the older RN
    // shape returned undefined, so we guard.
    try {
      sub = AccessibilityInfo.addEventListener(
        'reduceMotionChanged',
        (value) => {
          if (mounted) setEnabled(value);
        },
      );
    } catch {
      // Same defensive posture as above.
    }

    return () => {
      mounted = false;
      sub?.remove();
    };
  }, []);

  return enabled;
}
