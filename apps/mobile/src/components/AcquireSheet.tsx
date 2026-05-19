import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AvatarRenderer } from '../avatars/AvatarRenderer.js';
import { descriptorFor, type AvatarDescriptor } from '../avatars/catalog.js';
import { purchaseAvatar } from '../services/purchases.js';
import { useOwnership } from '../store/ownership.js';
import { accent, brand, font, scrim, space, workspace } from '../theme/tokens.js';
import { diag } from '../diag/log.js';

/**
 * AVATARSTORE.md §6.2 — paid-avatar acquire sheet.
 *
 * Brand-canvas ground (mode-invariant) — buying a face is a *brand*
 * moment, not a workspace moment. Big animated portrait centered,
 * name + tier label below, signature-effect blurb, price chip,
 * Acquire CTA in brass, Cancel link.
 *
 * On Acquire: spinner replaces the CTA, then on success we flip
 * ownership and call `onAcquired` (which the parent picker uses to
 * select the now-owned avatar and dismiss).
 *
 * Failure path is best-effort in Phase A — the fake purchase always
 * succeeds. Phase C: surface real cancel / fail outcomes, including
 * the "already owned, restored from another device" path.
 */

interface Props {
  visible: boolean;
  /** id from `CATALOG`. The sheet looks up tier / sku / price /
   * signature-effect blurb itself; the parent only knows the id. */
  animalId: string | null;
  onClose: () => void;
  /** Called after a successful acquire. Parent can flip selection +
   * dismiss in response. */
  onAcquired: (animalId: string) => void;
}

const SIGNATURE_BLURB: Record<string, string> = {
  ear_tuft_twitch: 'ear tufts twitch when your voice peaks.',
  fin_ripple: 'fins ripple along the body during speech.',
  head_tilt: 'cocks its head when you start a sentence.',
  throat_sac: 'throat sac inflates and deflates with your voice.',
  tongue_flick: 'tongue flicks at random intervals.',
  eyespot_pulse: 'tail eyespots pulse with the cadence of speech.',
  staccato_turn: 'snaps left or right on emphatic syllables.',
  tail_sweep: 'tail sweeps in quarter-arcs during speech.',
  claw_snap: 'claws snap open and shut on consonants.',
  shell_split: 'wing case parts when amplitude crosses a threshold.',
  lure_pulse: 'lure pulses in time with your speech.',
  dorsal_ripple: 'dorsal fin ripples in a slow continuous wave.',
  dragon_full: 'four-color discipline. The signature relaxes for jade scales.',
  phoenix_full:
    'four-color discipline. The signature relaxes for vermillion plumage.',
  turtle_full: 'four-color discipline. The signature relaxes for lapis carapace.',
  manticore_full:
    'four-color discipline. The signature relaxes for oxblood mane.',
};

export function AcquireSheet({
  visible,
  animalId,
  onClose,
  onAcquired,
}: Props): React.ReactElement {
  const desc: AvatarDescriptor | undefined = animalId
    ? descriptorFor(animalId)
    : undefined;
  // Already-owned check. Paid avatars route through the sheet even
  // after acquisition (see AvatarPickerScreen rationale comment) so
  // we render a "Wear {Name}" CTA instead of "Confirm purchase" in
  // that path.
  const alreadyOwned = useOwnership((s) =>
    desc?.skuId ? Boolean(s.ownedSkus[desc.skuId]) : false,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Static idle-pose amplitude bumps the signature effect once per
  // second so the user can preview the motion in the sheet without
  // needing to actually speak.
  const previewAmp = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(previewAmp, {
          toValue: 0.7,
          duration: 380,
          useNativeDriver: false,
        }),
        Animated.timing(previewAmp, {
          toValue: 0,
          duration: 380,
          useNativeDriver: false,
        }),
        Animated.delay(700),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, previewAmp]);

  useEffect(() => {
    if (!visible) {
      setBusy(false);
      setErr(null);
    } else if (desc) {
      diag('store', 'acquire sheet opened', {
        id: desc.id,
        tier: desc.tier,
        sku: desc.skuId,
      });
    }
  }, [visible, desc]);

  async function handleAcquire() {
    if (!desc || busy) return;
    if (alreadyOwned) {
      // Already owned → no purchase, just wear it.
      diag('store', 'wear (already owned)', { id: desc.id });
      onAcquired(desc.id);
      return;
    }
    diag('store', 'user tapped Confirm purchase', { id: desc.id });
    setBusy(true);
    setErr(null);
    try {
      const outcome = await purchaseAvatar(desc.id);
      diag('store', 'purchase outcome', { id: desc.id, kind: outcome.kind });
      if (outcome.kind === 'owned') {
        onAcquired(desc.id);
      } else if (outcome.kind === 'cancelled') {
        setBusy(false);
      } else {
        setErr(outcome.reason);
        setBusy(false);
      }
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={[styles.scrim, { backgroundColor: scrim.modal }]}
        onPress={busy ? undefined : onClose}
        testID="acquire-sheet-scrim"
      />
      <View style={styles.wrap} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            { backgroundColor: brand.canvas, borderTopColor: brand.surface },
          ]}
          testID="acquire-sheet"
        >
          <View style={[styles.grab, { backgroundColor: brand.surface }]} />
          {desc ? (
            <>
              <View
                style={[
                  styles.portraitWrap,
                  { backgroundColor: brand.surface },
                ]}
                testID="acquire-portrait"
              >
                <AvatarRenderer
                  animalId={desc.id}
                  size={120}
                  amplitude={previewAmp}
                />
              </View>
              <Text style={styles.tierLabel}>
                {tierLabel(desc.tier)}
                {desc.signatureColor ? (
                  <Text style={{ color: desc.signatureColor }}>  ✦</Text>
                ) : null}
              </Text>
              <Text style={styles.name}>{desc.name}</Text>
              {desc.signatureEffect &&
              SIGNATURE_BLURB[desc.signatureEffect] ? (
                <Text style={styles.blurb}>
                  {SIGNATURE_BLURB[desc.signatureEffect]}
                </Text>
              ) : null}

              {/* Price line + Phase-A disclaimer only when NOT already
                  owned. For owned avatars the sheet is a "wear this"
                  confirmation, not a purchase. */}
              {!alreadyOwned ? (
                <>
                  <Text style={styles.priceLine} testID="acquire-price">
                    {desc.displayPrice}
                  </Text>
                  <View style={styles.disclaimer}>
                    <Text style={styles.disclaimerText}>
                      PHASE A — simulated purchase, no charge. Real
                      App Store / Play Billing wires up in Phase C.
                    </Text>
                  </View>
                </>
              ) : (
                <View style={styles.divider} />
              )}

              <Pressable
                onPress={() => void handleAcquire()}
                disabled={busy}
                style={({ pressed }) => [
                  styles.cta,
                  {
                    backgroundColor: pressed ? accent.pressed : accent.base,
                  },
                ]}
                testID="acquire-confirm"
              >
                {busy ? (
                  <ActivityIndicator color={accent.foreground} />
                ) : (
                  <Text style={styles.ctaText}>
                    {alreadyOwned
                      ? `Wear ${desc.name}`
                      : `Confirm purchase — ${desc.displayPrice ?? ''}`}
                  </Text>
                )}
              </Pressable>

              {err ? (
                <Text style={styles.err} testID="acquire-error">
                  Couldn't complete: {err}
                </Text>
              ) : null}

              <Pressable
                onPress={busy ? undefined : onClose}
                hitSlop={8}
                testID="acquire-cancel"
              >
                <Text style={styles.cancel}>
                  {busy ? ' ' : alreadyOwned ? 'Cancel' : 'Not now'}
                </Text>
              </Pressable>
            </>
          ) : (
            <View style={styles.portraitWrap} />
          )}
        </View>
      </View>
    </Modal>
  );
}

function tierLabel(tier: 'free' | 'rare' | 'legendary'): string {
  if (tier === 'rare') return 'RARE';
  if (tier === 'legendary') return 'LEGENDARY';
  return 'FREE';
}

const TEXT = workspace.dark.text;
const TEXT_MUTE = workspace.dark.textMute;
const TEXT_FAINT = workspace.dark.textFaint;

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.xxl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    marginBottom: space.xl,
  },
  portraitWrap: {
    width: 160,
    height: 160,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.lg,
  },
  tierLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    letterSpacing: 11 * 0.18,
    color: accent.base,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  name: {
    fontFamily: font.bold,
    fontSize: 28,
    color: TEXT,
    textAlign: 'center',
    marginTop: space.xs,
    letterSpacing: -28 * 0.025,
  },
  blurb: {
    fontFamily: font.regular,
    fontSize: 13,
    color: TEXT_MUTE,
    textAlign: 'center',
    marginTop: space.m,
    lineHeight: 19,
  },
  priceLine: {
    fontFamily: font.bold,
    fontSize: 32,
    color: accent.base,
    textAlign: 'center',
    letterSpacing: -32 * 0.025,
    marginTop: space.lg,
    marginBottom: space.base,
  },
  disclaimer: {
    backgroundColor: 'rgba(229, 166, 69, 0.08)',
    borderColor: 'rgba(229, 166, 69, 0.3)',
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.m,
    paddingHorizontal: space.base,
    marginBottom: space.lg,
  },
  disclaimerText: {
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    color: accent.base,
    textAlign: 'center',
    letterSpacing: 0.18,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: TEXT_FAINT,
    marginVertical: space.xl,
  },
  cta: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.base,
    minHeight: 52,
  },
  ctaText: {
    fontFamily: font.medium,
    fontSize: 16,
    color: accent.foreground,
    letterSpacing: -16 * 0.01,
  },
  err: {
    fontFamily: font.regular,
    fontSize: 12,
    color: '#D63E3E',
    textAlign: 'center',
    marginTop: space.m,
  },
  cancel: {
    fontFamily: font.regular,
    fontSize: 14,
    color: TEXT_MUTE,
    textAlign: 'center',
    paddingVertical: space.base,
    marginTop: space.s,
  },
});
