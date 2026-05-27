/**
 * Voice-filter profiles for Private Call. Phase 2b — each profile
 * is now a (pitch, formant) pair, both in semitones, applied
 * independently by the phase vocoder. Pitch moves the perceived
 * voice height; formant moves the perceived vocal-tract size
 * (think: how big the speaker's head sounds). Decoupling them
 * lets Smoke read as "big person speaking low" rather than just
 * "shifted-down voice," and Glass as "small person speaking
 * high" rather than "chipmunk."
 *
 * The id is the wire identifier used in the settings store,
 * AccountScreen picker, and orchestrator lookup. The label and
 * blurb are user-facing. The two semitone values are what the
 * native side consumes.
 *
 * `velvet` keeps the −2 pitch and 0 formant (no formant shift)
 * — closest to a neutral "warm anonymization." `smoke` adds a
 * substantial formant drop (larger vocal tract) on top of its
 * pitch drop. `glass` pairs a pitch rise with a smaller vocal
 * tract for a bright, lighter character.
 */
export type VoiceFilterProfileId = 'smoke' | 'velvet' | 'glass';

export interface VoiceFilterProfile {
  id: VoiceFilterProfileId;
  label: string;
  blurb: string;
  /** Pitch shift in semitones. Negative = lower. */
  semitones: number;
  /** Phase 2b: formant shift in semitones, independent of pitch.
   *  Negative = formants down (larger-sounding vocal tract).
   *  Positive = formants up (smaller, brighter).
   *  0 = preserve original formants (helium-without-chipmunk
   *  when paired with pitch shift; "pure pitch shift" effect). */
  formantSemitones: number;
}

export const VOICE_FILTER_PROFILES: readonly VoiceFilterProfile[] = [
  {
    id: 'smoke',
    label: 'Smoke',
    blurb: 'Deep, large vocal tract. Reads as tall and quiet.',
    semitones: -4,
    formantSemitones: -3,
  },
  {
    id: 'velvet',
    label: 'Velvet',
    blurb: 'Warm, natural mid-range. Anonymized but human.',
    semitones: -2,
    formantSemitones: 0,
  },
  {
    id: 'glass',
    label: 'Glass',
    blurb: 'Higher, brighter, smaller-sounding.',
    semitones: +3,
    formantSemitones: +3,
  },
] as const;

export const DEFAULT_VOICE_FILTER_PROFILE: VoiceFilterProfileId = 'velvet';

export function semitonesForProfile(id: VoiceFilterProfileId): number {
  const match = VOICE_FILTER_PROFILES.find((p) => p.id === id);
  return match ? match.semitones : -2;
}

export function formantSemitonesForProfile(id: VoiceFilterProfileId): number {
  const match = VOICE_FILTER_PROFILES.find((p) => p.id === id);
  return match ? match.formantSemitones : 0;
}
