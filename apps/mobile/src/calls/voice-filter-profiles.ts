/**
 * Voice-filter profiles for Private Call. Each profile is just a
 * pitch shift (in semitones) on the current granular DSP. The
 * algorithm shifts pitch AND formants together — independent
 * shifting lands when Phase 2 swaps granular for a phase vocoder.
 * Until then, the 3 profiles differ in pitch height but share the
 * same timbral character.
 *
 * The id (`'smoke' | 'velvet' | 'glass'`) is the wire identifier
 * used in the settings store, AccountScreen picker, and orchestrator
 * lookup. The label + blurb are user-facing. The semitones value is
 * what the native side actually consumes.
 *
 * `velvet` matches the previous hardcoded default (−2 semitones), so
 * any user who hasn't picked a profile stays on the voice they
 * already had.
 */
export type VoiceFilterProfileId = 'smoke' | 'velvet' | 'glass';

export interface VoiceFilterProfile {
  id: VoiceFilterProfileId;
  label: string;
  blurb: string;
  semitones: number;
}

export const VOICE_FILTER_PROFILES: readonly VoiceFilterProfile[] = [
  {
    id: 'smoke',
    label: 'Smoke',
    blurb: 'Deeper, lower, slightly menacing.',
    semitones: -4,
  },
  {
    id: 'velvet',
    label: 'Velvet',
    blurb: 'Warm and anonymized. The default.',
    semitones: -2,
  },
  {
    id: 'glass',
    label: 'Glass',
    blurb: 'Higher, lighter, brighter.',
    semitones: +3,
  },
] as const;

export const DEFAULT_VOICE_FILTER_PROFILE: VoiceFilterProfileId = 'velvet';

export function semitonesForProfile(id: VoiceFilterProfileId): number {
  const match = VOICE_FILTER_PROFILES.find((p) => p.id === id);
  return match ? match.semitones : -2;
}
