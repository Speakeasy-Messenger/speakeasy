export type ForegroundPushPresentationInput = {
  platform: string;
  uiReady: boolean;
  conversationId?: string;
  notifyKind?: string;
};

export function shouldDisplayForegroundPushAsSystem(
  input: ForegroundPushPresentationInput,
): boolean {
  return (
    input.platform === 'android' &&
    !input.uiReady &&
    !!input.conversationId &&
    !!input.notifyKind
  );
}

/**
 * Present a push that Firebase classified as foreground while React is still
 * mounting. The durable inbox must be drained even when notification display
 * fails after decryption/persistence, otherwise an acknowledged message can
 * remain invisible until the next app-state transition.
 */
export async function presentForegroundPushBeforeUi(args: {
  input: ForegroundPushPresentationInput;
  displaySystemNotification: () => Promise<void>;
  drainPersistedMessage: () => Promise<unknown>;
}): Promise<boolean> {
  if (!shouldDisplayForegroundPushAsSystem(args.input)) return false;

  try {
    await args.displaySystemNotification();
  } finally {
    await args.drainPersistedMessage();
  }
  return true;
}

/** Adapter used by Firebase's foreground callback. Kept dependency-injected
 * so the native callback's routing and error diagnostics are executable in
 * unit tests instead of being verified through source-text assertions. */
export async function routeForegroundPush(args: {
  input: ForegroundPushPresentationInput;
  displaySystemNotification: () => Promise<void>;
  drainPersistedMessage: () => Promise<unknown>;
  onBeforeSystemDisplay: () => void;
  onSystemDisplayError: (error: unknown) => void;
  onNormalForeground: () => void;
}): Promise<'system' | 'foreground'> {
  if (!shouldDisplayForegroundPushAsSystem(args.input)) {
    args.onNormalForeground();
    return 'foreground';
  }

  args.onBeforeSystemDisplay();
  try {
    await presentForegroundPushBeforeUi(args);
  } catch (error) {
    args.onSystemDisplayError(error);
  }
  return 'system';
}
