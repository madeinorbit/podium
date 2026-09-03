/**
 * The issue registry's revision refusal [POD-3259, spec §3.6 model (b)].
 *
 * Thrown when a write would land on top of an issue row that MOVED after the
 * draft carrying it was cut: {@link IssuesRepository.upsertIssue}'s
 * `expectedRevision` precondition refuses INSIDE the transaction, so the loser's
 * write rolls back instead of silently overwriting the winner's columns.
 *
 * ONE GUARD, DELIBERATELY, and the second one is worth recording because it was
 * written first. `IssueRegistry.persistWith` also checked the pin against the
 * in-memory map before installing. That check can never fire — the install
 * follows the write, so a moved row has already been refused durably — and it
 * can fire WRONGLY, because a `reload()` landing between the commit and the
 * install re-hydrates the map to the revision this very write just committed,
 * and the install would then refuse itself. An unreachable guard that has a
 * false-positive arm is worse than no guard.
 *
 * While the store is synchronous this cannot fire either: nothing can run
 * between cutting a draft and committing it. It exists for the awaits this epic
 * is about to introduce, and the interleaving tests in
 * `modules/issues/service/issue-registry-model.test.ts` are what prove it is
 * armed rather than merely present.
 *
 * It lives in the store layer because the durable guard does, and `modules`
 * already imports from `store` (never the other way round).
 */
export class StaleIssueRevisionError extends Error {
  constructor(
    readonly issueId: string,
    readonly expected: number | null,
    readonly found: number | null,
  ) {
    super(
      `issue ${issueId} moved under this draft: expected revision ${expected ?? 'none'}, found ${found ?? 'none'}`,
    )
    this.name = 'StaleIssueRevisionError'
  }
}
