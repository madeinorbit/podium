/**
 * Architecture-manifest violation allowlist (POD-296) — EMPTY, and required to
 * stay that way (POD-335).
 *
 * WHAT THIS FILE WAS. A phase-mapped ledger of known violations: each entry
 * recorded a rule, a file, how many times it occurred there, and the phase that
 * would delete it. Allowlisted-and-within-count WARNED; anything new, over
 * count, or left slack FAILED. That ratchet did its job — it froze the debt at
 * its measured size while the rewrite ran, and the counts only ever went down.
 *
 * WHAT IT IS NOW. Phase 7 paid the last of it, so the array is empty and the
 * emptiness is DEFENDED rather than merely current:
 * `ERROR_LEVEL_MANIFEST_RULES` is the whole manifest rule set, and
 * `applyManifestPolicy` reports any entry naming an error-level rule as a
 * FORBIDDEN entry. So adding a row here does not quietly re-open the ratchet —
 * it fails the build, with the rule name in the message. The way back is to fix
 * the dependency, or to change the manifest deliberately.
 *
 * HOW THE LAST SIX WENT (measured, not asserted — see
 * docs/gates/pod-335-boundary-lint-end-state.md for the full retirement table):
 *
 *  - FOUR `agent-host-consumers` entries (apps/server: accounts.ts, relay.ts,
 *    harness-manifest.ts, modules/sessions/daemon-lifecycle.ts). All four wanted
 *    static software metadata, not a host capability, and a whole-package ban
 *    could not tell the difference. `packages/harness` now declares the narrow
 *    open entrypoint `@podium/harness/metadata` and the four imports point at
 *    it; `manifest-consumers` still refuses everything else.
 *  - TWO `apps/desktop/scripts/stage-sidecar.ts` entries (`manifest-layer` +
 *    `manifest-platform`). Their own note called them a tag-granularity artifact
 *    and named two possible resolutions for Phase 7. The second was taken:
 *    `apps/&#42;/scripts/**` is now classified as BUILD TIER, which says the true
 *    thing about a build script instead of excusing a false accusation.
 */

import type { AllowlistEntry } from './architecture-manifest'

export const BOUNDARY_ALLOWLIST: readonly AllowlistEntry[] = []
