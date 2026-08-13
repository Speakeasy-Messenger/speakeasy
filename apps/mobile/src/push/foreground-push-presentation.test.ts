import { describe, expect, it, vi } from 'vitest';
import {
  presentForegroundPushBeforeUi,
  routeForegroundPush,
  shouldDisplayForegroundPushAsSystem,
} from './foreground-push-presentation.js';

const coldLaunch = {
  platform: 'android',
  uiReady: false,
  conversationId: 'dm-abc',
  notifyKind: 'message',
};

describe('foreground push presentation', () => {
  it('uses a system notification for a complete Android push before UI readiness', () => {
    expect(shouldDisplayForegroundPushAsSystem(coldLaunch)).toBe(true);
  });

  it.each([
    [{ ...coldLaunch, platform: 'ios' }, 'iOS'],
    [{ ...coldLaunch, uiReady: true }, 'ready Android UI'],
    [{ ...coldLaunch, conversationId: undefined }, 'missing conversation'],
    [{ ...coldLaunch, notifyKind: undefined }, 'missing notification kind'],
  ])('keeps $1 on the normal foreground path', (input, _label) => {
    expect(shouldDisplayForegroundPushAsSystem(input)).toBe(false);
  });

  it('displays then immediately drains the durable inbox', async () => {
    const order: string[] = [];
    const displayed = await presentForegroundPushBeforeUi({
      input: coldLaunch,
      displaySystemNotification: vi.fn(async () => {
        order.push('display');
      }),
      drainPersistedMessage: vi.fn(async () => {
        order.push('drain');
      }),
    });

    expect(displayed).toBe(true);
    expect(order).toEqual(['display', 'drain']);
  });

  it('still drains a persisted message when notification display rejects', async () => {
    const drain = vi.fn(async () => {});

    await expect(
      presentForegroundPushBeforeUi({
        input: coldLaunch,
        displaySystemNotification: async () => {
          throw new Error('display failed after persistence');
        },
        drainPersistedMessage: drain,
      }),
    ).rejects.toThrow('display failed after persistence');
    expect(drain).toHaveBeenCalledOnce();
  });

  it('does not display or drain after the notification UI is ready', async () => {
    const display = vi.fn(async () => {});
    const drain = vi.fn(async () => {});

    await expect(
      presentForegroundPushBeforeUi({
        input: { ...coldLaunch, uiReady: true },
        displaySystemNotification: display,
        drainPersistedMessage: drain,
      }),
    ).resolves.toBe(false);
    expect(display).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it('routes a cold-launch push through system display and the durable drain', async () => {
    const beforeDisplay = vi.fn();
    const normalForeground = vi.fn();
    const displayError = vi.fn();
    const display = vi.fn(async () => {});
    const drain = vi.fn(async () => {});

    await expect(
      routeForegroundPush({
        input: coldLaunch,
        displaySystemNotification: display,
        drainPersistedMessage: drain,
        onBeforeSystemDisplay: beforeDisplay,
        onSystemDisplayError: displayError,
        onNormalForeground: normalForeground,
      }),
    ).resolves.toBe('system');
    expect(beforeDisplay).toHaveBeenCalledOnce();
    expect(display).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    expect(displayError).not.toHaveBeenCalled();
    expect(normalForeground).not.toHaveBeenCalled();
  });

  it('diagnoses display failure after draining and does not reject Firebase callback', async () => {
    const error = new Error('display failed');
    const drain = vi.fn(async () => {});
    const displayError = vi.fn();

    await expect(
      routeForegroundPush({
        input: coldLaunch,
        displaySystemNotification: async () => {
          throw error;
        },
        drainPersistedMessage: drain,
        onBeforeSystemDisplay: vi.fn(),
        onSystemDisplayError: displayError,
        onNormalForeground: vi.fn(),
      }),
    ).resolves.toBe('system');
    expect(drain).toHaveBeenCalledOnce();
    expect(displayError).toHaveBeenCalledWith(error);
  });

  it('routes a ready app through the normal in-app foreground path', async () => {
    const normalForeground = vi.fn();
    const display = vi.fn(async () => {});

    await expect(
      routeForegroundPush({
        input: { ...coldLaunch, uiReady: true },
        displaySystemNotification: display,
        drainPersistedMessage: vi.fn(async () => {}),
        onBeforeSystemDisplay: vi.fn(),
        onSystemDisplayError: vi.fn(),
        onNormalForeground: normalForeground,
      }),
    ).resolves.toBe('foreground');
    expect(normalForeground).toHaveBeenCalledOnce();
    expect(display).not.toHaveBeenCalled();
  });
});
