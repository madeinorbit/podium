/**
 * THE GENERIC AGENT-STATE BARREL (POD-4520): harness-free observation
 * vocabulary only.
 *
 * Per-harness state knowledge (screen rules, hook-derived state, locate /
 * binding helpers, causal fingerprints) lives in `adapters/<h>/state.ts` and
 * its `state-*.ts` siblings (spec §4.5) — never here. The package barrel
 * (`packages/harness/src/index.ts`) re-exports those adapter sections
 * directly, so daemon hosts keep one import surface with no harness-named
 * module under this directory.
 */
export * from '../observer.js'
export * from './types.js'
