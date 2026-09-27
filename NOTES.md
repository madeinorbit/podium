# N1a MobX change exercise — scratch notes (NOT a deliverable; delete before landing)

Issue: this issue (`POD-4592`). Arm: `packages/worklist-proto/arms/mobx/pool/` (round-three pool).
Deliverable: `docs/decisions/pod-4545-round-three-n-mobx-changes.md` (table first)
+ diffs under `docs/decisions/pod-4545-round-three-n-mobx-diffs/`.
M5 (POD-4600) verdict: READY FOR JUDGEMENT, MUST-FIX empty — nothing blocks this exercise.

## Read so far (STEP 1, README-only discipline)

- `arms/mobx/README.md` (round-three pool sections: Idiom, enumeration module,
  write path, stats, gates, "How to add a field") — the ONLY arm file read before expectations.
- Shared contracts the README points at: `shared/src/schema.ts` (L1a),
  `shared/src/row-view.ts` (L1b). Methodology §5.9, audit §§3/5/6/7,
  L1a (POD-4546) + L6a (POD-4563) issue records, round-two K MobX exercise doc
  (table format precedent).
- NOT yet opened: any file under `arms/mobx/pool/`.

## Expectations (written BEFORE opening arm code)

### A — snooze (time-dependent membership)
Concrete: new optional issue field `snoozedUntil` (isoDate). While
`coarseNow < snoozedUntil` the row is not visible (membership) and `band = 2`
(RowView.band already names band 2 "snoozed"); the tick crossing the deadline
re-admits it.
Expect to touch: `shared/src/schema.ts` (field decl; coordinator-owned, throwaway
edit) → `pool/views.ts` (band part over own row + clock) →
`pool/worklist/visible.ts` (IssueNode standing/retention part: membership) →
`pool/clock.ts` (new deadline rule) → the rebuild (same rule; gate holds the two
together). No `RowView` contract change (band exists). No `models.ts` change
(getters install from schema). No `relations.ts` change.
Expect: L4b green trivially on fixture (no corpus row carries the field); a planted
probe (snoozedUntil set) must hide/reappear with exactly that row committing on the
crossing tick; non-carriers never subscribe to the new deadline.

### B — continuation line (derived row field)
Concrete: new `RowView` field `continuation: string | null`, e.g.
`"continued · <originRef>"` from the `discoveredFrom` edge (one hop), null with no
origin. Rides beside the snapshot; `sliceRowOf` drops it → oracle parity green by
construction.
Expect to touch: `shared/src/row-view.ts` (field decl; coordinator) →
`pool/views.ts` (new target part via `inputs.relations.one('issue', id,
'discoveredFrom')` + origin-fields part, assembled in `buildRowView`; new computed
on `IssueModel` + getter in `directParts` for the rebuild). No `relations.ts`,
no `models.ts` (probably), no list change (no new render needed — field only;
render only if I choose to paint it).
Expect: fixture parity green first try; an origin rename re-runs only spin-offs'
new part (README's originTick precedent). Risk flagged: annotation discipline for
a hand-added computed (round-two B hit TS2353 on the makeObservable map).

### C2 — worktree rows (second row kind)
Concrete: resident `worktree` entities drawn as rows in the same list/groups
(lanes holding prefix-owned sessions but no issues).
Expect to touch: `pool/worklist/visible.ts` (new node kind over the worktree
table) → `pool/worklist/groups.ts` (placement of lane rows) →
`pool/react/list.tsx` + `pool/native/list.tsx` (second slot kind) →
`shared/src/row-view.ts` (RowView is issue-shaped; lane rows need a contract
mapping, values invented where the worktree has no analogue) → rebuild (same lane
rows or gate fails) → enumeration rule check (worktree walk only via enumerate.ts).
Expect: parity FAIL by design vs the oracle (extra lane rows, zero missing/changed
issue rows — round-two C2 precedent: 37 extra). Fence: a lane flip commits exactly
the lane row. Biggest change; the 2h timebox may bind.

### D — blockedBy relation + inverse used by the row view
Concrete: schema-only addition on issue: `blockedBy` (edge OUT over `deps` of type
`'blocked-by'`, inverse `blockedByOf`) + `blockedByOf` (edge IN). Consumer: new
`RowView` field `blockedByCount` (via `RelationReader.size`, documented "free")
or blocker refs (via `many`); the row view reads the INVERSE side.
Expect to touch: `shared/src/schema.ts` ONLY + `shared/src/row-view.ts` (field) +
`pool/views.ts` (consumer part) + rebuild (same). `pool/relations.ts` UNTOUCHED —
the engine reads `schema[entity].relations` at construction and names no relation
(README; `relations.test.ts` fixture-schema test). If `relations.ts` needs an edit,
that IS the finding (brief §3 PITFALL).
Expect: `schema.test.ts` Rule-L check demands `lazy: true` (target issue can be
non-resident); gate green trivially (no corpus `blocked-by` deps); planted probe
with crafted `blocked-by` deps shows count + inverse maintenance both directions.

## Validation per change (throwaway branch `n1a-{a,b,c2,d}`, 2h timebox each)

1. `bun run test:file -- packages/worklist-proto/arms/mobx/pool/gate.test.ts`
   (L4b defaults 3x200; record seeds/steps; 20x300 gate-of-record only if load allows)
2. `bun run test:file -- packages/worklist-proto/arms/mobx/pool/counts.test.tsx`
   (fence steps #1-#4) + `bun run test:file -- packages/worklist-proto/harness/src/fences.test.tsx`
   (steps #1-#10 with parity; scope with `-t` to the MobX pool roster entry — check roster first)
3. Package lint on touched files; `bun run typecheck -- --filter @podium/worklist-proto`
4. Behavior probe (planted values; assertions transcribed into the table doc)
5. `git diff > docs/decisions/pod-4545-round-three-n-mobx-diffs/n1a-{a,b,c2,d}.patch`,
   then revert (delete branch; arm byte-identical), tests green.
Counts are evidence; no walls in this exercise (no browser runs planned).

## Open questions
- None for the coordinator yet. If shared/ edits turn out to need coordinator
  sign-off even on throwaway branches, ask via `podium issue mail send 4286`.
- Fences roster name for the MobX pool (check `harness/src/roster.ts` when implementing).
