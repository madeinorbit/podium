import type { SqlDatabase } from '@podium/runtime/sqlite'

/**
 * Repair messages.from_issue rows that hold a legacy REF STRING instead of a
 * real issue id (#463) [spec:SP-34d7].
 *
 * Migration 016 copied legacy `issue_messages` senders (`from_author` of the
 * form `issue:#<seq>`) straight into `messages.from_issue` without resolving
 * the seq to the internal `iss_…` id. The `messages` table itself has no FK,
 * but a REPLY to such a row resolves its target from `from_issue` and mirrors
 * into `issue_messages`, whose `issue_id` FK then fails — every migrated
 * message was unreplyable.
 *
 * Repair rule: for each `messages` row whose `from_issue` does not match an
 * existing `issues.id`, parse the seq out of the ref (`issue:#N`, `#N`, or a
 * bare `N`) and resolve it SCOPED TO THE RECIPIENT'S REPO — the repo owning
 * the message's recipient issue (`to_id` when to_kind='issue'), falling back
 * to the recipient session's attached issue's repo. Seq is only unique per
 * repo (migration 004), so a global lookup could mis-attribute the sender to
 * another repo's issue — worse than the bug. Anything that does not resolve
 * to exactly one issue in that repo becomes NULL (an unattributed sender is
 * acceptable; a wrong attribution is not).
 *
 * Idempotent: rows holding a valid issue id (including previously repaired
 * ones) are never touched, and NULLed rows stay NULL on re-run.
 */
export function up(db: SqlDatabase): void {
  const broken = db
    .prepare(
      `SELECT m.id, m.from_issue, m.to_kind, m.to_id
       FROM messages m
       WHERE m.from_issue IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.id = m.from_issue)`,
    )
    .all() as { id: string; from_issue: string; to_kind: string; to_id: string | null }[]
  if (broken.length === 0) return

  // The recipient issue: direct for issue-addressed rows, via the session's
  // attached issue for session-addressed rows.
  const recipientIssue = db.prepare(`SELECT repo_id, repo_path FROM issues WHERE id = ?`)
  const sessionIssue = db.prepare(
    `SELECT i.repo_id, i.repo_path FROM sessions s JOIN issues i ON i.id = s.issue_id
     WHERE s.id = ?`,
  )
  // Candidates by seq within one repo, keyed by the stable repo_id when both
  // sides have one, else the display path (mirrors resolveRef's scoping).
  const bySeqInRepo = db.prepare(
    `SELECT id FROM issues
     WHERE seq = ? AND COALESCE(repo_id, repo_path) = COALESCE(?, ?)`,
  )
  const update = db.prepare('UPDATE messages SET from_issue = ? WHERE id = ?')

  for (const row of broken) {
    let resolved: string | null = null
    const seqMatch = /^(?:issue:)?#?(\d+)$/.exec(row.from_issue.trim())
    if (seqMatch) {
      const seq = Number(seqMatch[1])
      const repo = (
        row.to_kind === 'issue' && row.to_id
          ? recipientIssue.get(row.to_id)
          : row.to_kind === 'session' && row.to_id
            ? sessionIssue.get(row.to_id)
            : undefined
      ) as { repo_id: string | null; repo_path: string } | undefined
      if (repo) {
        const candidates = bySeqInRepo.all(seq, repo.repo_id, repo.repo_path) as {
          id: string
        }[]
        if (candidates.length === 1) resolved = candidates[0]!.id
      }
    }
    if (resolved === null) {
      console.warn(
        `[podium] migration 021: messages row ${row.id} sender ref ` +
          `${JSON.stringify(row.from_issue)} could not be resolved to an issue ` +
          `in the recipient's repo — clearing from_issue (unattributed sender)`,
      )
    }
    update.run(resolved, row.id)
  }
}
