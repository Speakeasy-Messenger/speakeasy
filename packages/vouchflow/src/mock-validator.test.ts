import { describe, expect, it } from 'vitest';
import { MockValidator } from './mock-validator.js';

describe('MockValidator', () => {
  it('alwaysSucceeds returns medium-confidence by default for any token', async () => {
    const v = MockValidator.alwaysSucceeds();
    const a = await v.validate('any-token');
    expect(a.confidence).toBe('medium');
    expect(a.deviceToken).toBe('any-token');
  });

  it('alwaysSucceeds with overrides applies them', async () => {
    const v = MockValidator.alwaysSucceeds({ confidence: 'high', userId: 'silent-golden-hawk' });
    const a = await v.validate('t');
    expect(a.confidence).toBe('high');
    expect(a.userId).toBe('silent-golden-hawk');
  });

  it('alwaysFailsWith throws the given reason', async () => {
    const v = MockValidator.alwaysFailsWith('low_confidence');
    await expect(v.validate('x')).rejects.toMatchObject({ reason: 'low_confidence' });
  });

  it('fromMap routes per-token; unmapped tokens fail with device_not_found', async () => {
    const v = MockValidator.fromMap({
      good: { ok: true, attestation: { confidence: 'high' } },
      bad: { ok: false, reason: 'high_risk' },
    });
    expect((await v.validate('good')).confidence).toBe('high');
    await expect(v.validate('bad')).rejects.toMatchObject({ reason: 'high_risk' });
    await expect(v.validate('unknown')).rejects.toMatchObject({ reason: 'device_not_found' });
  });
});
