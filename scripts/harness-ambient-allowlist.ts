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
 * - `os-tool`: an OS utility, not a harness, with a reason. Since POD-6536
 *   there are none: every OS tool (ps/pgrep/lsof, /usr/bin/security,
 *   curl/wget/ldd, an installer's sh/bash) runs through the `HostTools` port
 *   (packages/harness/src/host-tools.ts), which resolves an absolute path in
 *   the command environment. An adapter that imports `child_process` again
 *   fails here.
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
 * POD-6536 (Harness access lockdown) took the list to ZERO: adapters bind argv
 * to a context, every remaining home/env read takes the account it is handed,
 * and the OS tools run through `HostTools`. 0 entries, 0 uses. The list stays
 * as the ratchet's anchor: any new direct access fails, and there is nothing
 * left to lower.
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
export const HARNESS_AMBIENT_BASELINE_TO_MIGRATE = 0
export const HARNESS_AMBIENT_BASELINE_OS_TOOL = 0

export const HARNESS_AMBIENT_ALLOWLIST: readonly HarnessAmbientAllowlistEntry[] = []
