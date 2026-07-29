# Entity-id and composite-key inventory (POD-360)

**Characterization deliverable for POD-301's branded-id chain.** Written against the code at
`issue/279-integration`, 2026-07-30. Companion to the golden wire fixtures in the same issue.

This is the map that **POD-361** (branded model schemas), **POD-362** (server + daemon adoption)
and **POD-363** (client + CLI adoption) execute against, and the site list that **POD-1075** (user
accounts + identity model) and **POD-1076** (per-user state family) work from instead of a grep.

> ## ZERO-BEHAVIOUR-CHANGE CONTRACT
>
> **POD-360 changes no id, no key, no schema and no behaviour.** Its whole diff is additive: new
> fixture files, one new test, two new scripts, two `package.json` script entries, and this
> document. No existing source file is edited — deliberately, because POD-299 is concurrently
> moving `packages/domain` into `packages/model` in another worktree and an edit to shared source
> would be a merge conflict bought for nothing.
>
> The contract this issue *establishes* for its successors is stronger and is what the fixtures
> enforce:
>
> **Branding is a compile-time construct, so the wire must not move.** `SessionId` is
> `string & { brand }`. It serializes as the same string, parses from the same string, and occupies
> the same bytes. POD-361/362/363 may change types freely and must change the wire **not at all**.
> A branded schema that transforms, normalizes, pads, trims or re-types its input has broken the
> contract, and `packages/protocol/src/wire-golden.test.ts` fails when it does.

---

## 0. How completeness was established

A grep over this repository is necessary and **provably insufficient**, so three independent
methods were used and cross-checked.

| Method | What it establishes | Evidence |
|---|---|---|
| **TypeScript AST sweep** — `bun run inventory:ids` (`scripts/id-inventory-sweep.ts`) | The site list. Parses **1571** `.ts`/`.tsx` files with the TypeScript compiler API and reports declaration, comparison and composite-key sites. | 11 325 sites; per-class counts in §3. Committed snapshot: `docs/rearch-id-inventory.sites.tsv`. |
| **NUL-byte guard** — `bun run lint:no-nul` | That the grep blind spot is *real on this branch*, and that the AST walk is not subject to it. | See §0.1 — one file on this base is binary to `grep`, and the AST walk swept it anyway. |
| **Type checker** — `bun run typecheck` (tsgo, per-package) | That the sweep's file set is the file set the build actually compiles, and that nothing in this issue's additions is type-invisible. | Green; output in the handoff. |

### 0.1 The grep blind spot, measured on this base

`packages/client-core/src/engine/engine.ts` (78 KB of client engine) carried **two literal NUL
bytes**, both inside the `recentFiles` composite-key template at **`engine.ts:1183`**:

```
const key = (e) => `${e.worktreePath}<NUL>${e.path}<NUL>${e.artifact?.artifactId ?? ''}`
```

One NUL makes the whole module **binary** to line-oriented tools. Measured on this base:

```
$ grep -c "sessionId" packages/client-core/src/engine/engine.ts
0                                    # exit 1 — "no match", for a file full of sessionId
```

It does not error. It answers *no match*. Any grep-based sweep of this branch silently skipped the
file — the same failure class as POD-758 (`packages/sync/src/ledger.ts`) and POD-296
(`scripts/architecture-manifest.ts`).

**The AST walk swept it anyway** and found all three of its composite-key sites — `engine.ts:818`,
`:865`, `:1183` — because the TypeScript parser reads bytes, not lines. Each was then **read by
hand** to confirm the sweep's classification, which is how the error above was caught: the sweep's
snippet renders a raw NUL invisibly, so `:1183` initially read as a *space*-separated key. It is
NUL-separated — the safe choice, not a bug.

**Base-vs-integration note.** The coordinator fixed this on `issue/279-integration` in commit
`3d31eee7` by writing the separator as a `\u0000` **escape** (runtime behaviour unchanged, so
`golden/*.json` is unaffected — this key is client-internal and not on the wire). This worktree
branched before that commit, so the measurement above is of the *unfixed* file; the site list is
identical either way, since the AST walk never depended on the fix. `bun run lint:no-nul` is the
standing guard, and it is a blocking CI job in its own right.

Two notes on honesty of the numbers:

- The sweep **deliberately over-reports**. A correlation id (`requestId`, `clientId`,
  `transitionId`) and an entity id (`sessionId`) are indistinguishable by name, so the script flags
  both and marks the **603** correlation-shaped sites; deciding which is which is the human
  judgement recorded in §3.4, not something the script pretends to do.
- The composite-key detector requires the template literal to be **consumed as a key** (a map
  key, an index, a `*Key` binding or a `*Key(…)` argument). Without that test it reported 187 hits,
  almost all `console.log` lines. It is deliberately **not** gated on an id-ish part name — the
  brief's canonical example, `session-identity.ts`'s `${resume.kind}:${resume.value}`, names
  neither part `*Id`, and an inventory that missed the site it was told about would be worthless.

**Known limit, stated rather than hidden.** The composite-key test recognises the key-shaped
contexts listed above. A key built by `array.join(sep)`, by string concatenation with `+`, or
passed straight into a function whose name does not end in `Key`, is not detected. §3.3 therefore
lists the 70 detected sites *and* the hand-verified additions; POD-361 should re-run the sweep
after its helper lands and treat a shrinking count as the ratchet.

---

## 1. The golden wire fixtures

| Where | What |
|---|---|
| `packages/protocol/src/wire-golden.test.ts` | The suite. Runs in the **unit lane**, so in CI on every PR (`ci.yml` → `unit-tests` → `bun run test:unit`; the root vitest node project collects `packages/**/*.test.ts`). Not merely committed — *run*. |
| `packages/protocol/src/__fixtures__/golden/*.json` | The committed corpus: **27 families, 1 067 cases**. |
| `packages/protocol/src/__fixtures__/sampler.ts` | Deterministic zod→sample walker. No randomness, no clock. Scalars are derived from their own path, so a golden file reads as documentation of the wire shape. |
| `packages/protocol/src/__fixtures__/registry.ts` | The covered surface: **every zod schema every protocol module exports**, grouped by module. |
| `packages/protocol/src/__fixtures__/feature-state.ts` | `FeatureState`, the one family the walker cannot reach (a TS interface + a pure resolver, not a schema). |
| `bun run fixtures:wire:update` | Regenerate, then **read the diff**. |

### 1.1 Why coverage is a mechanical fact rather than a list

Families are the protocol's own module split and every exported schema in each module gets
fixtures, so a new message type appears in the corpus the next time it is regenerated — and CI
fails until someone regenerates and looks at the diff. Three assertions hold the line:

1. **Export-surface equality** — the corpus and the set of exported zod schemas must be the *same
   set*, not a matching count. A count would just get updated.
2. **Aggregate-union arm coverage** — every arm of `ClientMessage` (16), `ServerMessage` (27),
   `DaemonMessage` (52), `ControlMessage` (44), `DaemonHandshake` (2) and `DaemonHandshakeReply`
   (4) — **145 arms, all carrying a `type` literal** — must be covered by a fixture, matched on
   the wire `type` literal rather than the schema name (they differ often enough —
   `SessionOpenUrlMessage` vs `sessionOpenUrl` — that name matching would quietly pass).
3. **Wire transparency** — `parseChanged` must be empty for every case. Verified: **0 of 1 067**
   cases have a non-empty `parseChanged` today.

*The gate was negative-tested*: removing one module from the registry fails four assertions,
naming the uncovered arms. Mechanism presence is not coverage, so the mechanism was made to fail.

### 1.2 Families the acceptance criteria name, and where they are

| Family | Golden file | Confirmed present |
|---|---|---|
| Handoff — 7 message types + `HandoffManifest` | `handoff.json` | all 8 |
| Browser-open — `SessionOpenUrl/Result/UrlCallback/UrlDismiss` + `BrowserOpenCallbackTarget` + `BrowserOpenIntent` | `browser-open.json` | `intent`, `callbackTarget` |
| `SessionResumeRefAckMessage` [spec:SP-fccf] | `terminal.json` | `sessionResumeRefAck` |
| `AutomationWire` / `AutomationRunWire` — `scheduleKind` cron\|once, `runAt`, `targetSessionId`, all 4 run outcomes | `automations.json` | `scheduleKind`, `targetSessionId` |
| approvals `automation-schedule` op member (all 3 target arms) | `approvals.json` | `"automation-schedule"` |
| `FeatureState` | `feature-state.json` | 12 flags × 36 input combinations = 432 cases |
| `DaemonAck` `ackRequested` (`SessionResumeRefMessage.ackRequested`) | `daemon.json` | `ackRequested` |
| Issue additive fields — `color`, `needsHuman`, `humanQuestion`, `humanQuestionOptions`, `humanQuestionAskedBy`, `humanQuestionAskedAt` | `issues.json`, `sync.json` | all |
| Session additive fields — `workingMsTotal`, `agentColor` | `runtime-state.json`, `issues.json`, `sync.json`, `mutations.json` | both |
| Machine / host families | `host.json` | `MachineWire`, `HostMetricsWire`, `MachineQuotaWire`, `AgentQuotaWire` |

### 1.3 These fixtures are the acceptance evidence for POD-1075 and POD-1076

Stated here because it is a requirement of this deliverable, not an inference:

**The fixture set is the additive-change evidence for POD-1075 (user accounts + identity model)
and POD-1076 (per-user state family), not only for the branded-id flip.** Both are required to be
additive at the wire. These fixtures are how that is proved rather than asserted.

The diff is legible enough to tell an **added** field from a **changed** one because each case
records the two separately:

| Field in a case | Reads as |
|---|---|
| `wire` — pretty-printed, one field per line | A schema gaining a field ⇒ **a new line appears** in the `full` variants. A field changing shape ⇒ **a line changes in place**. The two are visually distinct in a unified diff. |
| `parseAdded` — paths present after parse, absent from the wire | What the schema **defaults in**. A new *defaulted* field (the usual shape of an additive column) shows up here as one new entry, in the `minimal` variant, with its default value visible. |
| `parseChanged` — paths whose value parse **rewrote** | Must stay empty. A non-empty entry is a transparency break, and the suite fails on it. |
| `parseDropped` | Fields the schema stripped. |
| `encoded` — the serialized bytes of the parsed value | The byte anchor. A moved `encoded` line **under an unchanged `wire` tree** means serialization changed while no value did — precisely the accident a branded-id flip could introduce, and the one a value-level test would miss. |

Each schema is sampled in a `minimal` variant (optionals omitted — so defaulting is what gets
characterized) and a `full` variant (every optional populated — so an added optional field is
visible), plus one `full` variant per union arm. That split is what makes the added-vs-changed
distinction mechanical instead of a matter of reading carefully.

---

## 2. Owner categories

Every site below carries exactly one owner. Categories **A–D** are the flip classification;
category **E** is the multi-user addition.

| Owner | Meaning | Who executes |
|---|---|---|
| **A — schema flip (mechanical)** | A `z.string()` that becomes a branded schema; the change is the schema line and the type errors it surfaces. | POD-361 declares, POD-362/363 absorb |
| **B — helper adoption** | An ad-hoc composite key that adopts a typed key helper. Injective only while no part contains the separator; the helper makes that true for every input. | POD-361 (API) → POD-362/363 (adoption) |
| **C — genuinely stringly-typed, on purpose** | A wire boundary, a SQL parameter, a log line, a correlation handle. Stays a string; the brand is *unwrapped* here, deliberately. | POD-362/363, as `asXId()` / plain-string boundaries |
| **D — placeholder identity or hand-restated definition** | Not to be branded. POD-279 **deletes** it. Branding it would preserve the thing the epic exists to remove. | the owning phase issue, named per site |
| **E — attribution site** | Names *who acted*. Under multi-user it **gains a second value** (on-behalf-of, a `UserId`) rather than changing type. Enumerated here; **not touched** by POD-360 or POD-361. | POD-1075 |

---

## 3. The inventory

### 3.1 The brand set as it stands today

`packages/protocol/src/ids.ts` already carries the P1-additive brand set and, notably, the two
composite-key helpers the brief names — landed but **with zero adoption**, which is exactly the
"mechanism presence is not coverage" shape POD-361 has to close.

| Brand | Line | Adopters today |
|---|---|---|
| `MachineId` | `ids.ts:18` | none |
| `SessionId` | `ids.ts:22` | none |
| `IssueId` | `ids.ts:26` | none |
| `RepoId` | `ids.ts:30` | none |
| `ConversationId` | `ids.ts:34` | none |
| `MutationId` | `ids.ts:38` | none |
| `ThreadId` | `ids.ts:42` | none |
| `machineScopedKey` / `parseMachineScopedKey` | `ids.ts:95` / `ids.ts:99` | **none** — the successor to `${machineId}\n${nativeId}`, adopted nowhere |
| `resumeKey` / `parseResumeKey` | `ids.ts:111` / `ids.ts:118` | **none** — the successor to `${resume.kind}:${resume.value}`, adopted nowhere |

**Absent from the brand set: `UserId`.** See §4 — POD-1075 requires it to travel *through* this
inventory and these fixtures, not to arrive beside them.

Also absent, and worth naming so POD-361 decides rather than discovers: there is **no brand for
`nativeId`** (the provider-side conversation id that `machineScopedKey` scopes), none for
`AutomationId`, `ApprovalId`, `WorkflowRunId`, `AccountId` or `ArtifactId`, all of which exist as
entity ids on the wire today. `ids.ts`'s set is narrower than the wire's.

### 3.2 Owner A — schema flip (mechanical)

**467 zod id-field sites.** Full list with `file:line`:
`docs/rearch-id-inventory.sites.tsv` (filter `kind == zod-field`).

| Package | Sites | Note |
|---|---|---|
| `packages/protocol` | 274 | The wire. POD-300 moves entity schemas out to `packages/model` first, so POD-361 lands on the moved schemas — **not** on these paths. |
| `apps/server` | 184 | tRPC/command input schemas. |
| `packages/runtime` | 5 | |
| `packages/issue-client` | 4 | |

**127 SQL column sites** (`apps/server/src/migrations/schema.ts`) — drizzle `text()` columns. A
brand is a TypeScript construct; the column type does not change. These are owner **C** at the
storage boundary unless POD-361 adopts drizzle's `$type<>()`, which is a decision it should record
either way.

**1 333 TS property sites** and **1 183 identity comparisons** are the *consequence* surface: a
branded flip turns each mismatched comparison into a type error, which is the mechanism by which
the flip finds its own call sites. Counted, not enumerated — they are reproducible from the script
and a 1 183-row table would be read by nobody.

**The handoff ids the brief names**, all owner A, all still `z.string()`:

| Site | Field | Becomes |
|---|---|---|
| `packages/protocol/src/messages/handoff.ts:7` | `HandoffManifest.sessionId` | `SessionId` |
| `packages/protocol/src/messages/handoff.ts:13` | `HandoffManifest.repoId` | `RepoId` |
| `packages/protocol/src/messages/handoff.ts:39` | `HandoffManifest.issueId` | `IssueId` |
| `packages/protocol/src/messages/handoff.ts:40` | `HandoffManifest.sourceMachineId` | `MachineId` |
| `packages/protocol/src/messages/handoff.ts:48` | `HandoffExportRequestMessage.sessionId` | `SessionId` |
| `packages/protocol/src/messages/handoff.ts:59` | `HandoffExportRequestMessage.repoId` | `RepoId` |
| `packages/protocol/src/messages/handoff.ts:61` | `HandoffExportRequestMessage.issueId` | `IssueId` |
| `packages/protocol/src/messages/handoff.ts:62` | `HandoffExportRequestMessage.sourceMachineId` | `MachineId` |
| `packages/protocol/src/messages/handoff.ts:95` | `HandoffImportChunkMessage.sessionId` | `SessionId` |
| `packages/protocol/src/messages/handoff.ts:110` | `HandoffImportRequestMessage.sessionId` | `SessionId` |

`HandoffManifest.format: z.literal(1)` is a **versioned** wire package written to disk and moved
between machines. Its fixtures (`golden/handoff.json`) are therefore load-bearing in a second way:
a manifest is read by a *different build* than wrote it.

### 3.3 Owner B — helper adoption (composite keys)

**70 detected sites.** The named ones first.

| Site | Key | Owner |
|---|---|---|
| `packages/sync/src/mirror.ts:128` | `` `${machineId}\n${nativeId}` `` | B → `machineScopedKey` |
| `packages/sync/src/mirror.ts:166` | `` `${machineId}\n${item.nativeId}` `` | B → `machineScopedKey` |
| `packages/sync/src/mirror.ts:205` | `` `${machineId}\n${item.nativeId}` `` | B → `machineScopedKey` |
| `apps/server/src/transcript-indexer.ts:79` | `` `${machineId}\n${nativeId}` `` | B → `machineScopedKey` |
| `apps/server/src/transcript-indexer.ts:94` | `` `${machineId}\n${nativeId}` `` | B → `machineScopedKey` |
| `apps/server/src/transcript-indexer.ts:116` | `` `${machineId}\n${s.nativeId}` `` | B → `machineScopedKey` |
| `apps/server/src/transcript-indexer.ts:140` | `` `${machineId}\n${nativeId}` `` | B → `machineScopedKey` |
| `apps/server/src/search.ts:173` | `` `${t.machineId}\n${t.nativeId}` `` | B → `machineScopedKey` |
| `packages/domain/src/session-identity.ts:69` | `` `${session.resume.kind}:${session.resume.value}` `` | B → `resumeKey` |
| `packages/domain/src/session-identity.ts:74` | `` `${s.resume.kind}:${s.resume.value}` `` | B → `resumeKey` |

**The brief named `mirror.ts` and `session-identity.ts`. The sweep found five more machine-scoped
sites** — four in `transcript-indexer.ts` and one in `search.ts` — using the *same* `\n`
separator and therefore sharing the same collision surface and the same in-memory key space. A
POD-362 that adopted the helper in `mirror.ts` alone would leave four sites minting keys that are
byte-identical for benign inputs and divergent for hostile ones. That is the class of half-migration
this programme exists to end, so all eight machine-scoped sites move together or none do.

Remaining detected sites, by disposition:

**B — real composite keys over entity identities:**

| Site | Key |
|---|---|
| `packages/sync/src/ledger.ts:66` | `` `${entity}\u0000${id}` `` — already NUL-separated *via the escape*, per POD-758 |
| `apps/daemon/src/browser-open.ts:138` | `` `${sessionId}:${requestId}` `` |
| `apps/web/src/app/BrowserOpenOverlay.tsx:16` | `` `${request.sessionId}:${request.requestId}` `` — the client half of the same key; must stay byte-equal to the daemon's |
| `apps/server/src/modules/messages/service.ts:337` | `` `${target.kind}:${target.id}` `` |
| `apps/server/src/modules/messages/service.ts:764`, `:1146`, `:1997` | `` `${senderKey}\|${issueKey ?? …}` `` — nested key-of-a-key |
| `apps/server/src/modules/issues/service/core.ts:311` | `` `${issueInputsGen}\u0000${prefix}\u0000${memberKey}` `` |
| `apps/server/src/repo-discovery.ts:157` | `` `${machineId}\0${atPath}\0${deep}` `` |
| `packages/client-core/src/engine/engine.ts:818` | `` `${session.sessionId}\n${session.lastActiveAt}` `` — **in the NUL-bearing file** |
| `packages/client-core/src/engine/engine.ts:865` | `` `${issue.id}\n${issueActivityAt(…)}` `` — **in the NUL-bearing file** |
| `packages/client-core/src/engine/engine.ts:1183` | `` `${e.worktreePath}\u0000${e.path}\u0000${e.artifact?.artifactId ?? ''}` `` — the `recentFiles` key; **this template is where the two literal NUL bytes lived** (see §0.1) |
| `packages/client-core/src/viewmodels/file-scope.ts:11` | `` `a:${scope.issueId}:${scope.artifactId}` `` |
| `packages/client-core/src/viewmodels/tray.ts:38` | `` `${sessionId}@${createdAt}` `` |
| `packages/client-core/src/viewmodels/derive.ts:175` | `` `__no_remote__:${r.machineId ?? ''}:${r.path}` `` — a sentinel prefix *and* a composite key |
| `apps/web/src/features/machines/quota.ts:113`, `:114` | `` `${agent.agent}::${email}` `` / `` `${agent.agent}::machine:${machine.machineId}` `` |
| `apps/web/src/features/superagent/TrayCard.tsx:33` | `` `${item.kind}:${item.issue.id}` `` |
| `apps/server/src/steward.ts:582`, `:593`, `:678`, `:818`, `:996` | steward dedup keys over `parentId`/`seq`/`subject` |

**C — composite keys over things that are not entity ids** (no brand applies; listed so POD-361
does not spend time on them): `apps/daemon/src/agent-relay.ts:48` (router.proc),
`apps/daemon/src/quota-claude.ts:91`, `apps/daemon/src/usage-scan.ts:51`,
`apps/server/src/modules/messaging/service.ts:114`, `:210`, `:254` and
`apps/server/src/modules/notify/service.ts:44` (Telegram bot token + chat id — note **these three
are a secret-bearing key**, see §4), `apps/web/src/app/theme.tsx:97`,
`apps/web/src/features/files/{Html,Markdown}FilePanel.tsx`,
`apps/web/src/features/terminal/use-warm-set.ts:22`,
`packages/agent-bridge/src/agent-state/codex.ts:1702`,
`packages/agent-bridge/src/discovery/git/scanner.ts:343`,
`packages/agent-bridge/src/discovery/scanner.ts:335`,
`packages/client-core/src/replica/replica.ts:1368`,
`packages/client-core/src/viewmodels/chat.ts:223`, `packages/transcript/src/slice.ts:478`,
`scripts/architecture-manifest.ts:643`.

Test and e2e-harness sites (13, all owner C — they exercise the production key, they do not define
one): `apps/server/src/modules/issues/git-state{,-service}.test.ts`,
`apps/server/src/modules/issues/service/test-plumbing.ts:74`,
`apps/server/src/modules/sessions/read-toolkit.test.ts:67`/`:69`,
`apps/web/test/features.structure.test.ts:121`, and 12 `tests/e2e/browser/*.browser.e2e.ts` tRPC
URL builders. `packages/protocol/src/__fixtures__/sampler.ts:375` is this issue's own path
builder — owner C.

### 3.4 Owner C — genuinely stringly-typed, on purpose

- **603 correlation-shaped sites** flagged by the sweep: `requestId`, `clientId`, `transitionId`,
  `rebindId`, `segmentId`, `predecessorSegmentId`. These name a **request**, a **connection** or a
  **causal edge**, not a durable entity, and must not be given entity brands. They are already
  distinguished in the TSV by the `correlation` column, so POD-361 can subtract them without
  re-deciding.
- **The `encode()` / `parse*()` boundary** (`packages/protocol/src/messages/codec.ts`) — the point
  at which a brand *must* be unwrapped. Brands are erased by `JSON.stringify`, which is the whole
  contract; no work here, but it is the site where a mistake would be invisible without §1's
  fixtures.
- **SQL parameters** — every `.prepare(…).run(id)` / drizzle `.where(eq(col, id))`. The driver
  takes a string. Branded values pass structurally; nothing to change.
- **Log lines and agent-facing text** — the ~117 template literals the tightened detector correctly
  *dropped*. A log line interpolating an id is not a key.
- **Human-facing reference ids** (`packages/protocol/src/refs.ts`) — `POD-13`, `POD-13-A`,
  `POD-DRAFT-3`. A deliberately separate namespace from the internal join key; `refs.ts` is pure
  and dependency-free by design. **Not** an entity-id brand target; if anything it argues for its
  own `DisplayRef` brand, which is a POD-361 call to record rather than a POD-360 finding.

### 3.5 Owner D — placeholder identity / hand-restated definition (DELETE, do not brand)

The category the epic cares about most. Each site names an identity that POD-279 removes.

**D1 — the `'__local__'` machine placeholder. Owner: POD-318.** 13 live sites, already ratcheted by
`bun run audit:rearch` (`local-placeholders`, baseline 12 → **now 13** — grown, and grown on the
base, not by this issue).

| Site | Text |
|---|---|
| `packages/runtime/src/local-machine.ts:19` | `export const LOCAL_PLACEHOLDER = '__local__'` — the definition |
| `apps/server/src/modules/issues/service/workflow.ts:185` | `machine: spawned.machine ?? row.machineId ?? '__local__'` |
| `apps/server/src/modules/sessions/session.ts:409` | `this.machineId = init.machineId ?? '__local__'` |
| `apps/server/src/store/conversations.ts:146` | `r.machineId ?? '__local__'` |
| `apps/server/src/store/conversations.ts:282` | `UPDATE conversations SET machine_id = ? WHERE machine_id = '__local__'` |
| `apps/server/src/store/repos.ts:197` | `addRepo(path, machineId = '__local__', …)` |
| `apps/server/src/store/repos.ts:295` | `deriveRepoId({ machineId: '__local__', … })` — a placeholder **inside a derived stable id** |
| `apps/server/src/store/repos.ts:298` | `removeRepo(path, machineId = '__local__')` |
| `apps/server/src/store/repos.ts:311` | `UPDATE repos SET machine_id = ? WHERE machine_id = '__local__'` |
| `apps/server/src/store/repos.ts:368` | `INSERT … VALUES ('__local__', …)` |
| `apps/server/src/store/sessions.ts:102` | `(r.machine_id as string \| null) ?? '__local__'` |
| `apps/server/src/store/sessions.ts:226` | `row.machineId ?? '__local__'` |
| `apps/server/src/store/sessions.ts:293` | `UPDATE sessions SET machine_id = ? WHERE machine_id = '__local__'` |

Also `apps/server/src/migrations/schema.ts:42` — `machineId: text("machine_id").default("__local__").notNull()`, the placeholder baked into the **column default**, which is why the adoption sweeps above exist at all.

**Branding `MachineId` would make `'__local__'` a well-typed `MachineId`** and freeze the
placeholder into the type system. POD-361 must not brand these sites ahead of POD-318; if it
brands `MachineId` first, `asMachineId('__local__')` is the *only* acceptable form and each such
cast is a POD-318 to-do marker, not a conversion.

**D2 — `LOCAL_MACHINE_ID = 'local'`** — `packages/runtime/src/local-machine.ts:13`, 11 call sites.
Distinct from D1 and **not** deleted: it is a real machine identity (the host the server runs on).
But per `docs/multi-user-readiness.md` §3.1.4 **M4** it is the sharpest multi-user case — when the
server runs on someone's Mac, the `local` daemon *is* that Mac, and without an owner anyone who
can authenticate inherits execute on it. So D2 is owner **A** for the flip (it is a `MachineId`)
and a **POD-1075 site** for ownership. Recorded here because the two are easy to conflate.

**D3 — `OPERATOR`, the single-operator capability.** `packages/domain/src/issue-authz.ts:47`:
`export const OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }`, documented as "the
cookie-authed human … is unconstrained". This is the *hand-restated identity* multi-user replaces:
per §3.2 of the readiness doc there is no user identity anywhere in the model, and `OPERATOR` is
where that assumption is written down as a value. **Owner: POD-1075.** Not branded, not extended —
replaced by a real principal `(user, device, capability)`.

**D4 — hand-restated field definitions and capability tables**, already ratcheted:
`capability-tables` (owner POD-325, baseline 4 → now **5**) —
`packages/protocol/src/messages/terminal.ts:58` `AGENT_CAPABILITIES`,
`packages/agent-bridge/src/harness/registry.ts:16`,
`packages/runtime/src/settings.ts:34` `HARNESS_MCP_SUPPORT`,
`apps/server/src/modules/superagent/service.ts:70` `RESUME_KIND`,
`apps/server/src/modules/superagent/harness-error.ts:36` `PROVIDER_LABEL`. These fold into the
harness manifests; **`RESUME_KIND` is the one that matters to this inventory** because it is a
second, hand-maintained statement of the resume-ref vocabulary that `resumeKey` keys on.

**D5 — `reexport-shims`** (owner POD-333, baseline 19 → now **24**), including
`apps/server/src/local-machine.ts` — a pure re-export of the D1/D2 definitions. It disappears with
the shim, so POD-362 should import from `@podium/runtime/local-machine` directly rather than
brand the shim.

### 3.6 Owner E — attribution sites that must learn to name a person

Per readiness §3.2, **every attribution field in the system today is device-level or role-level**.
Per §3.1.3 **A3**, attribution becomes a **pair**: **actor** (which agent — the existing
`Capability.actorSessionId` seam, a `SessionId`) and **on-behalf-of** (which human — a `UserId`).

**None of these is changed by POD-360 or POD-361.** They are enumerated so POD-1075 works from a
list.

| # | Attribution site | Storage | Wire | Today's value | POD-1075 |
|---|---|---|---|---|---|
| E1 | `humanQuestionAskedBy` | `schema.ts:461` `human_question_asked_by` text | `IssueWire.humanQuestionAskedBy` (`issues.ts:236`) | a bare **session id**, server-authoritative (`registry.ts:1204-1209`: an explicit `askedBy` must equal the authenticated `actorSessionId`) | + on-behalf-of `UserId`. The server-authoritative check is the model for the rest: A3's rule is "stamped from the transport principal, never from payload", and this field already implements it. |
| E2 | `deletion_source` | `schema.ts:55` `deletion_source` text | not on `SessionMeta` | freeform source string | + actor/on-behalf-of pair |
| E3 | `nameSource: 'user'` | `schema.ts:60` `name_source` text | `SessionMeta.nameSource` (`runtime-state.ts:341`), `'user' \| 'agent'` | a **role class**, not a person. `'user'` outranks `'agent'` ([spec:SP-eb60]) — the precedence rule A3 says must survive | `'user'` gains *which* user. The precedence rule is what makes collapsing the pair lossy. |
| E4 | close actor | `podium_events.payload` (`schema.ts:300`) | event payload `causedBySessionId` | a **session id**, threaded from `Capability.actorSessionId` (`crud.ts:450-462`, `:816-817`) | + on-behalf-of. Used today only to let the steward skip nudging the causing session (#116); under multi-user it is also *who closed it*. |
| E5 | unblock actor | same | `issue.ready` payload `causedBySessionId` (`crud.ts:190-204`) | same | same |
| E6 | reopen / stage-change actor | same | `issue.reopened`, `issue.stage_changed` payload `causedBySessionId` (`crud.ts:425-447`) | same | **Not named in the brief; found by the sweep.** Same shape, same seam, same fix — listed so POD-1075's list is the *whole* family rather than the four that were remembered. |
| E7 | `startedBySession` | `schema.ts` (`issues`) | `IssueWire.startedBySession` (`issues.ts:311`) | a bare session id, null for operator creates | + on-behalf-of. Per §3.1.3 **A4**, *owner* of an agent-created entity = the agent's `onBehalfOf` human — so this site needs both the pair **and** an `owner` column. |
| E8 | `coordinatorSessionId` | `schema.ts` (`issues`) | `IssueWire.coordinatorSessionId` (`issues.ts:307`) | a bare session id | A `SessionId` (owner A) and an attribution-adjacent site: "who coordinates" becomes answerable as a person. |
| E9 | `SessionMeta.spawnedBy` | `schema.ts:47` `spawned_by` | `runtime-state.ts:440` | **freeform**, documented values `'user' \| 'superagent:<threadId>' \| 'steward' \| 'issue:<id>' \| 'session:<id>'` | The one site where attribution is an **unparsed union in a string**. `'user'` is exactly the role-level value §3.2 says must become a person. Also owner **B**: `issue:<id>` / `session:<id>` are composite keys the detector does not see (built at ~30 scattered call sites, not one helper). |
| E10 | `issue_messages.claimedBy` / `from_author` | `schema.ts:397`, `:394` | tracker mail | session id / freeform author | + on-behalf-of |
| E11 | `messages.ackedBy` / `deliveredTo` / `fromName` | `schema.ts:~570` | agent mail | session ids / freeform | + on-behalf-of |
| E12 | `locks` holder identity | `schema.ts:502` | lock wire | holder string | Per §3.1.1 advisory locks are **deployment substrate** (tenant-visible), but the *holder* is still a person-or-agent. |

**E9 is the finding worth acting on early.** `spawnedBy` is a freeform string carrying a
five-member tagged union, with the tag and the id joined ad hoc. It is simultaneously an
attribution site (E), a composite-key site (B) and a hand-restated definition (D). POD-1075 will
want it structured before it adds a second value to it, and POD-361's helper API is where the
`(kind, id)` shape gets named.

---

## 4. Forward-looking: the sites that will receive a `UserId`

`UserId` **is a member of the brand set** (readiness §3.2 minimum shape). It does not exist yet:
`git grep` for `UserId`, `userId` and `user_id` across the repo returns **zero hits**, there is no
`owner` column on any table, and there is no `grants` table. POD-1075 requires `UserId` to travel
*through* this inventory, these fixtures and the POD-362/POD-363 adoption sweeps rather than
arriving beside them — so the sites are recorded now.

**Where a `UserId` lands:**

| Site | Today | Becomes |
|---|---|---|
| Every attribution site **E1–E12** above | one value (session id / role string) | a **pair**: actor `SessionId` + on-behalf-of `UserId` |
| `client_sessions` (`schema.ts:240`) — `token_hash`, `created_at`, `expires_at` | **no user column**; a client session is a *device*, not a person (readiness §3.2, verified) | gains a `user` column. This is the single most load-bearing addition: it is what turns an authenticated transport into a principal per ADR 3 D7. |
| the **grants edge** | does not exist | `(subject: UserId, resource, verb)` — the `subject` is a `UserId`. Machines need it per §3.1.4 M1's three verbs (`see` / `use` / `manage`). |
| `owner` on every personal-set aggregate | does not exist | a `UserId`. An ADR 1 **amendment**, not an annotation (§3.2). |
| `Capability` (`issue-authz.ts:37`) | `{ role, scope, actorSessionId? }` | `+ onBehalfOf: UserId`. `actorSessionId` is the **existing seam** for the actor half; the on-behalf-of half is new. |
| `IssueScope` (`issue-authz.ts:31`) | `{all} \| {none} \| {subtree, rootId}` | extended with owner/grant scopes — *extend the closed set*, per §3.2, do not invent a parallel check. |
| `notifications.telegramChatId` (`settings.ts:278`) | one `z.string().default('')` per instance | per-user (readiness §3.1.6 **S4**). Note the three composite-key sites in §3.3 join `botToken` with `chatId` — a **secret** with routing config. When `chatId` becomes per-user those keys need re-deriving, and they are cache keys today. |
| `superagent_threads` / `_messages` / `_queued_inputs` / `_pending_turns` | no owner (§3.1.6 **S2**, verified in `schema.ts:161-188`, `:531-551`) | owner `UserId`, private by default |

**Key-shape note for POD-361.** Readiness §3.3 re-keys per-user state to **`(userId, entityId)`**.
That is a two-part composite key over two *branded* types, and it is the first such key in the
system — every existing composite key joins a brand to an unbranded string. POD-361's helper API
should be sized against it: `machineScopedKey(MachineId, string)` is `(brand, raw)`, whereas the
per-user key is `(brand, brand)`. A helper that only accepts `(brand, string)` will be adopted by
POD-1076 with a cast, which is the shape of a quiet regression.

---

## 5. The current homes of the per-user state members (POD-1076)

Readiness §3.3: POD-1076 re-keys these to `(userId, entityId)`. **They are singletons today**, and
their fixtures exist **before** they are re-keyed (§1) — the same characterization discipline
applied to the other half of Phase 1's multi-user work.

| Member | Storage site | Wire site | Key shape today | After POD-1076 |
|---|---|---|---|---|
| session `readAt` | `schema.ts:50` `sessions.read_at` | `SessionMeta.readAt` (`runtime-state.ts:362`), `z.string().nullable().catch(null).default(null)` | **column on the entity** — keyed by `sessionId` alone | `(userId, sessionId)` row |
| session `unread` (derived) | not stored | `SessionMeta.unread` (`runtime-state.ts:369`) | derived from `lastActiveAt > readAt` | derived **per user** |
| issue `readAt` | `schema.ts:467` `issues.read_at` | `IssueWire.readAt` (`issues.ts:265`) | column on the entity | `(userId, issueId)` |
| issue `unread` (derived) | not stored | `IssueWire.unread` (`issues.ts:270`) | derived | derived per user |
| issue `tuckedAt` | `schema.ts:445` `issues.tucked_at` | `IssueWire.tuckedAt` (`issues.ts:214`) | column; the comment says it outright: *"SERVER-side and GLOBAL (single-operator, like `readAt`)"* | `(userId, issueId)`. **Not named in the brief; found by the sweep.** Same shape and same rationale as `readAt`, so it belongs in POD-1076's set. |
| `snoozedUntil` | `schema.ts:223-227` **`snoozes` table**, PK `session_id` | `SessionMeta.snoozedUntil` (`runtime-state.ts:409`) | **own table, keyed by `sessionId` alone** — the closest thing to already-correct shape | PK becomes `(user_id, session_id)` |
| pins | `schema.ts:127-133` **`pins` table**, PK `(kind, id)` | derived into sidebar order | `(kind, id)` — a **two-part composite PK with no user dimension** | `(user_id, kind, id)` |
| tab order blob | `schema.ts:135-139` **`tab_order` table**, PK `worktree`, value `ids` (a JSON/CSV blob) | replica ui-state | keyed by **worktree**, one row per worktree for the whole instance | `(user_id, worktree)` |
| session drafts | `schema.ts:210-221` `session_drafts` (+ `rev`, `origin`, `history`) | `SessionDraftChangedMessage` (`server.ts:41`) | keyed by session | **Deliberately NOT per-user** — readiness §3.3 and §4 name the composer draft as the *interesting exception*: genuinely shared-surface state, and the first place field-LWW becomes a data-loss bug. Reserved for the `op-stream` conflict class. |
| offers | `schema.ts:232-238` `offers`, PK `session_id` | `SessionMeta.offer` (`runtime-state.ts:430`) | keyed by session | Attention routing becomes per-user by construction (§3.1.6 **S3**) — so an offer reaches *its* human. |
| sidebar / tab layout | **CLIENT-side**, `packages/client-core/src/replica/replica.ts:185-200` — `LEGACY_UI_KEYS`: `podium.view`, `podium.sidebarTab`, `podium.selectedWorktree`, `podium.selectedIssueId`, `podium.sidebarLayout`, `podium.dockTab`, `podium.paneA/B`, `podium.split`, `podium.superOpen`, `podium.panelMode`, `podium.homeMode`, `podium.issues.display`, `podium.panelModeDefault`; plus prefixes `podium:sidebar:`, `podium.dock.section.` (`:203`) and map families `podium.htmlmode:`, `podium.mdmode:` (`:207-211`) | **not on the wire at all** — the replica's `UiState` kv (`replica.ts:167-182`) | **per-device**, not per-user and not per-instance | **Worse than a singleton, and this is the finding.** These are already *not shared*, but they are keyed by **browser profile**, so they do not follow a person across devices. POD-1076 moving them to `(userId, key)` is a *feature*, not only a re-key — and it is a **new wire surface**, so it is the one member of this set whose fixture does not exist yet and cannot (there is no message to characterize). POD-1076 must add its schema **and** its fixture in the same change. |
| personal preference keys | `packages/runtime/src/settings.ts:234-325` `PodiumSettings`, one instance-wide document; `experimental` (`:323`) is `z.record(string, boolean)`; `notifications.telegramChatId` (`:278`) | `FeatureState` for the experimental subset (`features.ts:113`, golden `feature-state.json`) | **one instance-wide settings document** | Split: per-user preferences move to `(userId, key)`; instance settings stay **deployment substrate** (§3.1.1). The split line is not yet drawn — readiness §3.1.1 makes membership a per-feature call. `telegramChatId` is already decided (per-user, S4); `telegramBotToken` stays server-only secret. |
| theme | `replica.ts:216` `MIRRORED_UI_KEYS`: `podium.theme.preset`, `podium.theme.mode` — **raw localStorage, deliberately not only ui-state** (read before React by the anti-flash script) | not on the wire | per-device | Per-user, but the raw-localStorage fast path must survive: the anti-flash read happens before any user is known. A per-user theme therefore needs a **device-local cache of the last user's choice**, which is a design constraint POD-1076 should record rather than discover at implementation. |

---

## 6. Forward references (noted, deliberately not built)

**6.1 The machine and host families are the "everything to everyone" baseline.**
`golden/host.json` covers `MachineWire` (`host.ts:29`), `HostMetricsWire` (`:18`),
`HostMemoryWire` (`:10`), `MachineQuotaWire` (`:183`), `AgentQuotaWire` (`:169`),
`QuotaWindowWire` (`:153`), `AgentMemoryWire` (`:94`), `ProjectMemoryWire` (`:100`),
`UsageBucketWire` (`:125`) and every host request/result message. Today **all of it goes to every
client**. Readiness §3.1.4 **M1** later splits machine facts into a **`see`** slice (existence,
health, attribution) and **`use`**-gated detail. `MachineWire.inventory` (`host.ts:35`, the full
harness/model inventory) and the whole memory-breakdown family are the obvious `use`-gated side;
`id`/`name`/`hostname`/`online`/`lastSeenAt` the obvious `see` side. Today's fixture is the
baseline that split is measured against — captured in full for that reason, not minimally.
**Built here: nothing.**

**6.2 `AutomationWire` gains a creator identity.** Readiness §3.1.6 **S6**: scheduled automations
are **delegated** — they run as their creator with that person's *current* rights, inheriting
A1's live evaluation, so revoking someone stops their cron agents with no reaper to write.
`AutomationWire` (`automations.ts:15-33`) and the `automations` table (`schema.ts:784-803`) carry
**no creator** today. That addition is required to be additive at the wire, and
`golden/automations.json` is the evidence. **Built here: nothing.**

**6.3 Not inventoried, on purpose.** Multi-user is **not** multi-tenancy. No instance dimension is
inventoried or reserved, and no `instance_id` column is contemplated. ADR 1 **D5** stays correct as
written (readiness §2); the `InstanceId` taxonomy question stays routed to **POD-359**.

---

## 7. Watch item: the spawn tuple (POD-302 / 1.4) — CHECKED, and it does NOT derive from one schema

**Question asked:** does the approvals `automation-schedule` "fresh" target derive the spawn tuple
`(repoPath, agentKind, model, effort)` from one canonical spawn schema, or is it becoming a fourth
copy?

**Finding: it is already at least the fifth restatement, and the copies observably disagree.**

| # | Site | Shape |
|---|---|---|
| 1 | `packages/protocol/src/messages/approvals.ts:43-49` — `ApprovalOp` `automation-schedule` → target `fresh` | `repoPath: z.string().min(1)`, `agentKind: AgentKind`, `model?: z.string()`, `effort?: z.string()` |
| 2 | `packages/protocol/src/messages/automations.ts:19-28` — `AutomationWire` | `repoPath: z.string().nullable()`, **`agentKind: z.string()`**, `model: z.string()`, `effort: z.string()` |
| 3 | `apps/server/src/migrations/schema.ts:788-795` — `automations` table | `repo_path` nullable, `agent_kind` notNull, `model` default `'auto'`, `effort` default `'auto'` |
| 4 | `packages/protocol/src/messages/terminal.ts:326-338` — `SpawnMessage` | **`cwd`** (not `repoPath`), `agentKind: AgentKind`, `model?`, `subagentModel?`, `effort?` |
| 5 | `apps/cli/src/cli.ts:250-266` — CLI `automation --fresh` | restates the tuple again with its own validation and its own required/optional split |
| 6 | `apps/server/src/modules/issues/service/crud.ts:273-289` — issue-create default resolution | `defaultAgent = input.defaultAgent \|\| coding.harness`; `defaultModel = input.defaultModel \|\| (useCodingDefaults ? settings.roles.coding.model : 'auto')` |
| 7 | `apps/server/src/relay.ts:468-481` — where the approvals op becomes an automation row | the merge point, which invents its own defaults |

**Two concrete divergences, not just duplication:**

1. **The harness kind is validated on one path and not the other.** Copy 1 types `agentKind` as
   the closed `AgentKind` enum; copy 2 types it as a bare `z.string()`. An automation row can
   therefore carry an `agentKind` no adapter implements, and the spawn path casts it back
   unchecked: `apps/server/src/modules/automations/service.ts:583` —
   `agentKind: automation.agentKind as AgentKind`. That is an unvalidated cast at the boundary
   where the value becomes a process.
2. **There are two different answers to "what is the default agent".**
   `apps/server/src/relay.ts:476` hardcodes the literal
   `agentKind: existing?.agentKind ?? fresh?.agentKind ?? 'codex'`, while issue-create (copy 6)
   resolves the default from `settings.roles.coding.harness`. A one-off automation scheduled
   through the approvals broker with no explicit agent therefore ignores the operator's configured
   default harness and gets `codex`. `relay.ts:477-478` likewise hardcodes `'auto'` for
   model/effort where copy 6 consults `settings.roles.coding.model`.

**Recorded recommendation for POD-302:** introduce one canonical `SpawnRequest` in
`packages/model`, with `AgentKind` closed on **every** copy and a single default-resolution
function that both the issue-create path and the approvals→automation path call. The `as AgentKind`
cast is the marker to delete; while it stands, the enum is decorative on the automations path.

Because POD-360 changes no behaviour, the two divergences are **filed, not fixed** — see the
`discovered-from` issue on POD-360.

---

## Appendix — regenerating this inventory

```sh
bun run inventory:ids              # summary: files parsed, per-class and per-package counts
bun run inventory:ids --full       # every site, file:line, tab-separated
bun run inventory:ids --json       # machine-readable
bun run lint:no-nul                # the grep blind spot: which files are invisible to line tools
bun run fixtures:wire:update       # regenerate the golden corpus, then READ THE DIFF
bun run test:unit                  # the fixtures, in the lane CI runs
```

`docs/rearch-id-inventory.sites.tsv` is the committed snapshot of the declaration-class and
composite-key sites (1 997 rows) — the classes needing a per-site decision. The consequence
classes (8 145 object-literal fields, 1 183 comparisons) are reproducible from the script and are
not snapshotted: they are what the flip's type errors will enumerate for free.
