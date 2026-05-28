import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ABUSE_REPORT_DETAIL_MAX_CHARS, type AbuseReportReason } from '@speakeasy/shared';
import { useColors } from '../theme/index.js';
import { font, scrim, space } from '../theme/tokens.js';

/**
 * Confirmation sheet for filing an abuse report against a peer.
 * Two-step:
 *
 *   1. Reason picker (5 options: Spam, Harassment, Threats, Hate
 *      speech, Other). Tapping a reason advances to step 2 — there's
 *      no separate "Next" tap to learn.
 *   2. Confirm (with an optional 200-char detail field when reason
 *      is `'other'`).
 *
 * Submission outcome is opaque to the reporter — the toast just
 * confirms the report was filed. The reporter never learns the
 * server's banned-yet count (leaking the 5-strike threshold would
 * make coordinated-attack planning easier).
 */
interface Props {
  visible: boolean;
  handle: string;
  onClose: () => void;
  onSubmit: (reason: AbuseReportReason, detail?: string) => Promise<void> | void;
}

interface ReasonOption {
  value: AbuseReportReason;
  label: string;
  helper: string;
}

const REASONS: ReasonOption[] = [
  { value: 'spam', label: 'Spam', helper: 'Bulk messaging, ads, scams.' },
  {
    value: 'harassment',
    label: 'Harassment',
    helper: 'Targeted insults, repeated unwanted contact, stalking.',
  },
  {
    value: 'threats',
    label: 'Threats',
    helper: 'Threats of violence or sharing private info.',
  },
  {
    value: 'hate_speech',
    label: 'Hate speech',
    helper: 'Slurs or attacks on a person or group.',
  },
  {
    value: 'other',
    label: 'Other',
    helper: 'Something not covered above.',
  },
];

export function ReportConfirmSheet({
  visible,
  handle,
  onClose,
  onSubmit,
}: Props): React.ReactElement {
  const themed = useColors();
  // Reset internal step whenever the sheet re-opens — re-opening after
  // close should always land on the reason picker, not the confirm
  // step from the previous run.
  const [reason, setReason] = useState<AbuseReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  React.useEffect(() => {
    if (visible) {
      setReason(null);
      setDetail('');
      setSubmitting(false);
    }
  }, [visible]);

  async function handleSubmit() {
    if (!reason) return;
    setSubmitting(true);
    try {
      await onSubmit(reason, detail.trim() || undefined);
    } finally {
      setSubmitting(false);
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
        onPress={onClose}
      />
      <View style={styles.wrap} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            { backgroundColor: themed.cream, borderTopColor: themed.divider },
          ]}
          testID="report-confirm-sheet"
        >
          <View style={[styles.grab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.title, { color: themed.ink }]}>
            Report <Text style={{ color: themed.primary }}>@</Text>
            {handle}
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>

          {reason === null ? (
            <ReasonStep
              themed={themed}
              onPick={(r) => setReason(r)}
              onCancel={onClose}
            />
          ) : (
            <ConfirmStep
              themed={themed}
              reason={reason}
              detail={detail}
              onChangeDetail={setDetail}
              onBack={() => setReason(null)}
              onSubmit={handleSubmit}
              submitting={submitting}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function ReasonStep({
  themed,
  onPick,
  onCancel,
}: {
  themed: ReturnType<typeof useColors>;
  onPick: (r: AbuseReportReason) => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <>
      <Text style={[styles.subtitle, { color: themed.slate }]}>
        Pick a reason. Our team reviews reports after a small number from
        different people accumulate against the same handle.
      </Text>
      <View style={styles.reasonList}>
        {REASONS.map((r) => (
          <Pressable
            key={r.value}
            onPress={() => onPick(r.value)}
            style={[styles.reasonRow, { borderColor: themed.divider }]}
            testID={`report-reason-${r.value}`}
          >
            <Text style={[styles.reasonLabel, { color: themed.ink }]}>
              {r.label}
            </Text>
            <Text style={[styles.reasonHelper, { color: themed.slate }]}>
              {r.helper}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        onPress={onCancel}
        style={[styles.btnSecondary, { borderColor: themed.divider }]}
        testID="report-cancel"
      >
        <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
          Cancel
        </Text>
      </Pressable>
    </>
  );
}

function ConfirmStep({
  themed,
  reason,
  detail,
  onChangeDetail,
  onBack,
  onSubmit,
  submitting,
}: {
  themed: ReturnType<typeof useColors>;
  reason: AbuseReportReason;
  detail: string;
  onChangeDetail: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
}): React.ReactElement {
  const summary = REASONS.find((r) => r.value === reason)!;
  return (
    <>
      <View style={styles.body}>
        <Text style={[styles.para, { color: themed.slate }]}>
          You're reporting this handle for{' '}
          <Text style={{ color: themed.ink, fontFamily: font.medium }}>
            {summary.label.toLowerCase()}
          </Text>
          . The report goes to our review team and is dedupe-tracked —
          your account can file one report per handle.
        </Text>
        {reason === 'other' ? (
          <TextInput
            value={detail}
            onChangeText={onChangeDetail}
            placeholder="A short note (optional)"
            placeholderTextColor={themed.slate}
            maxLength={ABUSE_REPORT_DETAIL_MAX_CHARS}
            multiline
            style={[
              styles.detailInput,
              { color: themed.ink, borderColor: themed.divider },
            ]}
            testID="report-detail-input"
          />
        ) : null}
        <Text style={[styles.para, { color: themed.slate }]}>
          The reported user is not notified.
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={onBack}
          style={[styles.btnSecondary, { borderColor: themed.divider }]}
          disabled={submitting}
          testID="report-back"
        >
          <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
            Back
          </Text>
        </Pressable>
        <Pressable
          onPress={onSubmit}
          disabled={submitting}
          style={[
            styles.btnPrimary,
            { backgroundColor: themed.primary, opacity: submitting ? 0.5 : 1 },
          ]}
          testID="report-confirm"
        >
          <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
            {submitting ? 'Filing…' : 'File report'}
          </Text>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject },
  wrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  sheet: {
    paddingHorizontal: space.xl,
    paddingTop: space.base,
    paddingBottom: space.xxl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    marginBottom: space.lg,
  },
  title: {
    fontFamily: font.bold,
    fontSize: 20,
    letterSpacing: -0.02 * 20,
    marginBottom: space.m,
  },
  subtitle: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: space.base,
  },
  reasonList: { gap: space.s, marginBottom: space.lg },
  reasonRow: {
    paddingVertical: space.m,
    paddingHorizontal: space.base,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reasonLabel: {
    fontFamily: font.medium,
    fontSize: 15,
    marginBottom: 2,
  },
  reasonHelper: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
  },
  body: { marginBottom: space.xl, gap: space.m },
  para: { fontFamily: font.regular, fontSize: 13, lineHeight: 20 },
  detailInput: {
    fontFamily: font.regular,
    fontSize: 14,
    minHeight: 72,
    padding: space.m,
    borderWidth: StyleSheet.hairlineWidth,
    textAlignVertical: 'top',
  },
  actions: { gap: space.s },
  btnPrimary: { paddingVertical: space.base, alignItems: 'center' },
  btnPrimaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  btnSecondary: {
    paddingVertical: space.base,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnSecondaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
});
