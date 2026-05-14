/**
 * Minimal react-native stub for vitest.
 * The real package uses native modules + Flow types that Rollup can't parse.
 * Only the APIs used by modules under test are stubbed here.
 */
export const Platform = { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default };
export const NativeModules = {
  // SpeakeasyVersion: the rc.82 native bridge. Tests that import
  // ../version get deterministic values — no hardcoded constants
  // sneak back into source via tests pinning the wrong number.
  SpeakeasyVersion: {
    versionName: '0.0.0-test',
    versionCode: 0,
  },
};
export const useEffect = () => {};
export const useRef = <T>(initial?: T) => ({ current: initial ?? null });
export const useState = <T>(initial: T) => [initial, () => {}];
export const Alert = { alert: () => {} };
