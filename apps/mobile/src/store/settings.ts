import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import {
  DEFAULT_VOICE_FILTER_PROFILE,
  type VoiceFilterProfileId,
} from '../calls/voice-filter-profiles.js';

const STORAGE_KEY = 'speakeasy.settings.v2';

/**
 * What gets shown on the system notification banner. Default is 'rich'
 * — most users want content-rich notifications. 'private' falls back
 * to a generic "speakeasy: New message" with no sender attribution.
 *
 * Per-device by design — the privacy choice is "what does *this*
 * device's lock screen reveal," not a user-account-wide knob.
 */
export type NotificationPrivacy = 'rich' | 'private';

/**
 * SETTINGS.md — full settings surface state. Each toggle has a
 * sensible default that doesn't require user input (§1, principle 3).
 */
interface SettingsState {
  // Privacy → Calls
  allowIncomingCalls: boolean;
  animateAvatarMouth: boolean;
  /** "Refuse video calls" (#13). Server-authoritative (the call-router
   * rejects inbound video offers when on); this is the local cache for
   * the toggle UI. The PrivacyScreen mirrors changes to the server via
   * `api.setRefuseVideo` and seeds this from `GET /v1/users/me`. */
  refuseVideo: boolean;

  // Privacy → Findability
  showOnlineStatus: boolean;

  // Notifications → Messages
  /** Drives the in-app banner toggle row "Banner when in another
   * conversation" — same value the original `inAppNotificationsEnabled`
   * gated. Renamed for spec compliance. */
  inAppNotificationsEnabled: boolean;
  messageSoundEnabled: boolean;
  messageVibrationEnabled: boolean;
  /** "Show preview text" toggle. Drives the per-device push payload
   * shape via NotificationPrivacy: ON → 'rich', OFF → 'private'. */
  notificationPrivacy: NotificationPrivacy;

  // Notifications → Calls
  ringtoneEnabled: boolean;
  vibrateOnIncoming: boolean;

  // Account → Voice filter (Private Call)
  /** Which Smoke/Velvet/Glass voice filter the user uses on
   *  outgoing Private Calls. Default is `velvet` — matches the
   *  hardcoded −2 semitones used before profiles existed, so
   *  pre-upgrade users hear the same voice they had. */
  voiceFilterProfile: VoiceFilterProfileId;

  hydrated: boolean;

  setAllowIncomingCalls: (v: boolean) => void;
  setAnimateAvatarMouth: (v: boolean) => void;
  setRefuseVideo: (v: boolean) => void;
  setShowOnlineStatus: (v: boolean) => void;
  setInAppNotificationsEnabled: (v: boolean) => void;
  setMessageSoundEnabled: (v: boolean) => void;
  setMessageVibrationEnabled: (v: boolean) => void;
  setNotificationPrivacy: (privacy: NotificationPrivacy) => void;
  setRingtoneEnabled: (v: boolean) => void;
  setVibrateOnIncoming: (v: boolean) => void;
  setVoiceFilterProfile: (id: VoiceFilterProfileId) => void;
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

type PersistedShape = Partial<
  Omit<
    SettingsState,
    | 'hydrated'
    | 'setAllowIncomingCalls'
    | 'setAnimateAvatarMouth'
    | 'setRefuseVideo'
    | 'setShowOnlineStatus'
    | 'setInAppNotificationsEnabled'
    | 'setMessageSoundEnabled'
    | 'setMessageVibrationEnabled'
    | 'setNotificationPrivacy'
    | 'setRingtoneEnabled'
    | 'setVibrateOnIncoming'
    | 'setVoiceFilterProfile'
    | 'hydrate'
    | 'reset'
  >
>;

const DEFAULTS = {
  allowIncomingCalls: true,
  animateAvatarMouth: true,
  refuseVideo: false,
  showOnlineStatus: true,
  inAppNotificationsEnabled: true,
  messageSoundEnabled: true,
  messageVibrationEnabled: true,
  notificationPrivacy: 'rich' as NotificationPrivacy,
  ringtoneEnabled: true,
  vibrateOnIncoming: true,
  voiceFilterProfile: DEFAULT_VOICE_FILTER_PROFILE,
} as const;

async function persist(s: PersistedShape): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // In-memory state is the source of truth for the session.
  }
}

function snapshot(s: SettingsState): PersistedShape {
  return {
    allowIncomingCalls: s.allowIncomingCalls,
    animateAvatarMouth: s.animateAvatarMouth,
    refuseVideo: s.refuseVideo,
    showOnlineStatus: s.showOnlineStatus,
    inAppNotificationsEnabled: s.inAppNotificationsEnabled,
    messageSoundEnabled: s.messageSoundEnabled,
    messageVibrationEnabled: s.messageVibrationEnabled,
    notificationPrivacy: s.notificationPrivacy,
    ringtoneEnabled: s.ringtoneEnabled,
    vibrateOnIncoming: s.vibrateOnIncoming,
    voiceFilterProfile: s.voiceFilterProfile,
  };
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,

  setAllowIncomingCalls: (v) => {
    set({ allowIncomingCalls: v });
    void persist(snapshot(get()));
  },
  setAnimateAvatarMouth: (v) => {
    set({ animateAvatarMouth: v });
    void persist(snapshot(get()));
  },
  setRefuseVideo: (v) => {
    set({ refuseVideo: v });
    void persist(snapshot(get()));
  },
  setShowOnlineStatus: (v) => {
    set({ showOnlineStatus: v });
    void persist(snapshot(get()));
  },
  setInAppNotificationsEnabled: (v) => {
    set({ inAppNotificationsEnabled: v });
    void persist(snapshot(get()));
  },
  setMessageSoundEnabled: (v) => {
    set({ messageSoundEnabled: v });
    void persist(snapshot(get()));
  },
  setMessageVibrationEnabled: (v) => {
    set({ messageVibrationEnabled: v });
    void persist(snapshot(get()));
  },
  setNotificationPrivacy: (privacy) => {
    set({ notificationPrivacy: privacy });
    void persist(snapshot(get()));
    // Server-side push of this preference happens via POST
    // /v1/devices/push-token. Caller (NotificationsScreen) is
    // responsible for invoking it.
  },
  setRingtoneEnabled: (v) => {
    set({ ringtoneEnabled: v });
    void persist(snapshot(get()));
  },
  setVibrateOnIncoming: (v) => {
    set({ vibrateOnIncoming: v });
    void persist(snapshot(get()));
  },
  setVoiceFilterProfile: (id) => {
    set({ voiceFilterProfile: id });
    void persist(snapshot(get()));
  },

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedShape;
        const next: Partial<SettingsState> = {};
        for (const k of Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>) {
          const v = parsed[k];
          if (v !== undefined) (next as Record<string, unknown>)[k] = v;
        }
        set(next);
      }
    } catch {
      // Corrupt / missing → keep defaults.
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ ...DEFAULTS });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
