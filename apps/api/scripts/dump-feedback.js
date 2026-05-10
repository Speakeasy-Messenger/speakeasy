// Dump pending in-app feedback. Run on speakeasy-api-1 via:
//   fly ssh console -a speakeasy-api-1 -C "node /app/apps/api/scripts/dump-feedback.js"
//
// Args:
//   --all           Include already-reviewed rows (default: only unreviewed)
//   --limit=N       Max rows to print (default: 50)
//   --mark-reviewed Mark each row reviewed_at = NOW() AS we print it
//
// Plaintext storage by design (the `@feedback` channel is opt-in
// non-E2E; users see a banner above the chat saying so). Don't add
// any decryption code here — there's nothing encrypted.
import { Pool } from 'pg';

function parseArgs(argv) {
  const out = { all: false, limit: 50, markReviewed: false };
  for (const a of argv.slice(2)) {
    if (a === '--all') out.all = true;
    else if (a === '--mark-reviewed') out.markReviewed = true;
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice(8), 10) || 50;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const where = args.all ? 'TRUE' : 'reviewed_at IS NULL';
  const { rows } = await pool.query(
    `SELECT id, sender_user_id, app_version, text, created_at, reviewed_at
       FROM feedback
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $1`,
    [args.limit],
  );
  if (rows.length === 0) {
    console.log(args.all ? '(no feedback yet)' : '(no unreviewed feedback)');
    await pool.end();
    return;
  }
  for (const r of rows) {
    console.log('---');
    console.log(`id:       ${r.id}`);
    console.log(`from:     @${r.sender_user_id}`);
    console.log(`version:  ${r.app_version ?? '?'}`);
    console.log(`when:     ${r.created_at.toISOString()}`);
    console.log(
      `reviewed: ${r.reviewed_at ? r.reviewed_at.toISOString() : 'NO'}`,
    );
    console.log('');
    console.log(r.text);
    console.log('');
  }
  console.log(`(${rows.length} rows)`);

  if (args.markReviewed) {
    const ids = rows.map((r) => r.id);
    const result = await pool.query(
      `UPDATE feedback SET reviewed_at = NOW() WHERE id = ANY($1::text[]) AND reviewed_at IS NULL`,
      [ids],
    );
    console.log(`Marked ${result.rowCount} rows reviewed.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
