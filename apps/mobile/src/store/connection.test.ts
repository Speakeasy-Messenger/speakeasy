import { beforeEach, describe, expect, it } from 'vitest';
import { useConnection } from './connection.js';

beforeEach(() => {
  useConnection.setState({ state: 'idle', lastError: undefined });
});

describe('useConnection', () => {
  it('starts idle with no error', () => {
    const s = useConnection.getState();
    expect(s.state).toBe('idle');
    expect(s.lastError).toBeUndefined();
  });

  it('records state transitions', () => {
    useConnection.getState().setState('connecting');
    expect(useConnection.getState().state).toBe('connecting');
    useConnection.getState().setState('authed');
    expect(useConnection.getState().state).toBe('authed');
  });

  it('records errors', () => {
    useConnection.getState().setError('boom');
    expect(useConnection.getState().lastError).toBe('boom');
  });
});
