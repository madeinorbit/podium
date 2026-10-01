# POD-4949: one issue record on the wire

Spec, 2026-09-30. Status: plan approved by the operator; no step started.
Epic: POD-4286 (frontend state-store performance). Steps: POD-4967 to POD-4974.
Code references are to `dev/mw` at `e7aaeb614` unless stated.

## 1. Summary

The server sends every issue to every client twice:

- the **old record**, `IssueWire`, feed kind `issue`
  (`packages/model/src/entities/issue.ts`);
- the **normalized record**, `IssueProjection`, feed kind `issueProjection`
  (`packages/model/src/projections/issue-projection.ts`).

The client stores both, and both carry the same large text fields. On the operator's
data (5,477 issues) the two issue kinds are 45.0 MB and 42.4 MB of the client's
105.3 MB of retained synced rows, measured on 2026-09-30. Dropping one copy saves
about 40%.

This spec removes the old record in steps. Each step ships to production on its own,
and no step breaks a client that is still in use.

## 2. Background

**The decision.** ADR 4 decision D7 (`docs/adr/0004-representation-policy.md`,
human decision on POD-279, 2026-07-17) made the normalized shape the law:

- **D7.1:** a replicated entity refers to other entities by id only, never by
  embedding them.
- **D7.2:** a change to entity X recomputes only X's own projections, never work
  that grows with the world.
- **D7.3:** cross-entity views are built on the client, from the rows it already
  holds.
- **D7.4:** a derived value the client cannot compute becomes its own server-maintained
  entity.

The old record broke D7.1 by embedding each issue's sessions. A one-field session
change rebuilt every issue's payload: p50 711 ms, twice per switch, at 530 sessions
(POD-701 and POD-772).

**The history.**

- **POD-796** added the normalized record *alongside* the old one.
- **POD-797** (2026-07-18) deleted the embedded sessions but kept the rest of the old
  record as *registered residue*, because hub-mirrored issues were still consumed in
  the old shape. The residue was to expire when POD-309 or POD-827 landed.
- **POD-309** deleted hub mirroring, and **POD-827** closed on 2026-08-02 with "the
  premise is gone". The residue was never removed, and no open issue covers it.

## 3. The current state

The old record is **load-bearing**. What depends on it:

**Fields only the old record carries**

| Field | Used for | Evidence |
|---|---|---|
| `readAt`, `tuckedAt`, `pinned` (per user) | unread, tuck, pin | `issue-views.ts:507`; `issue-view-models.ts:170`; `fields/issue.ts:182` (pinned deliberately absent from the projection) |
| `gitState` (`shared`, `ahead`, `merged`) | "waiting for merge" and merge decisions | `issue-vocabulary.ts:203-230`; predicates in `viewmodels/slices/issues.ts:348-438`; on the operator's data 14 old records carry it and 0 projections (POD-4940) |
| `repoPath` | paths in the UI | the repo projection has only `id` and `prefix` (`fields/repo.ts:63,77`) |
| `commentCount` | the ref miniview | `lib/ref-miniview.ts:46`, `components/RefMiniview.tsx:818` |
| spellings `humanQuestion*`, `origin`, `draft` | the UI reads these names | the projection names them `asked`, `intentOrigin`, `isDraftVessel` |
| synthetic parent-child `deps` | dependency views | `core.ts:629-641` |

**Client readers**

- **Web:**
  - View models spread the old record first (`issue-view-models.ts:142-182`), and
    return nothing when it is missing (`:155`).
  - The worklist falls back to `store.issues` (`viewmodels/slices/worklist/published.ts:143-145`).
  - Three screens read `s.issues` directly: `AgentPanel.tsx:307`,
    `RunProgress.tsx:96`, `mobile-handoff.ts:155`.
  - Engine state reads it in `engine/state.ts:291-293,527-540,577`,
    `actions.ts:729` and `reactions.ts:467`.
- **Mobile** reads **only** the old record. `useIssues` and `useIssue`
  (`apps/mobile/src/client/hooks.ts:167-183`) feed about 15 screens, and there are no
  projection reads.
- **Optimistic edits:** every issue overlay is minted on `issues`
  (`engine/overlay.ts:326-582`). The projection only gets a mirror
  (`overlay.ts:693-708`, `optimism.ts:292-303`), and the spawn placeholder inserts
  only into `issues` (`optimism.ts:649-653`).

**Server readers and emitters**

- **Emitters:**
  - `persistWith` and `persistManyWith` publish both kinds (`core.ts:1200-1225,1322-1331`),
    and so does `reconcileAndPublish` (`core.ts:1110-1120`).
  - Soft delete and restore publish only the old record (`crud.ts:1497,1522,1620`),
    and so does the git-state publish (`broadcastIssue`, `core.ts:1383-1403`).
- **Cost:** `toWire` does cross-issue work per row: it scans children, reads deps and
  dependents, counts comments and computes `blocked` (`core.ts:609-765`). Closes and
  reparents re-emit the full list (`core.ts:1354-1377`).
- **Server code that reads it back:**
  - mail delivery eligibility triggers only on `entity === 'issue'` (`relay.ts:2313-2335`);
  - session auto-archive (`session-teardown.ts:247-250`);
  - `snapshotTail` (`relay.ts:1099-1100`);
  - `syncChangesSince` (`lifecycle.ts:934`);
  - feed visibility (`feed-visibility.ts:274,303,643-652`);
  - change detection (`packages/sync/src/change-log.ts:138-166`).

**Wire compatibility**

- `CLIENT_WIRE_VERSION` is 3 and `MIN_CLIENT_WIRE_VERSION` is 1
  (`packages/protocol/src/version.ts`).
- Unknown kinds are ignored by old parsers, so **adding** kinds is safe.
- **Removing** the old record would make every released client show no issues: web
  view models return nothing, and mobile reads nothing else.
- The `changesSince` snapshot still requires `issues: IssueWire[]` (`sync.ts:364`).

**Guards that pin it**

- the residue register `issues-forwarder-transition` (`scripts/rearch-audit.ts:605-643`);
- the golden fixtures (`wire-golden.fixtures.ts:676-678`, `__fixtures__/golden/issues.json`);
- the representation registry (`representations/registry.ts:833`);
- about 150 test files.

## 4. Goals and non-goals

**Goals**

1. Every client reads issues only from the normalized record plus small, normalized
   kinds for the facts it lacks.
2. The server sends one issue record, and none of its publish work grows with the
   number of issues.
3. The web client's memory drops by about 40% on real data, as early as possible.
4. Every step ships on its own. Released clients keep working until they are
   explicitly retired by a minimum-version bump.

**Non-goals**

- Changing the large text fields, such as briefs loaded on demand. That belongs to the
  memory cutoff design, which comes later.
- The MobX sidebar pilot (POD-4948). It reads the normalized record already, and step
  1 removes its one temporary adapter (POD-4953).
- Sessions and ship orders. They are planned separately in step 8.

## 5. Target design

| Fact | Home after the migration |
|---|---|
| The issue's own fields | `issueProjection` (unchanged) |
| `readAt`, `tuckedAt`, `pinned` | a new per-user kind keyed (user, issue), visible only to its user (ADR 4 amendment 1, D10; the model exists at `packages/model/src/user-state/issue-state.ts`) |
| `gitState` | a new server-maintained `issueGitState` entity (ADR 4 D7.4), published when the git state changes |
| `repoPath` | a field on the repo row |
| `commentCount` | not carried; the miniview loads it with the comments (`issues.comments`) |
| `ready`, `blocked`, `deferred`, child counts, `displayRef`, prefix, `unread`, `sessionSummary` | computed on the client from normalized rows (already done: `deriveIssueViews`, `deriveIssueRollups`, `issue-views.ts:314-412`) |
| synthetic parent-child deps | derived on the client from `parentId` |

## 6. Steps

Each step is one sub-issue with its own brief. The substeps below are the scope.

**Step 1: new homes for the old-only fields (POD-4967).** This step is additive, so
nothing is removed.

- 1a. The per-user issue-state kind: server store, publish, visibility and client
  replica kind.
- 1b. The `issueGitState` entity from the server's `gitStates` map.
- 1c. `repoPath` on the repo row.
- 1d. The comment count is loaded with the comments in the miniview.
- 1e. Soft delete, restore and the git-state publish also emit the normalized record
  and the new kinds, in the same commit.

**Step 2: web reads only the normalized record (POD-4968).**

- 2a. View models are built without the old record.
- 2b. The merge predicates read `issueGitState`.
- 2c. The worklist's fallback to `store.issues` goes.
- 2d. The four direct readers move over.
- 2e. The UI uses the projection's spellings.
- 2f. Engine state readers move over.

**Step 3: optimistic edits target the normalized record (POD-4969).**

- 3a. Every overlay kind is minted on `issueProjections`, or on the per-user kind.
- 3b. The spawn placeholder inserts a normalized row.
- 3c. The mirror code goes.
- 3d. Baseline and hold lookups move over.

**Step 4: web stops storing the old record (POD-4970).**

- 4a. The old record is dropped on ingest, behind a switch that is on for web and off
  for mobile.
- 4b. Offline caches written by older builds still load.
- 4c. Memory is measured before and after, on real data and on the corpus.

**Step 5: server readers move over (POD-4971).**

- 5a. Mail eligibility triggers on the normalized record. This is tested first: if it
  is missed, mail stops silently.
- 5b. Session auto-archive.
- 5c. Feed visibility.
- 5d. Change detection.
- 5e. `snapshotTail` and `syncChangesSince` are marked as the only remaining readers,
  kept for old clients until step 7.

**Step 6: mobile reads the normalized record (POD-4972).**

- 6a. The hooks move to the step-2 view models.
- 6b. About 15 screens are checked.
- 6c. Mobile keeps storing the old record until its release is out.
- 6d. The release goes out through TestFlight, and reported client versions are
  watched until no older build connects.

**Step 7: stop sending the old record and delete it (POD-4973).**

- 7a. The minimum client version is raised after step 6's adoption check, and the v1
  and v2 wire adapters are retired.
- 7b. The `issue` kind is no longer emitted.
- 7c. `changesSince` answers `issues: []`.
- 7d. `toWire`'s cross-issue work and the full-list re-emits are deleted, and the
  server publish cost is measured before and after.
- 7e. `IssueWire`, its registry row, the residue entry, the goldens, the `issues`
  collection and their tests are deleted.
- 7f. The web drop switch from step 4 goes.

**Step 8: sessions and ship orders (POD-4974), planned first.** `SessionMeta` carries
server-computed extras:

- `displayRef`;
- `machineName`;
- `handoffTarget`;
- `queuedMessageCount`;
- the `offer` and `snoozedUntil` overlays;
- per-user `readAt` and `unread`.

`ShipOrderProjection` carries cross-order ranks. This step writes a plan like this one
for the operator's approval before any code.

**Order:**

1. Step 1 first.
2. Then steps 2, 3 and 5 in parallel.
3. Step 4 after steps 2 and 3; step 6 after steps 2 and 3.
4. Step 7 last, after steps 4, 5 and 6.
5. Step 8 is independent.

## 7. Compatibility rules

- **Add before remove.** No field, kind or emit is removed before every supported
  client reads its replacement.
- **Old clients.** Until step 7a they keep receiving the old record unchanged. Step 7a
  refuses them *cleanly*, with a minimum-version error, never with a silent empty list.
- **Offline caches.** A cache written by any earlier build must still load after every
  step. Unknown kinds are ignored; missing new kinds mean "not loaded yet", never an
  error.
- **Per-user privacy.** The per-user kind is visible only to its own user. This is
  tested with two principals.

## 8. Testing and evidence per step

- Every behaviour change has a focused test proven to fail on a planted mistake.
- Every step also shows two things:
  - **Equivalence:** web and mobile view models are identical with and without the old
    record, on the corpus fixture and on an offline export of the operator's data. The
    export stays on ludovico, and only counts and ids are reported.
  - **No regression:** the web perf lane and the relevant e2e lanes pass.
- **Numbers:**
  - Step 4 reports client memory before and after.
  - Step 7 reports the server's publish cost before and after.
- Tests, typecheck and lint run on flatblock.

## 9. Rollout and rollback

- Steps 1, 2, 3, 5 and 6 are additive or client-internal, and each is reverted by
  reverting its commits.
- Step 4 has its own switch, so turning it off restores storing the old record.
- Step 7 is the only one-way step. It runs only after step 6's adoption check and a
  release note, and it is gated on the operator's go-ahead.

## 10. Risks

1. **Mail stops silently** if step 5a is missed. This is why it is tested first.
2. **Mobile adoption is slow**, which delays step 7. Steps 1 to 6 still deliver the
   web memory win.
3. **Spelling mismatches** between the two records (`asked`, `intentOrigin`,
   `isDraftVessel`). Step 2's equivalence test catches them.
4. **Per-user state races** between the per-user kind and optimistic overlays. Step 3
   covers every overlay kind.
5. **Old offline caches.** This is tested in step 4b.

## 11. Open questions

- Should the comment count be carried at all? The proposal is no: load it on demand.
  The alternative is a server-maintained count entity.
- The minimum client version for step 7a depends on step 6's adoption numbers.

## 12. Amendments (2026-10-01, pre-start review)

The code references above still match `integrate/4286-pilot` (checked line by line).
The review found four gaps, now written into the step issues:

1. **The MobX pool's one old-record join.** `packages/client-graph/src/shared/temporary-issue-input.ts`
   (used by `shared/row-source.ts`) reads the six old-only fields. Step 2 (POD-4968) switches it to
   the step-1 kinds and the normalized spellings, then deletes it. Step 4 does not start until no
   web or client-graph module reads the `issue` kind (a lint rule from step 2 enforces this).
2. **Planted-mistake proofs per risky reader.** Step 5 (POD-4971) proves mail eligibility,
   auto-archive, feed visibility and change detection each work with only the normalized record,
   and that each test fails when the normalized branch is removed. Step 3 (POD-4969) does the same
   per overlay kind.
3. **A measurable gate for step 7.** Step 6 (POD-4972) reports connected mobile client versions;
   step 7 starts only when no client older than the release containing step 6 has connected for
   7 consecutive days.
4. **Leftover references.** Step 7 also sweeps `IssueWire` names in `packages/client-graph`
   (schema metadata, diagnostics) and the prototype package.

Step 1 also registers the new kinds in `packages/client-core/src/replica` (kinds, facade, contract,
bootstrap); later steps read them there.

**Landing and models.** Every step lands on the epic integration branch `integrate/4286-pilot`;
the operator moves it to `dev/mw`. Steps 3, 5, 7 and 8 run on Opus 5.5 high; steps 1, 2, 4 and 6
on gpt-6.1 sol max.
