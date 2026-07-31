# POD-1229 — "archive it because it was read": read by WHOM, and the evidence

Branch: `issue/1229-auto-archive-precondition-reads-per-user`, off `issue/279-integration`
at `5e3e4e00`. No merge of `main` or of the base into this branch.

Provenance: scheduled copy of proposal POD-1136, which a coordinator cannot promote out of the
`proposed` lane. Carries the deletion-audit item `per-user-singletons` (2 sites), re-phased here
from POD-1076 by the POD-279 coordinator.

---

## 1. The decision, in one paragraph

**The policy does not change: auto-archive is gated on the read of the one viewer the shared
`archived` flag speaks for.** POD-1210 settled that and its reasoning holds — ANY-user lets one
person archive work off a colleague's board, and ALL-users can never fire. **What changes is that
the wire now SAYS so.** Both observations carry `readerUserId` and no longer carry `readAt` at all,
and the server refuses any proposal naming a principal other than the viewer it archives for.

## 2. Why the open question was not "which of the three rules"

POD-1136's brief framed the choice as ALL / OWNER / drop-the-precondition. Reading POD-1210's
evidence in full, that choice was already made and made well. The live defect was somewhere else,
and it is the kind this run keeps finding.

`readAt: z.string().datetime()` is a per-user fact with **no user attached**. The janitor picked a
reader (`ARCHIVE_VIEWER`) and the server picked a reader (`broadcastViewer()`), and the two agreed
**only because both spell `FIRST_ADMIN_USER_ID`**. Nothing on the wire could represent a
disagreement, so nothing could test for one. The next step of POD-1077 — passing the request's real
principal — touches those two sites in two different packages. Change one and not the other and:

- the janitor observes user A's read state,
- the server revalidates user B's,
- every proposal comes back `precondition`,
- auto-archive is dead for the **third** time, silently, with a green suite.

That is the same failure POD-1210 fixed and the same one POD-1077 caused, one layer up. So the
work here is to make the agreement a **checked fact** rather than a coincidence of two constants.

## 3. Is a per-user precondition on a shared consequence coherent?

The brief asks this directly and says an honest "it cannot be decided yet" is acceptable. It can be
decided, and here is the argument.

The asymmetry is real but **bounded to exactly one reader**, and that is what makes it coherent.
Under "the designated viewer", the precondition is per-user in *mechanism* and single-valued in
*effect*: exactly one person's read state can ever move the shared flag, so no user can archive an
issue out of another user's board. Incoherence appears only under ANY (many readers driving one
shared consequence, which is arbitrary) or ALL (a consequence that can never fire). The shared
`archived` column is therefore the **reason** to pin the precondition to one reader, not evidence
against it.

**What would have to change for the fully per-user answer**, named as the brief requires:

1. `archived` joins the per-user state family — `(userId, entityId) → archivedAt`, one row per
   viewer, in `packages/model/src/user-state/`, plus a table migration and a replica migration.
2. POD-1077's per-principal fan-out has to land first, because a per-user `archived` has nowhere
   correct to be delivered while the feed is an unscoped broadcast (ADR 2 D2) — the same blocker
   POD-380 recorded against `readAt`, answered the same way POD-1076 answered it.
3. The server's refusal changes shape: from "the reader must be the viewer I archive for" to "the
   reader must be the principal whose flag you are setting". **The observation already carries the
   principal**, so that day is one comparison, not a wire change.
4. The janitor's `ARCHIVE_VIEWER` constructor argument becomes a loop over principals, and its
   keyset cursor stops being total per-user unless the user id joins the key.

Filed as its own issue rather than done here: it is a migration plus a wire cutover behind
POD-1077, and this issue can close without it.

## 4. Why `readAt` was DELETED rather than re-keyed

The obvious shape is `(readerUserId, readAt)` — the per-user fragment, keeping the timestamp. It
was rejected on merit, not to satisfy a detector.

`observed.readAt` bought exactly one thing: a compare-and-swap, `viewerReadAt !== observed.readAt →
precondition`. That is the janitor handing the authority's own state back to the authority to
string-compare, and the two cases it caught are both **already refused by checks that were there
before this issue**:

| Case | What used to catch it | What catches it now |
| --- | --- | --- |
| viewer re-read it after the observation | the CAS (timestamps differ) | the freshness cutoff → `not-due` (a re-read is by definition inside the window) |
| viewer marked it unread | the CAS (`null` vs a string) | `Date.parse(null ?? '')` is NaN → `precondition` (issue: also `computeUnread`) |

Both rows are mutation-proven in §6. Keeping a value on the wire whose only consumer is a check
that is redundant is how a payload accretes fields nobody can delete later.

This also removes the last two `per-user-singletons` sites **by deletion**, which is exactly how
POD-1076 cleared the other six: its own note says "deleting the *fields* — not the columns alone —
is what clears the ratchet". No detector was widened, narrowed, or re-phased to reach zero.

### What the run key loses, stated plainly

`issueAutoArchiveRunKey` / `sessionAutoArchiveRunKey` now carry `readerUserId` where `readAt` was.
Occurrence identity stays (entity, reader, shared preconditions), but one case degrades: an issue
that is **unarchived AND re-read** inside the 14-day `maintenance_commands` retention keeps its old
run key, so the replay answers `already-applied` until that row is pruned — after which the next
sweep archives it. Self-healing, worst case a delay. The neighbouring case (unarchived *without* a
re-read) was already blocked the same way while `readAt` was in the key, so this widens an existing
hole rather than opening a new one.

## 5. Protocol version

`MAINTENANCE_PROTOCOL_VERSION` 2 → 3, `MAINTENANCE_SCHEMA_VERSION` → `maintenance-v3`. This is the
case the gate exists for and it is not optional: zod **strips** unknown keys, so a v2 janitor's
`readAt` payload does not fail to parse — it arrives as an observation with no reader at all. The
handshake is the only thing that can stop it. The version literal is asserted with `toBe` in
`maintenance.test.ts`, and both schemas refuse a missing/blank `readerUserId` as a second line.

## 6. Evidence

### Instruments that had NEVER been asked to fire

`tryAutoArchiveObserved` and `tryAutoArchiveStoppedObserved` — the entire apply side, where the
policy actually lives — had **no direct test**. They were reachable only through a `vi.fn()` seam in
`modules/maintenance/service.test.ts`, and a mock that returns `'applied'` cannot fail when the
revalidation is wrong. POD-1210's five mutants all lived in the janitor's *query*. Twelve tests now
cover the apply side (`apps/server/src/issues.test.ts`,
`apps/server/src/modules/sessions/auto-archive-observed.test.ts`), each saying YES first on the same
fixture every refusal is measured against.

### One redundancy found and removed, because it could not say NO

The first draft added an explicit `viewerReadAt == null` refusal on both entities. **Mutant C
deleted it and all six tests stayed green** — the pre-existing `Number.isFinite` guard already
refused that case. Two guards where one fires means neither is provable, so the added clause was
removed rather than kept as decoration. Recorded here because a survived mutant that leads to
*deleting* code is the useful kind, and it is invisible in the final diff.

### Mutants — one at a time, on a committed tree, each verified to match exactly once, change the file hash, and revert clean

| # | Mutant | Result |
| --- | --- | --- |
| A | issue: drop the `readerUserId !== broadcastViewer()` refusal | **KILLED** — 2 tests |
| B | session: drop the same refusal | **KILLED** — 2 tests |
| C | issue: drop the added `viewerReadAt == null` guard | **SURVIVED** → the guard was deleted (above) |
| C2 | issue: drop `!Number.isFinite(readMs)` | **SURVIVED** → `computeUnread` also refuses it |
| C3 | issue: drop **both** `Number.isFinite` and `computeUnread` | **KILLED** — 1 test (the mark-unread case is covered, by a redundant pair; stated rather than implied) |
| D | issue: drop the `not-due` freshness cutoff | **KILLED** — 1 test |
| E | session: drop the `not-due` freshness cutoff | **KILLED** — 1 test |
| F | session: drop `!Number.isFinite(readMs)` | **KILLED** — 1 test (no redundancy on this entity) |
| G | janitor: session observation names a reader other than the one it queried | **KILLED** — 1 test |
| H | janitor: issue observation names a reader other than the one it queried | **KILLED** — 2 tests |

**POD-1210's five, re-run against this branch — all still killed:**

| # | Mutant | Result |
| --- | --- | --- |
| M1 | issue: archive regardless of read state (`LEFT JOIN` + null-tolerant cutoff) | **KILLED** — 3 tests |
| M2 | issue: read by ANY user (`OR 1 = 1`) | **KILLED** — 1 test |
| M3 | issue: cursor loses the `id` tiebreaker | **KILLED** — 1 test |
| M4 | session: archive regardless of read state | **KILLED** — 2 tests |
| M5 | session: read by ANY user | **KILLED** — 1 test |

### The audit zero is EARNED, not an artifact

`bun scripts/rearch-audit.ts --phase POD-1229` → *"all 1 deletion-audit items are at zero — clear to
close."*

`per-user-singletons` only inspects declarations that clear `ENTITY_SHAPE_THRESHOLD` (3 non-generic
vocabulary keys), so removing a key can drop a shape out of the *population* rather than out of the
*finding* — a zero for the wrong reason. Checked directly, one site at a time:

- re-add `readAt` to `IssueAutoArchiveObservation` → detector reports
  `maintenance.ts:185 IssueAutoArchiveObservation.readAt`
- re-add `readAt` to `SessionAutoArchiveObservation` → detector reports
  `maintenance.ts:195 SessionAutoArchiveObservation.readAt`

Both still visible, so the detector can still say NO about these exact sites. The general limit is
now written next to the item in `scripts/rearch-audit.ts`.

### Lanes

- `packages/protocol/src/maintenance.test.ts` + `apps/janitor/src` — 31 passed.
- `scripts/janitor-auto-archive.integration.test.ts` + `janitor-recovery.integration.test.ts` — 8 passed.
- `apps/server/src/modules/maintenance` + `issues.test.ts` + `modules/sessions` — 645 passed.
- `bun run typecheck` — 23/23 packages green.
- `bun run lint:boundaries` — `56 allowlisted, 0 new`.

> This worktree had **no `node_modules`** — `@podium/model` resolved to nothing and typecheck
> reported "has no exported member" for every symbol. `bun install` in the worktree first. Same trap
> POD-1210 hit, different symptom.

## 7. Limits of this change, stated

- **The policy is still one hardcoded viewer.** `FIRST_ADMIN_USER_ID` is spelled out in two places
  as before; what changed is that the two are now compared. Making it a real principal is POD-1077.
- **The mark-unread refusal on the issue path is redundantly covered** (`Number.isFinite` and
  `computeUnread`). Either alone suffices, so no single-line mutant kills it. That is genuine
  defence in depth, but it means the C3 compound mutant is the only proof — recorded above rather
  than left for a reader to discover.
- **`archived` is still shared.** §3 argues that is coherent under this rule and names what a
  per-user `archived` would take.
