// Removed per CLAUDECODENOTE.md item 2 — a separate aggregated calls
// list is a privacy regression. Call records live inline in the chat
// feed as `voice call · M:SS.` system messages (CALLS.md §06) and
// dissolve with the conversation TTL. The Calls bottom-tab is gone;
// the file is left empty so the build keeps passing until `rm` lands.
export {};
