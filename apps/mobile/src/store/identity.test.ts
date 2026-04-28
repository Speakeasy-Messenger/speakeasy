import { beforeEach, describe, expect, it } from 'vitest';
import { isEnrolled, useIdentity } from './identity.js';

beforeEach(() => useIdentity.getState().reset());

describe('useIdentity', () => {
  it('starts with no userId', () => {
    expect(useIdentity.getState().userId).toBeUndefined();
    expect(isEnrolled(useIdentity.getState())).toBe(false);
  });

  it('setUserId flips to enrolled', () => {
    useIdentity.getState().setUserId('silent-golden-hawk');
    expect(useIdentity.getState().userId).toBe('silent-golden-hawk');
    expect(isEnrolled(useIdentity.getState())).toBe(true);
  });

  it('reset clears userId', () => {
    useIdentity.getState().setUserId('a-b-c');
    useIdentity.getState().reset();
    expect(useIdentity.getState().userId).toBeUndefined();
  });
});
