import { createLogger } from '@podium/logger'
import {
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asUserId,
  IssueDep,
  type IssueDepId,
  type IssueDepProjection,
  type IssueId,
  type IssueProjection,
  issueDepId,
  issueDepToWire,
  Repo,
  type RepoId,
  type RepoProjection,
  repoToWire,
  toWire,
} from '@podium/model'
import { fromStorage } from '../../store/issue-storage'
import type { IssueRow } from '../../store/types'

const log = createLogger('server:issues')

/** Map one stored issue through the R3 → R1 → R4 mapping pair. Ownership
 * comes from the stored attribution columns; labels come from their relation.
 * A stored question survives even when its historical asker is unknown.
 * Unwritten rows are refused because an invented revision could authorize a
 * stale edit. No session, child, dependency or comment read belongs here. */
export function issueRowToProjection(row: IssueRow, labels: string[]): IssueProjection {
  if (row.revision === undefined) {
    throw new Error(
      `issue ${row.id} has no revision — refusing to project it. Every stored row is ` +
        'assigned one by upsertIssue (and backfilled to 1 by the POD-792 migration), so ' +
        'this is an unwritten row literal, not a legacy row. Write it before projecting it.',
    )
  }
  const stored = fromStorage(row)
  if (!row.ownerUserId || !row.createdByActor || row.createdByOnBehalfOf === undefined) {
    throw new Error('issue ' + row.id + ' has incomplete ownership attribution')
  }
  const actor = row.createdByActor.startsWith('session:')
    ? actorAgent(asAgentIdentityId(row.createdByActor.slice('session:'.length)))
    : row.createdByActor.startsWith('system:')
      ? actorSystem(row.createdByActor.slice('system:'.length))
      : actorUser(asUserId(row.createdByActor))
  const ownership = {
    owner: row.ownerUserId,
    visibility: row.visibility ?? 'personal',
    createdBy: { actor, onBehalfOf: row.createdByOnBehalfOf },
  }
  const { askedLegacy, asked, ...issue } = stored
  const question =
    asked ??
    (askedLegacy?.question ? { ...askedLegacy, question: askedLegacy.question } : undefined)
  return toWire({
    ...issue,
    ...ownership,
    labels,
    // Unknown historical askers stay unknown; a stored question is never dropped.
    ...(question ? { asked: question } : {}),
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
): { id: IssueId; value: IssueProjection }[] | undefined {
  const out: { id: IssueId; value: IssueProjection }[] = []
  for (const row of rows) {
    try {
      out.push({ id: row.id, value: issueRowToProjection(row, labelsOf(row.id)) })
    } catch (err) {
      log.warn(
        'an issue could not be projected — skipping the whole issueProjection publish so reconcile cannot mistake a partial list for a delete',
        { err, issueId: row.id },
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
): { id: IssueDepId; value: IssueDepProjection }[] | undefined {
  const out: { id: IssueDepId; value: IssueDepProjection }[] = []
  for (const dep of deps) {
    try {
      const value = issueDepToProjection(dep)
      out.push({ id: value.id, value })
    } catch (err) {
      log.warn(
        'a dependency could not be projected — skipping the whole issueDep publish so reconcile cannot mistake a partial list for deleted dependencies',
        { err, fromId: dep.fromId, toId: dep.toId, depType: dep.type },
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
  repos: Iterable<{ repoId: RepoId | null; prefix: string | null; path?: string }>,
): { id: RepoId; value: RepoProjection }[] {
  const byId = new Map<string, RepoProjection>()
  for (const repo of repos) {
    if (!repo.repoId) continue
    // `.parse()` brands the RepoId — see issueDepToProjection.
    // Several machine checkouts can share an id. Pick the same root regardless
    // of registry iteration order, so a repeated reconcile cannot flap paths.
    const current = byId.get(repo.repoId)
    const repoPath = repo.path ?? null
    if (current?.repoPath && (repoPath === null || current.repoPath <= repoPath)) continue
    byId.set(
      repo.repoId,
      repoToWire(Repo.parse({ id: repo.repoId, prefix: repo.prefix, repoPath })),
    )
  }
  return [...byId].map(([id, value]) => ({ id: id as RepoId, value }))
}
