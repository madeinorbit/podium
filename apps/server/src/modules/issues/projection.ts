import {
  FIRST_ADMIN_USER_ID,
  IssueDep,
  type IssueDepProjection,
  type IssueProjection,
  issueDepId,
  issueDepToWire,
  Repo,
  type RepoProjection,
  repoToWire,
  toWire,
  visibilityClassOf,
} from '@podium/model'
import { fromStorage } from '../../store/issue-storage'
import type { IssueRow } from '../../store'

/**
 * `IssueRow` → `IssueProjection` — the server's one adapter onto THE model
 * mapping pair [POD-796, ADR 4 D3.4].
 *
 * This file deliberately contains NO field logic. It reaches the projection by
 * calling the two mappings that already exist, in the order they compose:
 *
 *     IssueRow ──fromStorage──► StoredIssue ──(+ §"what storage cannot carry")──►
 *     IssueAggregate ──toWire──► IssueProjection
 *
 * BOTH ARROWS THAT CARRY MEANING ARE SOMEONE ELSE'S. `fromStorage` is
 * `store/issue-storage.ts`'s hand-written per-key R3→R1 mapper (POD-1151); `toWire`
 * is the model's R1→R4 (`projections/issue-projection.ts`). ADR 4 D3.4 rejects
 * "multiple ad-hoc mappers per hop | Guarantees drift", so the temptation this
 * file exists to resist is writing a direct `IssueRow → IssueProjection`
 * serializer: it would be shorter, and it would be a second definition of every
 * field's encoding, free to drift one field at a time.
 *
 * MAIN CALLED `fromStorage` FROM `@podium/model`, AND THAT IMPORT DOES NOT SURVIVE
 * THE CATCH-UP. Main derived its R1↔R3 pair from a schema (`issue/storage.ts`'s
 * `IssueStorageRow` = the durable shape plus five encoding overrides). This branch
 * had already measured that a schema derivation cannot work against ITS aggregate
 * — the divergence is not a uniform transform (stored TEXT vs enums, raw JSON vs
 * objects, three renames on composition, historical optionality), and a
 * structurally-checked derivation cannot notice that `intentOrigin` and
 * `audience` are type-identical members naming DIFFERENT FACTS. So the pair lives
 * in `store/issue-storage.ts` as a mapper checked per key, and porting main's
 * schema pair beside it would have installed exactly the second-mapper-per-hop
 * that D3.4 names. One pair, and it is that one.
 *
 * ## What storage cannot carry, and why this file names it rather than fills it
 *
 * `StoredIssue` is `IssueAggregate` minus the five members the `issues` table has
 * no column for — `owner`, `visibility`, `createdBy`, `lastLifecycleActor` and
 * `labels` (`ISSUE_R1_MEMBERS_STORAGE_CANNOT_CARRY`). Three of them are REQUIRED on
 * R1 and therefore on R4, so the projection cannot be built without an answer.
 *
 * `fromStorage` deliberately refuses to invent one — ADR 9 D8 S5 forbids
 * defaulting `onBehalfOf` to the operator, and a mapper is the last place anyone
 * would look for the multi-user model's defaults. The answer instead is stated
 * ONCE, here, as {@link SINGLE_USER_ISSUE_OWNERSHIP}: this instance has one human,
 * `FIRST_ADMIN_USER_ID`, and issues are `personal` on ADR 1's matrix. That is the
 * same shape the rest of the tree already uses for the single-operator assumption
 * (`SINGLE_USER_CEILING`, `SINGLE_USER_HUMAN`, `SINGLE_USER_WORKFLOW_OWNERSHIP`) —
 * a named constant with a successor issue, not a literal at a call site. POD-1075
 * replaces it with the columns; grep for the constant to find every place that has
 * to change.
 *
 * `labels` is different in kind and is NOT part of that constant: it is real data,
 * stored in the `issue_labels` join table, and it is passed IN. A default of `[]`
 * would publish "this issue has no labels" for every issue on the feed, which is a
 * wrong answer rather than a missing one.
 *
 * ## Why `revision` is refused rather than defaulted
 *
 * `IssueRow.revision` is optional and `IssueConcurrency.revision` is optional, both
 * because a row LITERAL that has never been written has none. A STORED row always
 * has one, by two independent guarantees: `upsertIssue` is the issues table's only
 * SQL writer and assigns `revision = (current ?? 0) + 1` on every accepted write,
 * and POD-792's migration backfilled 1 into every row that predates the column. So
 * `revision === undefined` here does not mean "an old row" — it means the value
 * never came out of the store at all: a row literal, i.e. a programming error at
 * the call site.
 *
 * Fabricating one (say `1`) would be the actively dangerous choice. `revision` is
 * the token `expectedRevision` compares against for conflict detection (ADR 1 /
 * POD-793): a made-up `1` is not a neutral placeholder, it is a CLAIM that this row
 * is at its first write. Publish that and a client can echo it back as an
 * `expectedRevision` precondition that the authority then accepts against a row at
 * revision 47 — a stale write applied as if it were current, which is precisely the
 * failure the token exists to prevent. A throw is loud, local, and cannot corrupt
 * anything downstream; {@link issueProjectionRows} turns it into a skipped publish.
 */

/**
 * THE SINGLE-OPERATOR ANSWER to the three R1 members `issues` has no column for.
 *
 * Not a default and not a fallback — a stated assumption with a successor
 * (POD-1075), in one place, so that adding the columns is a compile-time sweep of
 * this constant's references rather than an audit of every mapper. `visibility` is
 * read from ADR 1's matrix rather than written as a literal, so a matrix change
 * reaches the wire instead of two files disagreeing about what an issue is.
 *
 * `lastLifecycleActor` is deliberately absent: it is OPTIONAL on R1, and "we do not
 * know who last closed this" is honestly spelled by omitting it. Only the required
 * members need an answer here.
 */
export const SINGLE_USER_ISSUE_OWNERSHIP = {
  owner: FIRST_ADMIN_USER_ID,
  visibility: visibilityClassOf('issues'),
  createdBy: { actor: { kind: 'user', id: FIRST_ADMIN_USER_ID }, onBehalfOf: FIRST_ADMIN_USER_ID },
} as const

/**
 * One stored row → its wire projection.
 *
 * `labels` is required because it is real data this row does not carry; see the
 * file docstring on why `[]` is a wrong answer rather than a missing one.
 */
export function issueRowToProjection(row: IssueRow, labels: string[]): IssueProjection {
  if (row.revision === undefined) {
    throw new Error(
      `issue ${row.id} has no revision — refusing to project it. Every stored row is ` +
        'assigned one by upsertIssue (and backfilled to 1 by the POD-792 migration), so ' +
        'this is an unwritten row literal, not a legacy row. Write it before projecting it.',
    )
  }
  const stored = fromStorage(row)
  const { askedLegacy: _askedLegacy, asked, ...issue } = stored
  return toWire({
    ...issue,
    ...SINGLE_USER_ISSUE_OWNERSHIP,
    labels,
    // `StoredAsked` is `NeedsHuman.asked` MINUS its attribution half, for the
    // same reason `createdBy` is absent: no column, and ADR 9 D8 S5 forbids a
    // mapper defaulting `onBehalfOf`. Re-attached from the same named constant
    // so the pair stays all-or-nothing on the wire (POD-365) instead of shipping
    // a "when" with no "who".
    ...(asked
      ? { asked: { ...asked, attribution: SINGLE_USER_ISSUE_OWNERSHIP.createdBy } }
      : {}),
  })
}

/**
 * Full-truth `issueProjection` reconcile rows for a LOCAL issue set, or
 * `undefined` when the set cannot be projected in full.
 *
 * ## Why this is all-or-nothing, and not a per-row skip
 *
 * `Ledger.reconcile` is a FULL-TRUTH diff: every baseline id NOT present in the
 * rows it is handed is diffed as a REMOVE. So a per-row `try/catch` that skipped
 * a poison row would not degrade gracefully — it would tell every cap client
 * that the issue was DELETED, and the ledger would durably record that lie. The
 * partial list is not a smaller truth; under reconcile's contract it is a
 * different, wrong one.
 *
 * Returning `undefined` instead leaves the projection baseline untouched: cap
 * clients keep their last-known-good projection (stale by one publish) and the
 * next successful publish heals it. Stale-but-present beats confidently-deleted,
 * and staleness here is self-correcting where a durable phantom remove is not.
 *
 * The legacy path is unaffected either way — `reconcile('issue', …)` and the
 * snapshot fan-out run regardless, so a poison row costs the NEW feed a publish
 * and costs old clients nothing. That is what "additive" has to mean under a
 * flag: the new path may degrade, but it may never damage the old one.
 *
 * In practice this is close to unreachable: `listIssueRows` already quarantines
 * structurally corrupt rows at hydration, `upsertIssue` rejects an invalid
 * `stage` on write, and `fromStorage` is a total decoder by design. What can
 * still land here is a row literal with no revision, or a value `IssueProjection`
 * refuses that the store never validated — i.e. a programming error or a
 * hand-mangled database. It is logged loudly rather than counted, because it
 * should never happen and one WARN per publish is the right volume for something
 * that means "your database has a row nothing else can read".
 */
export function issueProjectionRows(
  rows: Iterable<IssueRow>,
  labelsOf: (id: string) => string[],
): { id: string; value: IssueProjection }[] | undefined {
  const out: { id: string; value: IssueProjection }[] = []
  for (const row of rows) {
    try {
      out.push({ id: row.id, value: issueRowToProjection(row, labelsOf(row.id)) })
    } catch (err) {
      console.warn(
        `[podium:issues] issue ${row.id} could not be projected — skipping the whole ` +
          'issueProjection publish so reconcile cannot mistake a partial list for a delete',
        err,
      )
      return undefined
    }
  }
  return out
}

// ---- The two kinds the replica JOINS against [POD-822] ----
//
// Neither can be a field on `IssueProjection`, and the reason is the same one
// twice (ADR 4 D7.2 — "a change to entity X may trigger recomputation only of
// projections of X"): a dep edge belongs to two issues, and a prefix belongs to
// a repo. Fold either onto the issue and a write to something else has to
// rewrite issues — an edge add would dirty both endpoints, a prefix change would
// dirty every issue in the repo. As their own kinds, each change is ONE row, and
// the replica does the join where it is free (D7.3). See model's `issue/dep.ts`
// and `repo/fields.ts` for the decisions; this file only spells the server's
// rows in the model's vocabulary.

/** One `issue_deps` row → its projection. The edge's id is DERIVED from its
 *  primary key (`issueDepId`), so the feed's identity and the store's are the
 *  same identity — see model's `issue/dep.ts` on why a minted id would leak
 *  phantom edges the store could never remove. */
export function issueDepToProjection(dep: {
  fromId: string
  toId: string
  type: string
}): IssueDepProjection {
  // `.parse()` rather than a cast, for the reason the file docstring gives above:
  // it VALIDATES and BRANDS, so the IssueId/IssueDepId arrive honestly instead of
  // through an `as`. It also refuses an empty id or type here rather than letting
  // one reach the feed as a well-typed lie.
  return issueDepToWire(
    IssueDep.parse({
      id: issueDepId(dep.fromId, dep.toId, dep.type),
      fromId: dep.fromId,
      toId: dep.toId,
      type: dep.type,
    }),
  )
}

/**
 * Full-truth `issueDep` reconcile rows.
 *
 * All-or-nothing on failure for exactly the reason {@link issueProjectionRows}
 * documents at length: `Ledger.reconcile` diffs the FULL truth, so a partial
 * list is not a smaller truth — every edge missing from it is diffed as a
 * REMOVE and durably recorded as one. `undefined` leaves the baseline alone and
 * the next publish heals it; a partial list would tell every replica that real
 * dependencies had been deleted, and `blocked` would flip to `false` on issues
 * that are genuinely blocked. That is the POD-822 failure mode arriving by
 * another road, which is precisely why this degrades the same way.
 *
 * The only reachable throw is `issueDepId`'s separator guard (a `|` in an issue
 * id or dep type), i.e. an id whose grammar is not ours.
 */
export function issueDepProjectionRows(
  deps: Iterable<{ fromId: string; toId: string; type: string }>,
): { id: string; value: IssueDepProjection }[] | undefined {
  const out: { id: string; value: IssueDepProjection }[] = []
  for (const dep of deps) {
    try {
      const value = issueDepToProjection(dep)
      out.push({ id: value.id, value })
    } catch (err) {
      console.warn(
        `[podium:issues] dep ${dep.fromId} -> ${dep.toId} (${dep.type}) could not be projected — ` +
          'skipping the whole issueDep publish so reconcile cannot mistake a partial list for ' +
          'deleted dependencies',
        err,
      )
      return undefined
    }
  }
  return out
}

/**
 * Full-truth `repo` reconcile rows — the LOGICAL repos, keyed by `repoId`.
 *
 * `listRepos()` returns one row per `(machineId, path)`; the entity is the
 * logical repo, so sibling checkouts of one repo collapse to ONE row here. That
 * is not a convenience: `repo_prefixes` is keyed by `repo_id` precisely because
 * checkouts share a prefix (store/repos.ts), so emitting per-checkout rows would
 * publish the same prefix under several ids and give the replica's join two
 * answers. Rows with no `repoId` are dropped — an unidentified repo has no
 * prefix to join against and no stable id to address.
 *
 * O(repos) — a handful of rows, and the ledger's byte-equality dedup means an
 * unchanged set appends nothing. This never runs per-issue.
 */
export function repoProjectionRows(
  repos: Iterable<{ repoId: string | null; prefix: string | null }>,
): { id: string; value: RepoProjection }[] {
  const byId = new Map<string, RepoProjection>()
  for (const repo of repos) {
    if (!repo.repoId) continue
    // `.parse()` brands the RepoId — see issueDepToProjection.
    byId.set(repo.repoId, repoToWire(Repo.parse({ id: repo.repoId, prefix: repo.prefix })))
  }
  return [...byId].map(([id, value]) => ({ id, value }))
}
