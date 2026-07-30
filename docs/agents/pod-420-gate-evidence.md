# POD-420 — secret + preference command contracts: gate evidence

Branch `issue/420-3-7c-secret-preference-command-contracts`, based on
`issue/279-integration`. No rebase, no merge of main or a sibling.

## The acceptance criteria, each one answered

| AC | Where | Verdict |
|---|---|---|
| **Preference writes: offline-eligible contracts** | `packages/commands/src/settings/contracts.ts` | met — `settings.updatePersonal` (`per-user-state`, member) and `settings.updateInstance` (`deployment-substrate`, admin), each `offline-eligible` with its own ARGUED reconciliation rather than one shared cell |
| **Secret writes: online-only, apply-time re-auth, confirmation class, never enqueued** | same file | met — `settings.setSecret` / `settings.clearSecret`: `visibility: 'secret'`, `resource: 'secret'`, `online-sensitive`, `confirmation: 'confirm'`, `roleFloor: 'admin'`, no `outbox` in exposure, no `machineVerb`, `ownership.creates` empty |
| **Contract classifications total** | `contracts.test.ts` | met — every one of POD-418's 39 classified leaves is writable by EXACTLY ONE preference command, and no secret path by either; asserted by iterating the shipped classification, not a hand list |
| **Offline attempt of a secret write refused, with surfaced UI state** | `write-plan.ts`, `save-settings.ts`, `SettingsView.tsx`, and `SettingsService.assertNoSecretChange` | met at three layers — see below |
| **Settings e2e green** | `tests/e2e/browser/settings.browser.e2e.ts` | 5 of 7, up from 0 of 7 (the suite could not START on the base). The 2 remaining are stale-spec drift disjoint from this diff, filed as POD-1204 and POD-1205 |

## The refusal, at three layers — and why one would not be enough

1. **The input schema.** A preference patch is addressed by CLASSIFIED PATH, so
   `{ 'apiKeys.openai': 'sk-…' }` is refused by `settings.updatePersonal`'s own
   schema before a handler exists — by two independent mechanisms (the tier check
   and POD-418's `settingsPathMayEnqueue` backstop), which is ADR 9 D4 point 2's
   shape. A blob-shaped partial would have needed a handler-side detector, and a
   detector that misses one key fails OPEN.
2. **The server.** `settings.set` now refuses a secret CHANGE outright, derived
   from `SERVER_SECRET_KEYS`. This is the layer that holds whatever a client
   does, because a client is not an authorization boundary.
3. **The client.** `planSettingsWrite` refuses an `online-sensitive` intent while
   offline BY CLASS and the save bar names the field. This exists so the refusal
   is EXPLAINED rather than experienced as a failed request.

**The assertion that matters is the CALL, not the message.** A client that
displayed an error and sent the request anyway satisfies a message-shaped test
perfectly, so `save-settings.test.ts` spies the mutations and asserts
`setSecret` is never called — paired with the online case that proves the same
call happens when it is allowed.

## Every refusal is paired with what it must NOT refuse

The dominant defect of this run is a suite that cannot say NO. The mirror trap
is a suite whose NO is satisfied by refusing everything, so each refusal here has
its positive control:

| refusal | the control that stops it being vacuous |
|---|---|
| offline + secret ⇒ refused | offline + preference ⇒ still ISSUED |
| online + secret ⇒ … | … is ISSUED, so the refusal above is not "never issues a secret" |
| unclassified path ⇒ refused | a classified path beside it ⇒ issued |
| `settings.set` refuses a changed secret | it ACCEPTS a blob whose secrets are unchanged — the shipped clients round-trip them, and a guard refusing every blob write would break the sidebar, the dialog and the engine |
| the preference patch schema refuses | it ACCEPTS a real personal path, asserted on the parsed OUTPUT (zod strips unknown keys and succeeds — POD-640) |
| `ONLINE_ONLY_SETTINGS_COMMANDS` | asserted NON-EMPTY: an empty set makes every "secrets are never queued" claim vacuously true |
| the running-router guard's absence claims | `describe('this guard can say NO')` plants both defects and requires each comparison to fire |

## Decisions taken at forks (no human in the loop)

Resolved from `docs/adr/` then `docs/multi-user-readiness.md`; full reasoning is
at each declaration site and in the commit messages.

- **One contract per matrix row.** `visibility` is required and single-valued, so
  a contract over the whole blob cannot be classified without lying about two
  thirds of what it writes. The two preference tiers stay apart because their
  visibility classes differ even where their delivery class does not.
- **Offline-eligibility ARGUED per tier, not inherited from the row's column**
  (POD-735's precedent). The test is what the write does while queued and when
  replayed late: a preference is inert — it arms nothing and executes nowhere.
  `autoContinue.enabled` is the member that gave pause and is still inert as a
  WRITE: it is a boolean the loop reads when it next runs, not a command that
  starts one, which is the D18.3 line. The two tiers carry different
  reconciliations (single-writer `(userId)` vs the only surviving field-LWW
  group), and a test asserts the texts are not the same object.
- **Exposure is `trpc` only, MEASURED.** `relay.ts` has no `settings` arm, there
  is no `podium settings` CLI verb and no settings MCP tool. Declaring one would
  be POD-385's defect.
- **`offline-eligible` and yet NOT exposed on `outbox`.** The class says "may be
  queued"; the exposure says "nothing queues it yet" — no client executor
  dispatches a settings write. `audit:settings` pins that, so the day one appears
  the decision is retaken deliberately rather than by accident. POD-419 owns the
  replica/outbox audit.
- **`clearSecret` is a separate command**, not `setSecret` with an empty value:
  `ServerSecret.value` is `.min(1)` and collapsing them would make
  `SecretPresenceWire.present` unable to mean anything.
- **`errorConsistency.callerSuppliedTargetId: false` on all four.** Both address
  spaces are CLOSED and public (39 classified paths, 5 secret keys) and every
  member exists on every instance, so there is no hidden entity for D20.2.
- **`settings.get` and the telegram ceremony are NOT contracted.** The read's
  payload changes shape under POD-419 and POD-421; the ceremony is a stateful
  pairing flow over a third-party API, and ADR 9 D8 says the inbound Telegram
  edge becomes an AUTHENTICATION surface under multi-user — a bigger question
  than this issue. Both are named BY KEY in `audit:settings`, so the exception is
  counted rather than assumed.
- **The fingerprint is domain-separated and NUL-framed.** Joining with a
  character the inputs can contain would make (`apiKeys.open`, `ai:x`) and
  (`apiKeys.openai`, `:x`) the same message — a canonicalisation collision.
- **The fingerprint key is PERSISTENT, not per-boot.** A per-boot key
  re-fingerprints everything on every restart, and a fingerprint that changes
  when nothing was rotated answers its one question with a lie.
- **The rotation time is returned but NOT persisted** — a recorded gap: the blob
  has nowhere to store it, and POD-419's keyed store is where `updatedAt` becomes
  durable. Returning the write time is truthful about what just happened.

## POD-386's settings guard, converted rather than deleted

It asserted that NO `*_CONTRACTS` table names a `settings.*` command. This issue
is #352's command-contract child, so that claim is now false by design — and the
conversion had to avoid turning a check that cannot pass into one that cannot
fail. Per the coordinator's two conditions:

- **Both directions and no ratchet relief kept.** Whole-map equality on names AND
  verbs, because an absorbed surface reads as progress on every ratchet.
- **Not loosened by deletion.** The contract half is an exact correspondence:
  every `settings.*` contract declaring `trpc` must be served as a mutation, and
  every served `settings.*` procedure must be a contract or one of three NAMED
  exceptions. `this guard can say NO` plants a settings write no contract names
  AND a contract the router does not serve, and survives POD-386's own mutant
  (deleting `settings.telegramSetupStart`) plus its contract-side twin.

## Mutation evidence — 4 applied, 4 killed, 0 invalid

Each verified before running: match confirmed by grep-back, hash changed, only
the target file dirty, it COMPILES, and the file's md5 restored after revert.

| mutant | file | killed by |
|---|---|---|
| HMAC key `serverKey` → `Buffer.alloc(32)` (the unkeyed defect) | `secret-fingerprint.ts` | 2 named tests: *CHANGES when the server key changes*, *persistence is what makes rotation detectable* |
| truncation `.slice(0, FINGERPRINT_BYTES * 2)` removed | `secret-fingerprint.ts` | *is 16 hex characters — the declared truncation* |
| `...settingsFamily` removed from the real router | `apps/server/src/router.ts` | `audit:settings` → `derived-spread` at `router.ts:598` |
| the `assertNoSecretChange` CALL removed from `setSettings` | `modules/settings/service.ts` | `audit:settings` → *the guard exists and guards nothing*, plus 4 named service tests |

## Lanes

| lane | result |
|---|---|
| `bun run typecheck --force` | exit 0 — `Tasks: 23 successful`, **`Cached: 0 cached, 23 total`** |
| in-package `bunx tsgo --noEmit` (commands, server, web) | exit 0 each |
| typecheck instrument probe | injected `const _probe: number = "not a number"` → **TS2322 REPORTED**, exit 1; reverted. It also caught a REAL error vitest could not see (`machineVerb` on a narrowed literal type) |
| `packages/commands` + `packages/model` + `packages/runtime` | 68 files, **1071 passed**, exit 0 |
| `apps/server` | 220 files, **3080 passed / 1 skipped**, exit 0 |
| `apps/web` + `packages/client-core` | 201 files, **1633 passed**, exit 0 |
| `scripts` | 27/28 files pass. The 1 failure is `loop-split-load.integration.test.ts` (p95 36.9ms vs a 25ms budget) — a NAMED known red under host load. Claimed **MECHANISTICALLY**: a latency assertion over a 588-session load simulation is disjoint from zod contracts, a settings service and an audit script |
| `scripts/check-boundaries.ts` | exit 0 — 56 allowlisted, 0 new |
| `scripts/rearch-audit.ts` | exit 0 — **25 items, 179 sites (baseline exact)**, unchanged before and after |
| `scripts/check-no-nul-bytes.ts` | exit 0 — **after it caught a real defect of mine**, see below |
| `audit:{issues,sessions,workflows,superagent,fleet,mail,automations,spec,settings,router-mutations,scoped-feed}` | exit 0, all eleven |
| `bun run audit:settings --probe` | the parser and all 5 checks found their planted fixtures |
| `migration:check` / `migration:manifest` | not run — **no migration, no schema change**. The secret still lives in the settings blob; POD-419 owns moving it |
| settings browser e2e | 5/7 (from 0/7 — the harness could not start) |

### The NUL-byte gate caught a real defect, and the symptom was silent

The first draft of the fingerprint wrote its MAC separator as a literal NUL byte.
That made `secret-fingerprint.ts` BINARY to `grep -n` — and two `grep -c` calls
on that file during this session returned nothing at all, which read as "no
matches" rather than "your instrument is refusing". The separator is kept (it
prevents a canonicalisation collision) and is now BUILT with
`String.fromCharCode(0)`, with the reasoning at the constant.

## What I deliberately did NOT do

- **No storage or schema change.** Secrets still live in the legacy blob and the
  presence projection is not yet served by a read. POD-419 owns the scrub;
  POD-421 owns the presence/fingerprint UI and the audit log. This issue ships
  the producer, the contracts and the refusal.
- **No contract for `settings.get`** — its payload changes shape twice under
  those two issues.
- **No contract for the telegram pairing ceremony** — named, counted, and left.
- **No outbox executor for the preference commands**, so the offline-eligible
  class is a declaration and not yet a queue. Landing one is POD-419's, and the
  audit will make it a deliberate decision.
- **No repair of the two remaining e2e reds** — POD-1204 (a strict-mode locator
  in a different spec file) and POD-1205 (a live-catalog expectation that fails
  before any save). Both filed with `discovered-from` edges rather than folded
  into this diff.

## Diffstat against `issue/279-integration`

```
 apps/server/src/modules/settings/registry.ts             | 120 +++++
 apps/server/src/modules/settings/secret-fingerprint.ts   | 173 +++++++
 apps/server/src/modules/settings/secret-fingerprint.test.ts | 169 ++++++
 apps/server/src/modules/settings/service.commands.test.ts   | 199 +++++++
 apps/server/src/modules/settings/service.ts              |  99 +++-
 apps/server/src/modules/settings/trpc.ts                 | 105 ++++
 apps/server/src/relay.test.ts                            |   8 +-
 apps/server/src/restart-notification-storm.integration.test.ts |   9 +-
 apps/server/src/router.settings-guard.test.ts            | 200 ++++---
 apps/server/src/router.ts                                |  33 +-
 apps/web/package.json                                    |   1 +
 apps/web/src/features/settings/SettingsView.tsx          |  60 ++-
 apps/web/src/features/settings/save-settings.ts          | 107 ++++
 apps/web/src/features/settings/save-settings.test.ts     | 158 ++++++
 apps/web/vite.config.ts                                  |   3 +
 docs/agents/pod-420-gate-evidence.md                     | (this file)
 docs/rearchitecture-v3.md                                |  61 +++
 package.json                                             |   1 +
 packages/commands/src/index.ts                           |  31 ++
 packages/commands/src/settings/contracts.ts              | 700 +++++++++++++++++++
 packages/commands/src/settings/contracts.test.ts         | 300 +++++++++
 packages/commands/src/settings/write-plan.ts             | 320 ++++++++++
 packages/commands/src/settings/write-plan.test.ts        | 260 ++++++++
 scripts/audit-settings-commands.ts                       | 520 ++++++++++++++++
 tests/e2e/browser/settings.browser.e2e.ts                |  14 +-
 tests/e2e/serve-harness.ts                               |   2 +-
```
