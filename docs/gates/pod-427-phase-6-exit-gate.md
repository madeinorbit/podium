# POD-427 Phase 6 exit gate — client split verified

## Second pass — 2026-08-03 — **PASS**

**Candidate:** `06f1bb3bcf1f5812dcf594cab05feeb244f31912` (verified by `git rev-parse HEAD`, not by report)
**Verdict:** **PASS. Phase 7 entry is unblocked, with one item recorded OUTSTANDING and not
discharged: the mobile device smoke, which is a human gate no agent can sign.**

The three holds of the first pass (POD-1533, POD-1534, POD-1535) are cleared. None of them was
accepted on its closure report: each was re-proved here by planting the failing case into
**production source**, watching the named check go red on the measured quantity, and reverting
atomically. Seven mutations, seven refusals, worktree clean after each.

**What this document does and does not certify.** It certifies the acceptance text of POD-427:
the god-file split, the single ui-state owner, the render-count probe, offline-first behaviour,
bundle limits, the sixteen multi-user probes, and children-closed-with-evidence. It does **not**
certify that the mobile app was smoked on a device (§O5, human gate at POD-332), and it does
**not** certify that the Playwright browser lane is green (it is not — POD-1532; the ruling that
this gate's criteria do not name that lane is re-affirmed below, with the reasoning).

### The three holds, re-proved rather than accepted

| Hold | Planted into production source | Result |
| --- | --- | --- |
| **POD-1533** item 11 | `ownerId` **alone** into the rename payload (`engine/actions.ts:463`) | **exit 1** — `rename payload asserts attribution field 'ownerId': expected [ 'sessionId', 'name', 'ownerId' ] to not include 'ownerId'`. The first pass measured this exact mutant **silent at exit 0**. |
| **POD-1533** second site | `origin: 'web-client'` alone into the spawn payload (`spawn-agent.ts:62`) | **exit 1 — 1 failed**. See the instrument note below. |
| **POD-1534** item 3 | `'gateProbeUnrouted'` into `LAYOUT_EXACT_KEYS` (`model/user-state/layout-state.ts`) | **exit 1 — 2 failed**, including *"the totality check REFUSES a planted key with no declared home"*, naming the key. The first pass measured **51 passed, exit 0** for this same plant. |
| **POD-1535** item 9 | `<SessionWatchers/>` replaced by `{null}` in `AgentPanel.tsx:555` | **exit 1** — *"renders the presence strip in the session header"*. The surface is mounted, not merely written. |
| **POD-1535** the invariant | `watchersSummary('unknown')` returns `'Only you'` (`watchers.ts:100`) | **exit 1 — 2 failed** — *"expected 'Only you' to contain 'unknown'"*. "We do not know" cannot collapse into "nobody is here". |
| **POD-1535** ephemerality | `forget()` made a no-op — presence retained across disconnect (`presence/room-presence.ts`) | **exit 1 — 2 failed** — *"reverts to unknown when the connection drops, and does not treat it as everyone leaving"*. A durable presence row is refused by test, as the brief requires. |
| Items **1 + 13** | `principalKeyPrefix` → a shared `.principal.shared` namespace | **exit 1** on **both** platforms in one mutant: web **6 failed** (incl. *"a planted foreign cursor and collection are never adopted"*), mobile **3 failed** (incl. *"the AsyncStorage side-cache is namespaced too — a switch cannot read the other principal's keys"*). |

Restoration confirmed: `git status --short` **empty** after every revert; the mutated suites run
green as one batch — client-core actions/spawn/ui-state-audit/presence + web presence suites
**8 files, 65 tests, exit 0**; `packages/client-core/src/replica/` **21 files, 264 tests, exit 0**.

**POD-1534 is not a second tautology, and that was checked rather than assumed.** The replacement
derives its reachable set by *routing the legacy vocabulary through `uiStateRoute`*
(`reachableLayoutKeys`), never from `LAYOUT_EXACT_KEYS` — which is why planting a key into that
list makes it fail rather than pass. The deleted assertion is gone, not amended, and
`session-state.test.ts:238` now carries a comment saying why.

**Instrument note, non-blocking (spawn site).** At `spawn-agent.test.ts` the per-field
`not.toContain` loop sits **after** an exact `toHaveBeenCalledWith`, which already refuses any
extra key — so the planted `origin` was caught by the equality, and the per-field loop is
unreachable for an *added* field. The property is enforced (more strictly than the brief asks);
the per-field clause is redundant there rather than load-bearing. It is load-bearing at
`engine/actions.test.ts`, where the payload is inspected by key and the single-field mutant
proved it. Recorded so no later reader mistakes the loop for the thing that fired.

### The POD-1535 scope ruling — read independently, and agreed

The coordinator ruled "build the surface" and flagged the ruling as contestable. Grading the
document rather than the summary: `docs/multi-user-readiness.md` §5 assigns Phase 6
"Scoped replica-side views; presence/cursor UI", and line 31's "the last part need not ship"
attaches to *"eventually typing concurrently"* — the sentence's own last clause — which the same
table then lists separately under **Deferred, unblocked: "Concurrent text editing. Reserved by
the `op-stream` class."** Presence is not the deferred part. **The ruling executes a recorded
human decision; it does not make one.** I read the sentence the same way.

What shipped is presence with identity plus "which pane I am reading" as the room payload; a text
cursor inside a shared document is explicitly out, reserved to ADR 7's `document` room kind, and
the mobile presence surface is a filed follow-up. All three of those are written down in
`docs/superpowers/specs/2026-08-03-session-presence-surface-design.md` with reasoning — which is
what item 16 asks for, and it is satisfied here rather than defaulted.

### Re-affirmed rulings on the known-outstanding items

Each was re-checked against this gate's **literal** acceptance text, not against a sense of
completeness. All four rulings from the first pass stand, unchanged:

- **Playwright browser lane** (POD-1532; 143 of 164 failures are `ERR_CONNECTION_REFUSED` after
  the relay stops answering — assertions that never ran) and **POD-1531** (three suites call
  `settings.set`, replaced by `settings.updatePersonal`): **do not block.** POD-427's criteria
  name god-file audits, a ui-state lint, a render-count probe, offline-first behaviour, mobile
  smoke, bundle limits and the multi-user probes. They do not name that lane. **But no reader may
  quote this gate as evidence the browser lane is green** — it is not, and POD-332's reading that
  POD-293 must not close on a "Playwright green" criterion stands.
- **`lint:shadowing`** (`packages/harness/src/registry.ts`) and **`audit:declared-consumers`**
  (`packages/commands/src/contract.ts`): pre-existing, uncaused by Phase 6, unnamed by these
  criteria. **Do not block.** Both should still close.
- **POD-1530** (breaking wire rename, deferred to daylight) and **POD-1528** (mobile outbox shares
  one partition): **do not block**; no criterion here names either.

### O5 — mobile device smoke · OUTSTANDING, again, and stated plainly

Unchanged and undischargeable by an agent: cold-start offline paint from the SQLite replica,
reconnect drain, terminal-pane parity, and a **user switch** rather than only a cold start, on a
real device. Held at POD-332. **This gate does not pass around it and does not fail for it:** it
is recorded as not met, so nothing here may be read as evidence that mobile was smoked on a
device. The automated half is green and cited (`test:mobile` 7 files / 58 tests, exit 0).

### Second-pass evidence base

Environment neutrality: the worktree arrived **uninstalled** (`ls node_modules/@podium` → no such
file), which under this repo's hoisted linker would have resolved `@podium/*` to the **main
checkout** and measured code that is not on this tree. Nothing was run before
`bun install --frozen-lockfile` (1338 packages, **exit 0**), after which `node_modules/@podium`
lists **25** workspace packages. Every exit code below is the real code of an unpiped command.

Re-measured here at `06f1bb3b` (cheap, and each one is a criterion this gate names):

```text
render-count probe   apps/web/src/perf/slice-render-count.test.tsx, exit 0
  [POD-330 worklist]     per publish: commits=2.2 worklistSlice=1 directSidebarSections=0
  [POD-331 two-consumer] per publish: commits=3   worklistSlice=1 directSidebarSections=0
god files            filesystem scan (find, node_modules excluded): engine.ts, connection.ts ABSENT
derive.ts            apps/web/src/lib/derive.ts = 43 lines (the re-export shim, not a god file)
not multi-tenancy    instance_id / instanceId across apps/web/src, apps/mobile/src,
                     packages/client-core/src => 0 occurrences
MobileClientValue    0 declarations; the 5 remaining hits are prose in comments and old plan docs
```

Cited from the integrator at the same SHA, per the 2026-07-17 evidence convention, and named with
their config rather than as bare counts:

| Lane | Result | Exit |
| --- | --- | ---: |
| `apps/web/src` + `packages/client-core/src` **[ROOT `vitest.config.ts`]** | 272 files / 2321 tests | 0 |
| `packages/sync` + `model` + `commands` **[`vitest.unit.config.ts`]** | 101 files / 1703 tests | 0 |
| `audit:rearch` | `32 items, 152 sites remaining (baseline exact)` | 0 |
| `audit:god-objects`, `audit:router-mutations` | — | 0 |
| `lint:boundaries` | OK, 6 allowlisted, 0 new | 0 |
| `typecheck` | Tasks 22/22 | 0 |

### Acceptance, graded literally

- [x] **All Phase-6 children closed with evidence** — POD-328/329/330/331/332 and their subtrees
      all `done`; POD-1533/1534/1535 `done` and re-proved above.
- [x] **Every original verification item evidenced**, landing-run results cited by exit code and
      attribution rather than re-derived — except **O5**, recorded OUTSTANDING above.
- [x] **Every multi-user probe run, each guardrail shown to FIRE on planted bad code** — 8
      mutations across the two passes plus the 7 above; the two that could not refuse in the first
      pass are the two that were repaired and are now proved able to.
- [x] **Ledger and as-built updated; open questions recorded with what shipped and why** — the
      cross-boundary edge policy (`CROSS_BOUNDARY_POLICY = 'opaque'`, a required argument with no
      default) and the presence scope decision, both written down with reasoning.
- [x] **Gate unblocks Phase 7 entry.**

---

## First pass — 2026-08-03 — HOLD (superseded by the second pass above)

**Candidate:** `f1b7cbb1e01e6f2867563a5f2286f10ffacdd337` (verified by `git rev-parse HEAD`, not by report)
**Verdict:** **HOLD — the client split itself is delivered and mutation-proved, but three
acceptance items are not met. Phase 7 entry is NOT unblocked by this document.**

The engineering under this phase is strong, and this gate says so with numbers rather than
adjectives: eight independent guardrails were mutated in production code and every one of them
went red on the exact quantity it claims to guard. The god-file split, the single ui-state
owner, the render-count improvement, the evict/remove distinction, per-principal namespacing,
ADR 2 D7's keep-the-outbox rule and the widened rearch detector are all real and all provable.

The gate is held on three items, each evidenced by a planted mutation or an exhaustive search
rather than by reading:

1. **POD-1533** — the client-attribution guard cannot refuse the realistic case.
2. **POD-1534** — the ui-state routing table has no totality check; the assertion that looks
   like one is a tautology.
3. **POD-1535** — Phase 6's second named multi-user deliverable, PRESENCE / CURSOR UI, landed
   as mechanism with no surface.

Items 1 and 2 falsify the gate's own third acceptance bullet ("every multi-user probe run, with
each guardrail shown to FIRE on planted bad code"). Item 3 falsifies the brief's opening
instruction that this gate "proves both landed".

**Two claims, kept apart.** *The Phase-6 client split was delivered* — **yes**, and it is the
best-instrumented phase in this programme so far. *Every POD-427 acceptance item is met* —
**no**, on the three above. This document must not be quoted as evidence for the second.

## Evidence convention

Per the 2026-07-17 human ruling, integrator landing results at the candidate SHA are cited with
attribution rather than re-derived. This gate ran only the genuinely untested: deliberate-violation
probes against production code, an environment-neutrality check, and process close-outs.

Every exit code below is the real exit code of an unpiped command. Every count names its config.

## Environment neutrality

The worktree arrived **uninstalled** (`ls node_modules/@podium` → no such file). Per POD-1343 a
cached green in that state is not evidence, so nothing was run before `bun install --frozen-lockfile`
(1338 packages, **exit 0**), after which `node_modules/@podium` lists 25 workspace packages.

```text
bun run typecheck
 Tasks:    22 successful, 22 total
Cached:    22 cached, 22 total    >>> FULL TURBO
exit 0
```

Cited from the integrator, not re-derived (all at `f1b7cbb1`):

| Lane | Result | Exit |
| --- | --- | ---: |
| `apps/web/src` + `packages/client-core/src` **[DEFAULT root vitest config]** | 268 files / 2290 tests | 0 |
| `apps/server/src` | 270 files / 3849 passed, 1 skipped | 0 |
| `test:unit` | 694 files / 9944 tests | 0 |
| `test:integration` | 294 passed | 0 |
| `test:e2e` | 10 files / 36 tests | 0 |
| `test:mobile` | 7 files / 58 tests | 0 |
| `test:multi-instance` | 1 file / 3 tests | 0 |
| `audit:god-objects`, `audit:router-mutations` | — | 0 |
| `audit:scoped-feed`, `audit:ambient-principals`, `audit:phase2-client` | — | 0 |
| Bundle / PWA precache | 52 entries, 5476 KiB, largest 2.56 MiB vs 5 MiB per-file ceiling, checked against the **service worker manifest**, 0 files excluded by precache globs | PASS |

## Original scope

| # | Criterion | Verdict |
| --- | --- | --- |
| O1 | `engine.ts` / `connection.ts` / `derive.ts` god files gone | **PASS**, with a correction |
| O2 | One ui-state owner (lint) | **PASS** — mutation-proved, both clauses |
| O3 | Render-count probe recorded | **PASS** — recorded below; can-say-NO guard proved armed |
| O4 | Offline-first behaviour preserved | **PASS** — structural, mutation-proved |
| O5 | Mobile device smoke | **OUTSTANDING — human gate, not dischargeable by an agent** |
| O6 | Bundle within PWA precache limits | **PASS** (integrator, cited above) |
| O7 | Children closed with evidence; ledger + as-built updated | **PASS** |

### O1 — the god files · PASS, with a correction to the reported number

`engine.ts` and `connection.ts` are **absent from disk**, confirmed by a filesystem scan
(`find` over the tree excluding `node_modules`), not by git alone — this repo has had
"git says gone, disk-scanning gates disagree" before, which is why the scan was run that way.

**The correction:** the integrator reported `derive.ts` as "2585 → 0". It is **2585 → 43**.
`apps/web/src/lib/derive.ts` still exists as a tracked 43-line file. It is not a god file and
not a residue: it is a named re-export shim (`export * from '@podium/client-core/viewmodels'`)
plus the css-classname helpers that depend on `cn()`/tailwind-merge and are deliberately
web-side. 48 import sites still reach the viewmodels through it. The criterion ("god files
gone") is met; the number as reported was not accurate, and a gate that repeated it would have
propagated it.

`audit:rearch` is **exit 0** — `deletion audit OK — 32 items, 152 sites remaining (baseline exact)`.

### O2 — one ui-state owner · PASS

`packages/client-core/src/ui-state.audit.test.ts` is a build-failing ownership guard, not a
convention. Baseline 18 passed / exit 0 across it and `ui-state.test.ts`. Both clauses of the
rule were mutated and both fired — see M1 and M2.

The **theme is the only named pre-auth exception**, and the guard closes the direction that
matters: `the theme is the ONLY pre-auth home — the converse of the forward check` asserts over
the whole known vocabulary that exactly the theme keys are pre-auth, so a *second* key joining
the exception is caught. Its documented justification is recorded in
`packages/client-core/src/replica/principal-storage.ts` ("ThemeProvider must paint before
authentication settles") and restated in the audit's own comments. There are separate
single-writer **and** single-reader assertions; the reader one carries the reasoning that a read
is what can adopt another principal's data.

### O3 — render-count probe · PASS, recorded

Measured at `f1b7cbb1`, `apps/web/src/perf/slice-render-count.test.tsx`, exit 0:

```text
[POD-330 worklist]      per publish: commits=2.2 worklistSlice=1 directSidebarSections=0
[POD-331 two-consumer]  per publish: commits=3   worklistSlice=1 directSidebarSections=0
```

The two-consumer case is the one that carries the claim: the unported tree measured
`sidebarSections=2` at `5409a3ac` (two independent consumers, two executions of the identical
derivation); it now measures **1**. That is the 2 → 1 the split existed to buy.

**The can-say-NO guard is still armed**, which is the question the integrator flagged. The
counter wraps the client-core *barrel*, so once a derivation moved package-internal it read
zero — and zero passes every ceiling. The file carries `expect(worklistDerivations())
.toBeGreaterThan(atMount.worklist)` against the *publisher's own* counter for exactly that
reason. Proved by mutation M8: making the publisher cache forever produced
`AssertionError: expected 1 to be greater than 1` in **both** probes — the guard fired, not the
ceiling.

### O4 — offline-first preserved · PASS

ADR 2 D7's keep-the-outbox rule holds **structurally, at the type level**: the replica is handed
`ReplicaParticipantStore`, a cache port with no outbox region and no way to open one
(`packages/sync/src/replica/ports.ts` — *"`discardCache()` still cannot touch the outbox, which
is the property this file exists to hold"*). A span is an opaque handle, so enrolling a region
confers no ability to name another. Mutation M7 proves the durable adapter's guard fires.

POD-1232's kernel-Outbox move quarantines unmappable legacy entries rather than deleting them,
and POD-785's per-target routing (`outboxRoutingFor`) replaces the single `client-outbox`
partition that wedged the queue at its first unresolved entry.

### O5 — mobile device smoke · OUTSTANDING, and stated as such

**This gate does not discharge it and does not pass around it.** The real-device half —
cold-start offline paint from the SQLite replica, reconnect drain, terminal-pane parity, and a
**user switch** rather than only a cold start — is a human device gate held at POD-332, which
said so plainly rather than signing itself. Recorded as OUTSTANDING with that attribution.

It is **not** counted as a failure of this gate: no agent can sign it, and POD-332's automated
half is green (`test:mobile` 7 files / 58 tests, exit 0, cited). It **is** counted as unmet, so
no reader can take this document as evidence that mobile was smoked on a device.

## Multi-user probes

| # | Item | Verdict |
| --- | --- | --- |
| 1 | No cross-user paint; foreign cursor not adoptable | **PASS** — M4 |
| 2 | Per-principal namespacing enforced, both clauses | **PASS** — M1, M2 |
| 3 | UI-state routing table is total | **FAIL — POD-1534** |
| 4 | Evict is not a deletion | **PASS** — M3 |
| 5 | Watermark-only stretches keep the client healthy | **PASS** |
| 6 | Denied drain rolls back, does not retry | **PASS** |
| 7 | The partial world renders correctly; choice recorded | **PASS** |
| 8 | Placement fails closed in the UI | **PASS** |
| 9 | Presence ephemeral, identity-carrying, room-scoped | **PASS (mechanism)** — M5, M6 |
| 10 | Shared-session control has a face | **PASS** (Phase 5, POD-1081) |
| 11 | The client never asserts attribution | **FAIL — POD-1533** |
| 12 | Superagent and per-user state in the client | **PASS** |
| 13 | Mobile carries the same properties | **PASS (automated half)**; device half = O5 |
| 14 | Single-user parity | **PASS** (children's evidence, not re-run) |
| 15 | Not multi-tenancy | **PASS** |
| 16 | Open questions recorded, not silently answered | **PASS** |

### Item 3 — routing totality · FAIL

The brief requires a persisted key with no declared home to **fail the build**. It does not.

Adding `gateProbeUnrouted` to `LAYOUT_EXACT_KEYS` and running the ui-state audit plus the whole
model user-state suite gave **51 passed, exit 0**. The key genuinely has no home — a direct call
proves `uiStateRoute('gateProbeUnrouted')` throws `Unclassified UI-state key`.

So the **runtime is correctly default-closed**, and that half should be kept. What is missing is
any check that fires before runtime. The only assertion over that vocabulary is
`session-state.test.ts:238`, `for (const key of LAYOUT_EXACT_KEYS) expect(isLayoutKey(key)).toBe(true)`
— and `isLayoutKey` tests membership of `EXACT_SET`, which is **built from `LAYOUT_EXACT_KEYS`**.
The assertion cannot fail for any key. It reads as totality coverage and provides none.

Filed **POD-1534**. Note this is the same failure class the gate is meant to catch: an
instrument that cannot say no.

### Item 11 — the client never asserts attribution · FAIL

The design is right and worth stating, because the defect is in the instrument, not the code:
the command **payload** carries no attribution, and `attribution` is a separate envelope field
set from the bound principal (`kernel-outbox.ts:178`), which is the ADR 3 D7 shape.

The **guard** cannot refuse the realistic case:

```text
planted ownerId ALONE in the rename payload            => 12 passed, exit 0   (SILENT)
planted actor + owner + ownerId + origin together      => 1 failed,  exit 1   (fires)
```

`expect(x).not.toEqual(expect.arrayContaining([a,b,c,d]))` matches only when **all four** are
present, so under `.not` it passes unless a payload carries the complete set. The brief asks for
"actor, owner, ownerId **or** origin". Filed **POD-1533**.

### Item 9 — presence · PASS as mechanism, and the UI is absent

The mechanism is genuinely good and is mutation-proved (M5, M6). `ClientSubscriptionRegistry` is
**one** registry serving both durable feed routing and lossy room fan-out, differing only by a
`durability` field; the authenticated principal is deliberately absent from it so no
principal-derived value can survive a user switch. Rooms are ephemeral by construction, dropped
rather than buffered, restored as presence frames on reconnect, and cleared wholesale on
principal change. `socket-hub.rooms.test.ts` covers identity never being client-supplied,
presence dropping under pressure without delaying a control frame, unauthorized staying distinct
from unreachable, and release of all principal-bound state.

**But no product code consumes any of it.** At `f1b7cbb1`: zero hits for
`subscribeRoom` / `presenceSubscribe` / `presenceUpdate` / `PresencePayload` anywhere in
`apps/web/src` or `apps/mobile/src`; `subscribeRoom` is not exposed through
`packages/client-core/src/react/`, `index.ts` or `store.ts`; zero hits for any co-presence
surface under other names (collaborator, viewers, remoteCursor, avatar stack); `clientCount`
appears in `apps/web` only inside test fixtures. Filed **POD-1535**.

### Items 5, 6, 7, 8, 12, 14, 15, 16 — the passes, briefly

- **5** — `removal-family.test.ts` carries *"renders a watermark-skipped range as nothing,
  advances the cursor, and starts no heal"*, and the cursor-after-data invariant for an empty
  batch. The one-transaction rule (ADR 2 D10) is the same span mechanism O4 rests on.
- **6** — `facade.test.ts`, *"a denied outbox write is SURFACED, never swallowed"*.
- **7** — `session-ownership.partial-world.test.ts`; `resolveReferent` is a four-state
  tri-state (`present` / `not-visible` / `removed` / `pending`) in which presence wins over a
  stale exit record, so a re-granted row does not read as invisible. Neither "loading forever"
  nor "deleted" is reachable for an invisible referent.
- **8** — `authority-list.test.ts` denies omitted peers once any visible machine is explicitly
  scoped; Phase 5's `oracle-handoff.test.ts` holds the unauthorized-vs-unreachable distinction
  as a string **equality** between the invisible and nonexistent paths, so the client cannot
  invent a distinction the server declined to make.
- **12** — `viewmodels/slices/superagent.ts` with the shadow mirrors and refresh-key bumps
  deleted; `audit:rearch` measures `superagent-shadow-types` at **0**.
- **14** — taken from the children's parity evidence, not re-run, per the brief.
- **15** — **zero** occurrences of `instance_id` / `instanceId` across `apps/web/src`,
  `apps/mobile/src` and `packages/client-core/src`. ADR 1 D5 is unaffected; no drift toward
  multi-tenancy.
- **16** — the cross-boundary edge question is **recorded, not defaulted**. `resolveIssueEdge`
  takes `policy: 'hidden' | 'opaque'` as a **required argument with no default value**, so a
  caller cannot acquire a policy by omission; the shipped choice is one named constant,
  `CROSS_BOUNDARY_POLICY = 'opaque'` (`issue-edges.tsx:76`), with the argument and its
  limitations written out in `docs/agents/pod-330-slice-ownership-map.md`. That ledger also
  records the honest correction that `not-visible` was unreachable when the policy landed, and
  that `branchRollup` deliberately does **not** publish "and N more you cannot see" because a
  count is an existence fact §3.1.2 leaves open. That is the shape the acceptance text asks
  for: written down with reasoning rather than settled by a component default.

## Instruments proven able to refuse

Every check cited above was mutated in **production** code, watched go red with the measured
quantity, reverted atomically with `git checkout -- <path>`, and grepped back. One mutant per
run; `git status --short` was verified **empty** after each revert.

| # | Guards | Mutation | Red result | Restored |
| --- | --- | --- | --- | --- |
| M1 | Item 2, clause 1 | Direct `localStorage.setItem('podium.view', …)` in `apps/web/src/lib/utils.ts` | **exit 1 — 2 failed**, naming `apps/web/src/lib/utils.ts: podium.view` | exit 0 |
| M2 | Item 2, clause 2 | Unnamespaced `setItem` inside `ui-state.ts` | **exit 1** — `exactly one unnamespaced writer` | exit 0 |
| M3 | Item 4 | `evicted` → `removed` in `packages/sync/src/replica/replica.ts` | **exit 1 — 4 failed** across **both** backends (IndexedDB + SQLite) and the read model | exit 0 |
| M4 | Item 1 | `principalKeyPrefix` → a shared `.principal.shared` namespace | **exit 1 — 6 failed**, incl. `a planted foreign cursor and collection are never adopted` | exit 0 |
| M5 | Item 9 | Room subscriptions marked `durable` | **exit 1 — 4 failed** | exit 0 |
| M6 | Item 9 | `clearForPrincipalChange` retains rooms | **exit 1 — 2 failed** | exit 0 |
| M7 | O4 | `discardCache` deletes the durable outbox rows | **exit 1** — `discardCache() drops entities and the cursor and leaves the queue on disk` | exit 0 |
| M8 | O3 | Slice publisher caches forever | **exit 1 — 2 failed** on the can-say-NO guard, not the ceiling | exit 0 |

Restoration was confirmed as one run over all mutated suites: **12 files, 142 tests passed,
exit 0**, worktree clean.

### M7 is the one to read twice — a false negative I created myself

M7's **first** attempt looked like a gap and was not one. I wrote a mutant that pushed outbox
deletes from `draft.outbox`, which is empty at that point in `discardCache`, so it deleted
nothing and the suite passed at **exit 0**. Read carelessly, that is "the D7 guard does not
fire" — a finding this gate would have reported against sound code.

The rewritten mutant used the adapter's real `outboxOf(principal)` mirror, the same source
`erasePrincipal` uses, and the guard fired immediately. **A prescribed mutant that cannot move
the measured quantity proves nothing about the instrument**, and a green from one is a statement
about the mutation, not the code. Recorded because the failure was mine and the next gate should
expect it.

Related, from POD-332 and adopted here: a substring rename is not a mutation — renaming
`RepoScanFlow` to `RepoScanFlowMUTANT` leaves a grep-based structure gate green because the
mutant still *contains* the needle.

## Verifying the ratchet story rather than trusting it

`audit:rearch` read 113 sites at the previous gate and reads **152** here. That is a widened
measurement, not decay, and this gate proved it both directions rather than accepting the
summary:

```text
inline object type restating 3 session keys  => session-shapes baseline 37 → now 38, exit 1,
                                                site named: apps/web/src/lib/utils.ts:9
inline object type restating 2 session keys  => 32 items, 152 sites remaining (baseline exact), exit 0
```

POD-1525 taught the detector to read **inline** object type literals where it had matched only
named declarations, so restatements that always existed became visible. The old number was never
a census; it bounded the named half. POD-332 then removed 3 (`mobile-client-value` 1→0,
`superagent-shadow-types` 2→0).

## Known-outstanding items, graded against this gate's literal text

None of these blocks the gate's own criteria; each is stated so the reader can disagree with a
specific judgement rather than a summary.

- **The Playwright browser lane is red and largely uninformative.** 13 passed / 164 failed /
  303 skipped, rc=1 (POD-332, measured twice). **143 of the 164 are "cannot reach the server"**
  — 125 `page.goto` ERR_CONNECTION_REFUSED, 14 `apiRequestContext.get`, 4 `fetch failed` — after
  the relay stopped answering mid-run (server logged `verdict=starved`, heap 355MB / rss 729MB,
  load 45–50). Those assertions **never ran**, so they say nothing about behaviour, the same
  class as a watchdog timeout. Filed POD-1532. Three genuinely stale suites call
  `settings.set`, which POD-1213 replaced with `settings.updatePersonal` — POD-1531.
  **Does not block:** POD-427's acceptance text names god-file audits, a ui-state lint, a
  render-count probe, offline-first behaviour, mobile smoke, bundle limits and the multi-user
  probes. It does not name the Playwright lane. Holding on it would be grading against text this
  gate does not contain. **But** no reader may quote this gate as evidence that the browser lane
  is green — it is not, and POD-332's reading that POD-293 must not close on that criterion
  stands.
- **POD-1530** (wire key `blockedBy` → `blockedByNotes`) — deferred to daylight by the
  integrator as a breaking wire change needing a v1 adapter arm. Does not block.
- **POD-1528** (mobile outbox shares one partition) — filed, not fixed. Does not block: the
  wedge class POD-785 fixed is per-target routing on the **web** path; this is a mobile
  follow-up with no criterion in this gate naming it.
- **POD-1523 / POD-1521 / POD-1517** — browser-lane and lint items. Do not block.
- **`lint:shadowing`** (`packages/harness/src/registry.ts`, `harnessResumeKind` declared 3×) and
  **`audit:declared-consumers`** (5 declarations in `packages/commands/src/contract.ts`) —
  pre-existing red, untouched and uncaused by Phase 6. Neither is named by this gate's criteria.
  Both should close, and neither makes a Phase-6 claim false.

## What must close before Phase 7 entry

*(First-pass list. Items 1–3 CLOSED and re-proved in the second pass above; item 4 remains
OUTSTANDING.)*

1. **POD-1533** — repair the attribution guard to assert per-field, and require the
   single-field mutant RED before believing the repair.
2. **POD-1534** — assert every layout key resolves to a home through `uiStateRoute`; consider
   removing the tautological `isLayoutKey` assertion rather than leaving it to read as coverage.
3. **POD-1535** — land a presence/cursor surface, or obtain an explicit human ruling that the
   deliverable is re-scoped to mechanism-only and refile the UI under Phase 7. Either is a
   legitimate answer; drifting past it silently is not.
4. **O5 (mobile device smoke)** — human device gate, POD-332.

Items 1 and 2 are small and mechanical. Item 3 is a product decision, not a defect, and is the
one a human should rule on rather than an agent deciding by default — which is precisely the
§3.1.2 failure mode this gate exists to catch.
