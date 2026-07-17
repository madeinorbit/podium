import { fromStorage, type IssueProjection, IssueStorageRow, toWire } from '@podium/model'
import type { IssueRow } from '../../store'

/**
 * `IssueRow` → `IssueProjection` — the server's one adapter onto THE model
 * mapping pair [POD-796, ADR 4 D3.4].
 *
 * This file deliberately contains NO field logic. It reaches the projection by
 * calling the model's own functions:
 *
 *     IssueRow ──(this adapter)──► IssueStorageRow ──fromStorage──► Issue ──toWire──► IssueProjection
 *
 * The two arrows that carry MEANING (`fromStorage`, `toWire`) are the model's,
 * not ours. ADR 4 D3.4 rejects "multiple ad-hoc mappers per hop | Guarantees
 * drift", so the temptation this file exists to resist is writing a direct
 * `IssueRow → IssueProjection` serializer: it would be shorter, and it would be
 * a second definition of every field's encoding, free to drift from
 * `packages/model` one field at a time. What is left here is the ONE thing the
 * model cannot know — how today's hand-written `IssueRow` interface spells the
 * same row the model's `IssueStorageRow` spells.
 *
 * ## The whole delta between `IssueRow` and `IssueStorageRow`
 *
 * `storage.ts` already documents it from the model's side, under "DIVERGENCE
 * from today's `IssueRow`": twelve keys that `IssueRow` marks OPTIONAL, each
 * with the same comment — "Optional so pre-existing row literals stay valid" —
 * where the model has them required-and-nullable, which is the actual shape of
 * the column. `revision` is a thirteenth with the same shape (`revision?:
 * number`) that predates that list.
 *
 * That optionality is a concession to hand-built row LITERALS (tests, ingest),
 * not a statement about the data: `IssuesRepository.mapIssueRow` fills every one
 * of them on the way out of sqlite (`?? null`, `?? 'human'`, `draft === 1`,
 * `revision ?? 1`). So for a STORED row this adapter's `??` defaults are all
 * no-ops, and they earn their keep only on the literals — which is exactly where
 * `IssueRow` says they are legal.
 *
 * Values, not just types: each default below restates the default `IssueRow`'s
 * own doc comment declares for that key ("absent = 'human'", "absent = false",
 * "null/absent = never opened"), so this adapter agrees with the interface it
 * adapts rather than inventing a second answer.
 *
 * ## Why `.parse()` rather than a cast
 *
 * `IssueStorageRow.parse` both VALIDATES and brands (`IssueId`/`RepoId`/…), so
 * the branded types arrive honestly instead of through an `as`. It costs one
 * extra zod parse per row per publish — O(issues), never O(issues × sessions),
 * which is the only complexity that matters here (D7.2).
 *
 * Note this is a STRICTER boundary than today's serializer, by design and per
 * `storage.ts`: today `row.stage as IssueWire['stage']` is a blind cast, so an
 * unrecognised stored `stage`/`type`/`origin`/`audience` flows onto the wire
 * mislabelled as valid. `fromStorage` parses instead and REFUSES it. See
 * {@link issueProjectionRows} for what the publish path does with that refusal.
 */
export function issueRowToProjection(row: IssueRow): IssueProjection {
  return toWire(fromStorage(issueRowToStorageRow(row)))
}

function issueRowToStorageRow(row: IssueRow): IssueStorageRow {
  // THE revision decision [POD-796; ADR 2 D3].
  //
  // `IssueRow.revision` is optional; `IssueStorageRow.revision` is a required
  // positive int. This throw is the seam between them, and it refuses rather
  // than fabricates ON PURPOSE.
  //
  // A stored row ALWAYS has one, by two independent guarantees: `upsertIssue` is
  // the issues table's only SQL writer and assigns `revision = (current ?? 0) + 1`
  // on every accepted write, and POD-792's migration backfilled 1 into every row
  // that predates the column (`mapIssueRow` also reads `?? 1` as defence in
  // depth). So `revision === undefined` here does not mean "an old row" — it
  // means the value never came out of the store at all: a row literal that was
  // never written, i.e. a programming error at the call site.
  //
  // Fabricating one (say `1`) would be the actively dangerous choice. `revision`
  // is the token `expectedRevision` compares against for conflict detection
  // (ADR 1 / POD-793): a made-up `1` is not a neutral placeholder, it is a
  // CLAIM that this row is at its first write. Publish that and a client can
  // echo it back as an `expectedRevision` precondition that the authority then
  // accepts against a row at revision 47 — a stale write applied as if it were
  // current, which is precisely the failure the token exists to prevent. A
  // throw is loud, local, and cannot corrupt anything downstream.
  if (row.revision === undefined) {
    throw new Error(
      `issue ${row.id} has no revision — refusing to project it. Every stored row is ` +
        'assigned one by upsertIssue (and backfilled to 1 by the POD-792 migration), so ' +
        'this is an unwritten row literal, not a legacy row. Write it before projecting it.',
    )
  }
  return IssueStorageRow.parse({
    ...row,
    // The thirteen keys IssueRow marks optional; every default restates the one
    // IssueRow's own doc comment declares. See the file docstring.
    repoId: row.repoId ?? null,
    machineId: row.machineId ?? null,
    deletedAt: row.deletedAt ?? null,
    readAt: row.readAt ?? null,
    color: row.color ?? null,
    panel: row.panel ?? null,
    humanQuestionOptions: row.humanQuestionOptions ?? null,
    humanQuestionAskedBy: row.humanQuestionAskedBy ?? null,
    humanQuestionAskedAt: row.humanQuestionAskedAt ?? null,
    origin: row.origin ?? 'human',
    audience: row.audience ?? 'human',
    draft: row.draft ?? false,
    revision: row.revision,
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
 * structurally corrupt rows at hydration, and `upsertIssue` rejects an invalid
 * `stage` on write. What can still land here is a value the model refuses that
 * the store never validated — an unknown `type`, or panel JSON that isn't valid
 * JSON — i.e. a hand-mangled database. It is logged loudly rather than counted,
 * because it should never happen and one WARN per publish is the right volume
 * for something that means "your database has a row nothing else can read".
 */
export function issueProjectionRows(
  rows: Iterable<IssueRow>,
): { id: string; value: IssueProjection }[] | undefined {
  const out: { id: string; value: IssueProjection }[] = []
  for (const row of rows) {
    try {
      out.push({ id: row.id, value: issueRowToProjection(row) })
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
