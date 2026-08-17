# Updater dead-path cleanup — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §10.3, §11
**Protocol:** `2026-08-14-updater-worker-protocol.md`
**Blocked by:** Update operation panel; Desktop shell update integration (this is the
sweep after the rewrites settle).

**Goal:** Remove what the redesign obsoleted, unify what was duplicated, and leave no
path that can only mislead.

**Owns:** small, surgical deletions across `apps/web/src/features/updates/`,
`apps/desktop/src-tauri/src/updater.rs`, `packages/runtime/src/update-delivery.ts`,
`apps/cli/src/podium-update.ts`, plus test updates. Deletion discipline: after each
removal, prove the build output is gone too (typecheck + grep the dist where relevant)
and that no caller remains.

## Tasks

- [ ] **Duplicated `verifyTarball`** — two byte-identical implementations
  (`packages/runtime/src/update-delivery.ts:56` and `apps/cli/src/podium-update.ts:108`).
  Keep the runtime one; the CLI imports it. One signature-verification code path, its
  existing tests consolidated (tamper arm of `scripts/verify-headless-update.sh` still
  green).
- [ ] **`feed_endpoint` dead code** — `updater.rs:92-97` is unused by production (only
  tests and the local verification feed). Either the verification harness keeps it as a
  clearly test-scoped helper or it moves into the test module; it must stop looking like
  a production path.
- [ ] **Autoconfirm remnants** — after the desktop issue's native fallback landed,
  remove any leftover `PODIUM_UPDATE_AUTOCONFIRM` handling outside the renamed
  test-only override; grep proves zero remaining references outside tests/scripts.
- [ ] **Obsolete client heuristics** — `appOnlyFromReleaseFeed` / `isSourceWebDigest`
  regex heuristics (`update-view.ts:217-228`) and any other version-namespace guesswork
  the operation model made unnecessary: delete if the panel rewrite left them unused
  (check callers first; if still load-bearing, file a note instead of forcing it).
- [ ] **Dismiss-vocabulary sweep** — no `Later`/`Dismiss`/`OK` variants left in update
  surfaces; "Hide" only (should already be true post-panel; this is the audit).
- [ ] **Doc alignment** — `docs/agents/updater-acceptance.md`: fold in the new drills
  (operation adoption across restart, single-flight, stalled-download, straggler
  reconciliation) and update the file references the regimen names
  (`use-update-state.ts` → the new module layout). `docs/update-release-swaps.md` and
  `docs/desktop-releases.md`: correct anything the desktop issue changed (channel
  authority, fallback). The old spec `2026-08-04-coherent-update-story-design.md` gets a
  superseded-by header pointing at the operations spec.

## Testing

Typecheck + full `bun run test` after each deletion batch; `verify-headless-update.sh`
both arms; a final grep sweep listed in the issue state (each removed symbol → zero
hits outside history).

## Acceptance

- One `verifyTarball`; no production-looking dead updater code in Rust; no autoconfirm
  outside test scope; docs name the files that exist.
