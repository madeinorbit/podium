# Plan — POD-1708 Login propagation between machines (phase C)

Parent: POD-1659. Design: `docs/2026-08-04-cross-machine-login-catalog.md` §6.1, §6.4, §9. Depends on POD-1707.

## Problem

A machine with no login for a harness cannot run it, even when another connected machine is logged in with the same account. Carry the working login over. If that copy later stops working — because the donor's codex rotated the token — carry it again.

## The one decision this design rests on

**Propagation writes the machine's REAL credential file** (`~/.codex/auth.json`, `~/.claude/.credentials.json`), and **only when that file holds no valid login.**

That single rule is why there are no managed homes, no `CODEX_HOME` / `CLAUDE_CONFIG_DIR` redirection, no config mirroring, no session bridging and no precedence engine in this phase. **Do not reintroduce any of them.** If the work seems to need them, stop and raise it with the coordinator rather than building them.

Why it is safe: the user's own `codex login` writes the same file we do, so the moment they log in they are authoritative. We can never override a working login because we only ever write a file that has none.

Why a separate home would not help anyway: copying a credential never creates a separate refresh-token lineage (design §3). Both copies hold the same single-use refresh token. Managed homes buy multi-account, not safety — and multi-account is deferred.

## Triggers

1. A spawn finds the target machine logged out for the harness.
2. A running session raises a logged-out harness error. `apps/server/src/modules/superagent/harness-error.ts:85` already classifies `401 | not logged in | unauthorized | access token expired | authentication failed/required | please log in`. Reuse it; do not write a second classifier.

## Donor selection

Catalog entries (POD-1707) for that harness with `state === 'in'` on an online machine. **First match.** No policy — not round-robin, not quota-aware, not workstation-avoiding. Those are deliberately deferred; adding them here is scope creep.

Requires the harness to declare `portableCredential` (POD-1707). A harness that does not is simply never propagated — degrade, never substitute another harness's behaviour.

## Transport

Server requests credential bytes from the donor daemon, hands them to the target daemon, which writes them.

Hard constraints:

- Bytes live server-side only — `apps/server/src/store/server-secrets.ts`, never the replicated store, never the settings blob. `apps/server/src/accounts.ts:72` documents why: settings round-trip to every client wholesale.
- Server→daemon over the authenticated daemon channel, principal-gated.
- Never to a browser or mobile client, in any form, including logs and error messages.

## Four mandatory guards

All ported from Orca; each exists because of a real failure. Do not simplify them away.

1. **5s absence grace before believing a machine is logged out.** Reference: `src/main/codex-accounts/codex-credential-absence-grace.ts`. *"codex rotates auth.json in place, so one missing/unreadable read can be a write in progress."* Without this, ordinary rotation on the donor reads as a logout and we propagate over a race. Note the two exemptions: valid JSON (with or without a credential) is a settled file and needs no grace; a missing parent *directory* is structural and also needs none.

2. **Only strictly-fresher bytes overwrite.** Reference: `compareCodexAuthFreshness` in `codex-auth-identity.ts`. It returns `-1 | 0 | 1 | null`, and **`null` means the comparison could not be made — do not overwrite.** *"Identity proves ownership, not ordering."* The comparator itself is declared per-harness via `portableCredential.compareFreshness` (POD-1707).

3. **Atomic compare-and-swap write.** Write to a temp file and rename, and only when the target still holds what we read. A plain overwrite can clobber a credential the local CLI rotated in microseconds earlier. `apps/daemon/src/codex-hooks.ts:104` has the atomic-write pattern already used in this repo.

4. **Attempt cap and backoff.** Re-propagation must not thrash. Two machines running codex concurrently will fork the lineage repeatedly (design §9); the loop must converge or give up loudly, never spin.

## Identity check before writing

Only write a credential whose identity is consistent with what the target expects. Orca's `codexAuthMatchesManagedAccount` encodes the asymmetries worth reusing: a credential carrying no identity claims (API key, PAT) contradicts nothing; a matching account id outranks a stale email after a rename.

## Consent

On a machine with `podiumManaged === true` (POD-1707), propagate silently. On a machine the user marked as theirs, ask first — a borrowed credential that later refreshes can spend the token their own terminal is holding, and that surprise is the thing consent exists to prevent.

## Wiring back to phase A

POD-1706 left a placeholder for a "use the login from `<machine>`" affordance on a logged-out session. Make it real: it should list donor machines from the catalog and trigger propagation.

## Tests

Unit-testable and worth testing:

- Absence grace: a single missing read does not report logged-out; a missing read persisting past 5s does; valid JSON reports immediately; a missing parent directory reports immediately.
- Freshness: strictly-fresher overwrites; equal does not; stale does not; `null` does not.
- CAS: a write whose target changed underneath is refused.
- Backoff: repeated failures cap out rather than looping.
- Donor selection: skips offline machines, skips `state !== 'in'`, skips harnesses without `portableCredential`.
- Secrets: a test asserting credential bytes never appear in the replicated feed or a client-visible projection. This is the one worth being paranoid about.

**Real multi-machine verification is required** — this is the case in `docs/agents/testing.md` where the real stack is warranted, and the user has asked for end-to-end verification. Available machines (`podium machine list`): `flatblock` and `ludovico` (both Linux, codex + claude-code ready) and `Michaels-MacBook-Pro.local` (**claude-code installed but NOT logged in** — the natural live target). Verify at minimum: a logged-out machine receives a login and runs an agent; the local CLI logging in afterwards is not disturbed.

Do not use the real credentials of an account you would be upset to see rotated. If live verification risks the user's working login, stop and check with the coordinator first.

`bun run typecheck` (trust cache hits) and `bun run test`.

## Definition of done

- A spawn onto a logged-out machine acquires a login and runs.
- A session that hits a logged-out harness error re-acquires and recovers.
- Real credential file is written only when it holds no valid login.
- All four guards implemented with tests.
- Credential bytes provably never reach a client.
- Verified live across at least two real machines.

## Out of scope

Managed homes, dedicated Podium login, selection policy, harness install/update machinery, multi-account. Each is a separate deliverable.
