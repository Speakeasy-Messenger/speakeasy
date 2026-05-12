/**
 * Minimal react-native stub for vitest.
 * The real package uses native modules + Flow types that Rollup can't parse.
 * Only the APIs used by modules under test are stubbed here.
 */
export const Platform = { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default };
export const NativeModules = {};
export const useEffect = () => {};
export const useRef = <T>(initial?: T) => ({ current: initial ?? null });
export const useState = <T>(initial: T) => [initial, () => {}];
