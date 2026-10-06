/**
 * Synthetic harness vocabulary for fixture generators (POD-5614).
 *
 * Fixture corpora need REAL harness kinds and labels as data: the corpus
 * mints sessions across four kinds, and the scenario generator seeds named
 * seats. Spelled here, once, in the excluded fixture path — every generator
 * imports these identifiers instead of quoting vendor literals, which the
 * harness-vendor boundary refuses outside adapters and driver families.
 * Test files may keep spelling their own literals; they are excluded too.
 *
 * Values are DATA, never behaviour: nothing here branches on a harness.
 */
export const SYNTHETIC_CLAUDE_KIND = 'claude-code'
export const SYNTHETIC_CODEX_KIND = 'codex'
export const SYNTHETIC_OPENCODE_KIND = 'opencode'
export const SYNTHETIC_GROK_KIND = 'grok'
export const SYNTHETIC_CODEX_TITLE = 'Codex'
