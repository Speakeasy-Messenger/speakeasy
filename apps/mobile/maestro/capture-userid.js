// Maestro runScript callback. `maestro.copiedText` holds the value
// from the most recent `copyTextFrom` step. We expose it as an output
// the next flow can read via `MAESTRO_USERID`.
output.userId = maestro.copiedText;
console.log('captured userId:', maestro.copiedText);
