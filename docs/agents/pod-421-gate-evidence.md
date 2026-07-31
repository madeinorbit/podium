# POD-421 — redaction, presence/fingerprint UI, audit log: gate evidence

Branch `issue/421-3-7d-redaction-presence-fingerprint-ui-a`, based on
`issue/279-integration` at `f63e0581`. No rebase, no merge of main or a sibling.

The POD-352 exit audit is a separate document:
[`pod-352-exit-audit.md`](./pod-352-exit-audit.md).

## The acceptance criteria, each one answered

| AC | Where | Verdict |
|---|---|---|
| Redaction driven by contract metadata, verified in event logs, audit records AND error paths incl. refusal bodies | `packages/commands/src/redaction.ts`, `apps/server/src/modules/settings/audit.ts` | **met** — the reader for metadata POD-420 declared and nothing consumed; applied identically to applied and refused paths, plus the message-string backstop a path list structurally cannot cover |
| Three legible surfaces, admin controls disabled-with-reason rather than editable-then-refused | `apps/web/src/features/settings/surfaces.ts`, `SettingsView.tsx` | **met** — the nav is grouped by visibility class, each tab carries a class banner, and the disabled state comes from `settings.viewer`, derived from the same gate the server enforces |
| Secret surfaces show presence + fingerprint only; no masked field round-trips a value; unauthorized reads fail identically to nonexistent ones | `sections/secrets.tsx`, `modules/settings/authz.ts` | **met** — write-only input by construction; one unavailable state with one string, reached by every failure path |
| Audit records carry the actor / on-behalf-of pair uncollapsed; system writes attributed as system | `store/settings-audit.ts` | **met** — two columns, both derived from the principal KIND, plus a CHECK constraint the writer cannot talk its way past |
| Telegram UI: bot token as admin-managed secret, per-user routing only, no ambient operator-fallback send | `sections/notifications.tsx` | **met** — the token moved to the secrets surface; the chat id is displayed, not editable |
| Runtime verification for an admin AND a non-admin, with evidence | `tests/e2e/browser/settings-surfaces.browser.e2e.ts` | **met** — admin 9/9, member 8/8, screenshots under `docs/evidence/pod-421/` |
| POD-352 exit audit at zero with cited evidence | `pod-352-exit-audit.md` | **met for 5 of 7 items**; item 5 is an OPEN GAP (POD-1213) recorded rather than waved through, on POD-352's explicit instruction |
| The two open items recorded as still open and handed forward | `pod-352-exit-audit.md` §O1/O2 | **met** |

## What this issue found, and it is the reason it existed

Three declarations with no consumer, each individually reviewable and green.
POD-352 named the shape after I reported the first two:

> A totality test proves every field is classified, and proves nothing about
> whether anything reads the classification. **A declaration with no consumer is
> indistinguishable from an enforced one from every angle except grepping for the
> consumer.**

- **`roleFloor`** — declared on six settings contracts by POD-420, which said so
  itself (*"Nothing enforces the floor today; POD-1079 owns it"*). POD-1079 then
  enforced the FLEET's floors and the settings family's stayed declarative.
- **`redaction`** — declared with a note stating exactly what it was for
  (*"never logged, never echoed into an event, never included in an error"*).
  Nothing read it.
- **the audit trail** — did not exist for this family at all.

## Defects found by the instruments, not by review

1. **The app did not boot.** `SETTINGS_GROUPS` initialises at module scope and
   read `TAB_LABEL` from below its own declaration — a temporal dead zone. The
   bundled app threw `Cannot read properties of undefined (reading 'sessions')`
   and the **entire shell** failed to render. The typecheck was happy (the
   binding exists) and all 75 web unit tests were green, because every one of
   them imports `surfaces.ts` directly rather than through the module whose
   evaluation order was wrong. **Only a running browser could see it** — which is
   precisely why the brief demanded runtime verification.
2. **A redacted path into a non-plain object failed OPEN.** Found while choosing
   mutants. The walker descended only into plain objects and returned everything
   else untouched — correct for PRESERVING a `Date`, fail-open for REDACTING one:
   a declared path resolving into a class instance was silently not redacted, and
   `redactedPaths` truthfully reported that nothing had been removed. The
   redaction read as working from every angle. Fixed by redacting the whole
   container when it HAS the address, with a control proving it does not redact
   one it does not.
3. **A UI predicate over a relocated field INVERTED.** `startTelegramSetup` gated
   on `settings.notifications.telegramBotToken` being non-blank. POD-419 moved
   that material, so the member is now always `''`: the guard would have refused
   every ceremony on every instance — including correctly configured ones — and
   told the user to paste a token into a field that no longer exists. It kept
   typechecking and kept rendering; it just started answering "no". Now read from
   presence.
4. **`audit-client-secrets`' own probe was positionally anchored.** It read
   `NAMED_SITES[3]`, fine at five entries and `undefined` once this issue
   ratcheted the census to one. It failed rather than passed — the right
   direction — but for the wrong reason, and one re-index away from being
   silenced. Now chosen by existence, with an explicit failure if the list empties
   so the checks cannot end up passing vacuously.
5. **The reach-through the ratchet caught.** Reading
   `ctx.registry.sessionStore.settingsAudit` from the derived router grew
   `router-triple-access` 18 → 19. The audit port is now a required dependency of
   `SettingsService`, which is where it belonged: a transport that can reach the
   store directly is a transport that can grow a second policy for it.

## Every refusal is paired with what it must NOT refuse

| refusal | the control that stops it being vacuous |
|---|---|
| a member is refused every admin-floor command | a member MAY still write their own preferences — asserted through the real router, or the screen would be inert for non-admins and green |
| `undefined` role satisfies no floor | `member` satisfies the member floor |
| the secret READ refuses as `NOT_FOUND`/absent | the secret WRITE refuses honestly as `FORBIDDEN` — the asymmetry is deliberate and asserted |
| the unavailable UI names no key, count or presence word | the AVAILABLE render is asserted to contain exactly those words |
| controls disabled for a member | the same controls asserted ENABLED for an admin |
| the redactor removes the material | the report NAMES what it removed; a stale declaration that resolved nothing reports nothing |
| the message backstop replaces a leaking message | an innocent message is asserted to pass through unchanged |
| an unknown command redacts whole | a known one redacts only its declared paths, and the KEY survives |
| a system row carries no human | an agent row carries a human that DIFFERS from its actor |

The attribution cases use an **agent** principal deliberately: for a person the
pair legitimately coincides, so a suite run only as a human cannot distinguish a
correct implementation from a collapsed one.

## Mutation evidence — 4 applied, 4 killed, 0 invalid

Each verified before running: anchor matched exactly once, file hash changed,
grep-back confirmed the new text, only the target dirty, reverted atomically with
`git status --porcelain` checked empty after.

| mutant | file | killed by |
|---|---|---|
| the fail-closed arm → `return value` (the fail-open naive reading) | `redaction.ts` | 1 test: *FAILS CLOSED when a declared path resolves into a non-plain object* |
| `if (next !== out) redactedPaths.push` → unconditional push | `redaction.ts` | 2 tests, incl. *reports NOTHING when the declared path addressed nothing* |
| the gate call deleted from the derived router | `modules/settings/trpc.ts` | 5 tests in `wiring.test.ts` |
| the redactor bypassed in the trail | `modules/settings/audit.ts` | 5 tests across `audit.test.ts` + `wiring.test.ts` |

## Lanes

| lane | result |
|---|---|
| `bun run typecheck` (workspace) | **exit 0 — 23 successful, 23 total** (15 cached; cache hit is valid evidence per the corrected protocol rule) |
| in-package `bunx tsgo --noEmit` — `packages/commands`, `apps/server`, `apps/web` | exit 0 each. It caught a real error vitest could not see: an inferred default parameter narrowed `deps()` to `UserCommandPrincipal`, breaking every agent and system case in `authz.test.ts` |
| **full unit lane** — `apps/server` + `packages/{commands,model,runtime}` | **exit 0 — 301 files, 4390 passed, 1 skipped** (105s) |
| `packages/commands` settings + redaction (targeted) | 90 + 24 passed |
| `apps/server` settings family + router guard (targeted) | 110 passed, 6 files |
| `apps/web` settings | **75 passed, 9 files** |
| `bun scripts/check-boundaries.ts` | exit 0 — 56 allowlisted, 0 new |
| `bun scripts/rearch-audit.ts` | exit 0 — **29 items, 174 sites (baseline exact)** |
| `bun scripts/check-no-nul-bytes.ts` | exit 0 |
| `bun run audit:settings` (+ `--probe`) | exit 0 — the parser and all 5 checks found their planted fixtures |
| `bun run audit:client-secrets` (+ `--probe`) | exit 0 — **census 5 named sites → 1, 0 owned by POD-421** |
| `bun run audit:router-mutations` | exit 0 |
| `bun run migration:check` | Everything's fine |
| `bun run migration:manifest` | regenerated, committed |
| browser e2e, **admin** | **9 passed** |
| browser e2e, **member** (`PODIUM_E2E_ACCOUNT_ROLE=member`) | **8 passed** |

No red was observed in any lane this issue ran, so none of the run's known-red
list is being invoked.

`apps/web` is excluded from `vitest.unit.config.ts`, so its suites are run from
inside `apps/web` and the `Test Files`/`Tests` counts are quoted rather than the
exit code alone — a filtered run that matches nothing exits 0 with no counts.

## Decisions taken at forks (no human in the loop)

Resolved from `docs/adr/` then `docs/multi-user-readiness.md`; each is recorded
at its declaration site and in the commit that made it.

- **The preferences surface does not promise privacy.** The brief asked for copy
  saying that editing these affects nobody else. It is false on this build
  (item 5 of the exit audit), so it is not rendered; the surface states the
  declared class and what is true today, naming POD-1213. POD-352 backed this
  explicitly. An honest gap on screen gets fixed; a false promise gets believed.
- **The presence read is contracted, and `visibility: 'secret'` is widened to
  mean the class of state the command TOUCHES.** POD-420 left reads uncontracted
  because a visibility class names what a command WRITES. That reason does not
  hold here: what makes this surface dangerous is who may ISSUE it, and
  `roleFloor` is the field that says so. Recorded as a widening rather than
  slipped in.
- **The secret read fails closed at `admin`, and that is a placeholder.** O1 is
  open; closed is the only direction revisable without having already leaked.
- **Its refusal is `NOT_FOUND` with an absent-surface string, as ONE exported
  constant.** Two literals that match today are one edit from being an oracle.
- **The verb is derived from `policy.action`,** so the read is a query. The
  router guard's expectation was the literal `'mutation'` for every contract —
  true only by accident — and now fails on a wrong verb, a check it could not
  previously make.
- **The Telegram chat id is read-only.** A free-text address field configures
  delivery with no ceremony behind it: the operator fallback the brief forbids,
  arriving as a text box rather than as a code path.
- **`keys` and `integrations` are deleted, not emptied.** Their entire content
  was password inputs bound to blob members.
- **The audit trail has no product reader,** and that is what keeps item 5 from
  being widened by this issue. Recorded at the repository so the next person
  adding one meets the constraint rather than discovering it.
- **`PODIUM_E2E_ACCOUNT_ROLE` is a harness flag, not a product one.** A member
  cannot log in on this build; the alternative was an unverified refusing arm,
  which is how POD-391's CSWSH guard survived deletion with 20 green tests.

## What I deliberately did NOT do

- **No per-user preference storage.** POD-352 instructed it directly: filed as
  POD-1213, and POD-421 has a blocks dependency on it.
- **No answer to either open item.** O1 is failed closed and recorded; O2 is
  untouched.
- **No reader for the audit trail.** Adding one changes item 5's answer and would
  need gating and re-redaction first.
- **No repair of `settings.browser.e2e.ts`.** Its six tests were red on this
  branch before my first commit for the same TDZ reason (the shell did not boot)
  and are green again now — but I did not re-verify their own assertions beyond
  that, and they are POD-420's suite.
- **No change to POD-420's `PREFERENCE_REDACTION` cell.** Its reasoning is
  correct for credentials. The cross-user question it does not cover is item 5,
  which is POD-1213's.

## Diffstat against `issue/279-integration`

```
43 files changed, 11224 insertions(+), 221 deletions(-)
```

(11k includes 8 PNG screenshots. Source is ~2.6k added, ~220 deleted.)
