# POD-418 — settings model split: gate evidence

Branch `issue/418-3-7a-settings-model-split-preferences-vs`, based on
`issue/279-integration`. No rebase, no merge of main or a sibling.

## What landed against the acceptance criteria

| AC | Where | Verdict |
|---|---|---|
| **The model split lands** | `packages/model/src/settings/{preferences,secrets}.ts`; `packages/runtime/src/settings.ts` composes them | met — and it is a MOVE, not a parallel declaration: runtime re-exports the model bindings and `settings.classification.test.ts` asserts `toBe` identity per composed member |
| **Secret classification annotations total** | `packages/model/src/settings/classification.ts` — 39 leaves, derived by walking the split shapes | met — totality is enforced by three instruments of different kinds (derivation, reconciliation, backstop), each with a planted fixture proving it can say NO |
| **No wire projection carries secret material (test)** | `packages/model/src/settings/secrets.test.ts` | met — structural, key-name detector, and classification tie-back, each with a planted leak |

## The classification, in full

39 leaves: 24 `personal-preference`, 10 `instance-preference`, 5 `server-secret`.

| tier | matrix row | visibility | secret | replicates | may enqueue |
|---|---|---|---|---|---|
| `personal-preference` | `preferences-personal` | `per-user-state` | `preference` | yes | yes |
| `instance-preference` | `preferences-instance` | `deployment-substrate` | `preference` | yes | yes |
| `server-secret` | `server-secrets` | `secret` | `secret-value` | **no** | **no** |

Every column but `path` and `tier` is READ OFF the shipped matrix row, not
restated — so a matrix edit that weakened the secret row changes these answers
and reddens a named test.

The five secrets: `apiKeys.openrouter`, `apiKeys.anthropic`, `apiKeys.openai`,
`integrations.linearApiKey`, `notifications.telegramBotToken`.

## Decisions taken at forks (no human in the loop)

Resolved from `docs/adr/` then `docs/multi-user-readiness.md`; the full reasoning
is in the commit messages and at each declaration site.

- **`hibernation` → INSTANCE.** Machine resource policy; ADR 9 D3 rule 3 scopes
  machine facts to the machine. A per-user memory ceiling cannot be honoured.
- **`gitWorkflow` → INSTANCE.** Two merge styles on one repo is one repo with two
  histories — D3 rule 1's coordination-name reasoning applied to a workflow.
- **`autoContinue` → PERSONAL, keyed `(userId)`.** `promptDismissed` is exactly
  the `readAt`/snooze shape POD-351 and POD-731 warn about.
- **`experimental` → INSTANCE**, per its own matrix row's note.
- **`roles.*` → PERSONAL** (§3.1.6 S1). `accountId` is a REFERENCE, not material.
- **The fingerprint is a truncated HMAC under a server-held key, never a bare
  digest** — an unsalted hash of a short structured credential is brute-forceable
  and would make the "safe" wire field a slower spelling of the secret. Declared,
  not implemented: the model imports nothing but zod. POD-420 owns the producer.
- **`accounts.credential` is named as adjacent and NOT re-homed here** — a
  different matrix row with an open billing question (O5), which folding it in
  would answer by accident.

## Two defects the probes caught in my own first draft

Both the "detector covers one syntax form" shape, both recorded at the detector:

1. Matching the LEAF name missed `apiKeys.{anthropic,openai,openrouter}` — the
   leaves are provider names and the secretness lives in the PARENT. Three of the
   five real secrets were invisible while the check reported a clean wire. Fixed
   by matching the full dotted path, pinned by a both-arms assertion.
2. A `\bkey$` alternative fired on `SecretPresenceWire.key`, the join column.
   Fixed by dropping the alternative, not by adding an exclusion — an exclusion
   list is where a real leak eventually hides. The same reasoning renamed
   `SecretPresenceListWire.secrets` to `presence`.

## Mutation evidence — 3 applied, 3 killed, 0 invalid

Each verified before running: match count == 1, hash changed, grep-back, only the
target file dirty, and it COMPILES (in-package `tsgo` exit 0).

| mutant | file | killed by |
|---|---|---|
| `replicates: row.replication !== 'none'` → `replicates: true` | `settings/classification.ts` | 3 named tests (`reads replication and enqueue off the row…`, `refuses replication and enqueue for EVERY server secret…`, `classifies every secret key as never-replicated…`) |
| add `value: z.string()` to `SecretPresenceWire` | `settings/secrets.ts` | 4 named tests (`has no member of the stored secret except the join key`, `exposes exactly presence, fingerprint and rotation time`, `REJECTS a payload carrying the material…`, `makes fingerprint and updatedAt nullable but never ABSENT`) |
| add an unclassified `telemetry.uploadToken` leaf to the blob | `runtime/settings.ts` | 6 named tests, including `the two sets are equal` and `BREAKS when the blob grows a leaf no tier claims` |

Note the third: the leaf is secret-SHAPED and the reconciliation named it without
any secret-specific rule, which is the property that matters — the gate refuses an
unclassified leaf regardless of what it looks like.

## Lanes

| lane | result |
|---|---|
| `bun run typecheck --force` | exit 0 — `Tasks: 23 successful`, **`Cached: 0 cached, 23 total`** |
| in-package `bunx tsgo --noEmit` (model) | exit 0 |
| in-package `bunx tsgo --noEmit` (runtime) | exit 0 |
| typecheck instrument probe | injected `const _probe: number = "not a number"` → **TS2322 REPORTED**, exit 1; reverted |
| `packages/model` + `packages/runtime` | 49 files, 684 tests, exit 0 |
| `apps/server` | 216 files, 3033 passed / 1 skipped, exit 0 |
| `apps/web` + `packages/client-core` | 198/200 files pass; the 2 failures are 5s-timeout flakes under full-lane load — **isolated and both PASS alone** (`IssuePage.activity.test.tsx`, `IssuePage.agent-start.test.tsx`) |
| `scripts` | 24/25 files pass; the 1 failure is `loop-split-load.integration.test.ts` (p95 28.9ms vs a 25ms budget) — a NAMED known red under host load. Claimed **MECHANISTICALLY**, not measured: a latency assertion over a 588-session load simulation is disjoint from a zod schema move. `visibility-mutability-inventory.test.ts` passes. |
| `scripts/check-boundaries.ts` | exit 0 — 56 allowlisted, 0 new |
| `scripts/rearch-audit.ts` | exit 0 — **25 items, 186 sites (baseline exact)**, unchanged before and after |
| `scripts/check-no-nul-bytes.ts` | exit 0 |
| `scripts/audit-{issue,session,workflow}-commands.ts` | exit 0, all three |
| `biome check` on the touched files | clean. The 6 remaining errors under `packages/model/src/fields` are pre-existing in files this issue does not touch |
| `migration:check` / `migration:manifest` | not run — **no migration, no schema, no storage change**. The split is model shapes only. |

## What I deliberately did NOT do

- **No storage or wire change.** The secrets are still in the blob and still
  round-trip to clients. POD-419 owns the client scrub; POD-420 owns the command
  contracts. This is the model they both read.
- **No command contracts.** No `packages/commands` tenant, no `SERVED_NOWHERE`
  declarations, no audit script — POD-420's half, and shaping it here would be
  designing the thing that issue exists to decide.
- **No registry entries.** `representations/registry.ts` is scoped to the 26
  session + 17 issue representations POD-364 enumerated, and its membership is a
  pinned literal count; adding settings entries would be editing another issue's
  ratchet.
- **`accounts.credential` not re-homed** — see the decisions above.

## A note on the diff's size, and one thing I undid

`biome check --write` on the touched files also reformatted `annotations/matrix.ts`
(613 reflowed lines) and re-sorted the whole `index.ts` barrel — for a semantic
change of three `sites` entries and one export block. Both files are edited by
every sibling in this fan-out, so that churn is pure merge conflict. Reverted to
the integration base and re-applied by hand: `matrix.ts` +16/-3, `index.ts` +11/-0.
The pre-existing formatting debt in those two files is left where it was.

Final diffstat against `issue/279-integration`:

```
 docs/agents/pod-418-gate-evidence.md               | 111 ++++
 packages/model/src/annotations/matrix.ts           |  16 +-
 packages/model/src/fields/per-user-key.test.ts     |  63 +++
 packages/model/src/fields/per-user-key.ts          |  35 +-
 packages/model/src/index.ts                        |  11 +
 packages/model/src/settings/classification.test.ts | 248 +++++++
 packages/model/src/settings/classification.ts      | 301 ++++++++
 packages/model/src/settings/preferences.ts         | 305 ++++++++
 packages/model/src/settings/secrets.test.ts        | 239 ++++++
 packages/model/src/settings/secrets.ts             | 251 ++++++
 packages/runtime/src/settings.classification.test.ts | 216 +++++
 packages/runtime/src/settings.ts                   | 256 +++---
```
