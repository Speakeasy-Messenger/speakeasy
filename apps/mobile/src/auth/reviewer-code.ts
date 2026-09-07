/**
 * Server contract: fm/vf-reviewer-code, docs/reviewer-verification-codes.md.
 * Accept uses POST /v1/verify/:session_id/fallback with method=reviewer_code,
 * reviewer_code (32 lowercase hex), and device_token; FALLBACK_COMPLETE is terminal.
 * Pending a native transport decision: installed SDKs expose only email-specific
 * fallback methods and keep the pinned HTTP client private. Fail closed meanwhile.
 */
export async function verifyReviewerCode(_args: {
  code: string;
  context: 'signup' | 'login';
}): Promise<{ deviceToken: string }> {
  throw new Error('Reviewer verification is not connected yet');
}
