// Bump the affected component when the wire contract or required parsing semantics change.
// UI edits and implementation-only optimizations do not change this contract.
export const SYNC_PROTOCOL = 3;
export const SYNC_SCHEMA = 1;
export const EXTRACTOR_VERSION = 2;
export const SYNC_VERSION = `${SYNC_PROTOCOL}.${SYNC_SCHEMA}.${EXTRACTOR_VERSION}`;
export const SYNC_HEADER = 'X-Codex-Usage-Sync';
