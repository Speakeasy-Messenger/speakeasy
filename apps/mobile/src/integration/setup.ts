/**
 * vitest setup for mobile tests — approximates the Hermes runtime.
 *
 * Right now: just deletes Buffer. (The AsyncStorage mock moved into
 * each integration test file so individual unit tests don't pay the
 * cost of an unused mock when they don't use AsyncStorage.)
 */

// @ts-expect-error runtime-only deletion of a Node builtin.
delete globalThis.Buffer;
