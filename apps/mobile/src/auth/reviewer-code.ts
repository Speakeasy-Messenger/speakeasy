/** Pending vf-reviewer-code's published accept contract. Fail closed: never mint or reuse a token locally. */
export async function verifyReviewerCode(_args: {
  code: string;
  context: 'signup' | 'login';
}): Promise<{ deviceToken: string }> {
  throw new Error('Reviewer verification is not connected yet');
}
