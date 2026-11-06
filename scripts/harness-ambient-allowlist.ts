/**
 * Harness ambient-access allow-list (POD-6545, design
 * docs/design/harness-access-contract.md §3.6, epic POD-6520).
 *
 * The rule (`harness-ambient-access` in scripts/check-boundaries.ts) counts
 * direct machine access where it does not belong:
 *
 * - Scope A, packages/harness/src/adapters/** and
 *   packages/harness/src/driver/families/** (non-test, non-fixture): value
 *   imports of `node:child_process`/`child_process` (`child-process`),
 *   `Bun.spawn`/`Bun.spawnSync`/`Bun.$` (`bun-spawn`), `homedir`/`os.homedir`
 *   as a value (`homedir`) and `process.env` (`process-env`). A harness
 *   reaches the machine through the context it is handed, never through the
 *   daemon's own process.
 * - Scope B, apps/daemon/src (non-test): string literals naming a harness
 *   state folder, `.codex`, `.claude`, `.grok` or `.pi/agent`
 *   (`state-folder`). Folder rules belong to the adapters' `roots`.
 *
 * Each entry is one (file, access) pair at its measured count, with a
 * category:
 * - `to-migrate`: names the POD-6520 step that removes it. POD-6536 (Harness
 *   access lockdown) takes this category to zero.
 * - `os-tool`: an OS utility, not a harness, with a reason (ps/pgrep/lsof
 *   process inspection, /usr/bin/security). Stays.
 *
 * Ratchet (the vendor rule's semantics, keyed by file and access):
 * - a use the list does not cover (pair not listed, or over its count) FAILS;
 * - an entry holding more than remains FAILS with "lower the count" until the
 *   count is lowered, in the same commit as the code that removed the access;
 *   an entry at zero uses must be removed;
 * - a category total above its baseline constant FAILS, and so does a
 *   baseline constant above the seeded total. The list can only shrink.
 *
 * Measured at integrate/6520-harness-access-contract f619595514
 * (2026-11-06): 32 entries, 54 uses — to-migrate 51, os-tool 3. POD-6532
 * then removed the daemon's Codex folder literals (control/codex.ts,
 * session-observers.ts): 30 entries, 51 uses — to-migrate 48, os-tool 3.
 * POD-6534 moved the usage/quota sections onto the account's roots (Claude,
 * Codex, Grok usage.ts): 26 entries, 42 uses — to-migrate 39, os-tool 3.
 */

export type HarnessAmbientAccess =
  | 'child-process'
  | 'bun-spawn'
  | 'homedir'
  | 'process-env'
  | 'state-folder'

export type HarnessAmbientCategory = 'to-migrate' | 'os-tool'

export interface HarnessAmbientAllowlistEntry {
  /** Repo-relative file path. */
  file: string
  /** Which access the count is for. */
  access: HarnessAmbientAccess
  /** How many uses of this access the file may hold. New ones fail. */
  count: number
  category: HarnessAmbientCategory
  /** For os-tool: which OS tool, and why it is not harness access. */
  reason?: string
  /** For to-migrate: the issue that removes it. */
  issue?: string
}

/** Seeded category totals; the list may only go down from these. */
export const HARNESS_AMBIENT_BASELINE_TO_MIGRATE = 32
export const HARNESS_AMBIENT_BASELINE_OS_TOOL = 3

const A = 'packages/harness/src/adapters'
const F = 'packages/harness/src/driver/families'
const D = 'apps/daemon/src'

// Steps of POD-6520 (design §4).
const ROOTS = 'POD-6532' // context and roots: the Codex folder derivations
const ENGINE = 'POD-6546' // engine and attach binding: engine env, admission probes
const ACCOUNT = 'POD-6534' // account-scoped operations: usage, credentials, transcript reads
const CHILD_ENV = 'POD-6535' // single harness child environment

export const HARNESS_AMBIENT_ALLOWLIST: readonly HarnessAmbientAllowlistEntry[] = [
  // --- Scope B: harness state folders named in the daemon -------------------
  {
    file: `${D}/host-runtime.ts`,
    access: 'state-folder',
    count: 1,
    category: 'to-migrate',
    issue: CHILD_ENV,
  },

  // --- Scope A: claude-code -------------------------------------------------
  {
    file: `${A}/claude-code/index.ts`,
    access: 'homedir',
    count: 1,
    category: 'to-migrate',
    issue: ACCOUNT,
  },
  {
    file: `${A}/claude-code/index.ts`,
    access: 'process-env',
    count: 1,
    category: 'to-migrate',
    issue: ACCOUNT,
  },
  {
    file: `${A}/claude-code/keychain-security.ts`,
    access: 'child-process',
    count: 1,
    category: 'os-tool',
    reason:
      'spawns /usr/bin/security (SECURITY_PATH) to read the macOS keychain; an absolute OS tool, not the harness binary',
  },
  {
    file: `${A}/claude-code/state-locate.ts`,
    access: 'homedir',
    count: 1,
    category: 'to-migrate',
    issue: ACCOUNT,
  },

  // --- Scope A: codex -------------------------------------------------------
  {
    file: `${A}/codex/index.ts`,
    access: 'homedir',
    count: 1,
    category: 'to-migrate',
    issue: ROOTS,
  },
  {
    file: `${A}/codex/index.ts`,
    access: 'process-env',
    count: 1,
    category: 'to-migrate',
    issue: ROOTS,
  },
  {
    file: `${A}/codex/instrumentation.ts`,
    access: 'homedir',
    count: 1,
    category: 'to-migrate',
    issue: ROOTS,
  },
  {
    file: `${A}/codex/owned-rollout.ts`,
    access: 'child-process',
    count: 1,
    category: 'os-tool',
    reason:
      'execFile of pgrep/lsof/ps (C locale) to find which process owns a rollout file; OS process inspection, not the harness binary',
  },
  {
    file: `${A}/codex/state-provider.ts`,
    access: 'child-process',
    count: 1,
    category: 'os-tool',
    reason:
      'execFile of pgrep -x codex to list running Codex processes; OS process inspection, not the harness binary',
  },
  {
    file: `${A}/codex/state-provider.ts`,
    access: 'homedir',
    count: 2,
    category: 'to-migrate',
    issue: ROOTS,
  },

  // --- Scope A: fixture harness ---------------------------------------------
  {
    file: `${A}/fixture/transcript.ts`,
    access: 'homedir',
    count: 1,
    category: 'to-migrate',
    issue: ACCOUNT,
  },

  // --- Scope A: grok --------------------------------------------------------
  {
    file: `${A}/grok/index.ts`,
    access: 'process-env',
    count: 1,
    category: 'to-migrate',
    issue: ACCOUNT,
  },
  {
    file: `${A}/grok/instrumentation.ts`,
    access: 'homedir',
    count: 2,
    category: 'to-migrate',
    // POD-6533 moved the install onto the session context; what is left is
    // grokRoot (hook-payload session paths, a transcript read) and the
    // installer's no-home default.
    issue: ACCOUNT,
  },
  {
    file: `${A}/grok/instrumentation.ts`,
    access: 'process-env',
    count: 2,
    category: 'to-migrate',
    // POD-6533 moved the install onto the session context; what is left is
    // grokRoot (hook-payload session paths, a transcript read) and the
    // installer's no-home default.
    issue: ACCOUNT,
  },
  {
    file: `${A}/grok/state-locate.ts`,
    access: 'homedir',
    count: 1,
    category: 'to-migrate',
    issue: ACCOUNT,
  },
  {
    file: `${A}/grok/state-locate.ts`,
    access: 'process-env',
    count: 1,
    category: 'to-migrate',
    issue: ACCOUNT,
  },

  // --- Scope A: opencode ----------------------------------------------------
  {
    file: `${A}/opencode/cli.ts`,
    access: 'child-process',
    count: 1,
    category: 'to-migrate',
    issue: ENGINE,
  },
  {
    file: `${A}/opencode/cli.ts`,
    access: 'homedir',
    count: 4,
    category: 'to-migrate',
    issue: ENGINE,
  },
  {
    file: `${A}/opencode/cli.ts`,
    access: 'process-env',
    count: 3,
    category: 'to-migrate',
    issue: CHILD_ENV,
  },
  {
    file: `${A}/opencode/discovery.ts`,
    access: 'homedir',
    count: 1,
    category: 'to-migrate',
    issue: ACCOUNT,
  },
  {
    file: `${A}/opencode/index.ts`,
    access: 'process-env',
    count: 1,
    category: 'to-migrate',
    issue: CHILD_ENV,
  },
  {
    file: `${A}/opencode/paths.ts`,
    access: 'homedir',
    count: 2,
    category: 'to-migrate',
    issue: ACCOUNT,
  },

  // --- Scope A: driver families ---------------------------------------------
  {
    file: `${F}/grok-acp/engine-host.ts`,
    access: 'process-env',
    count: 1,
    category: 'to-migrate',
    issue: ENGINE,
  },
  {
    file: `${F}/opencode/engine-host.ts`,
    access: 'process-env',
    count: 2,
    category: 'to-migrate',
    issue: ENGINE,
  },
]
