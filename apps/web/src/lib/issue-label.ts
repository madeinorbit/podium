import type { IssueViewModel } from '@podium/client-core/react'
import { formatLong, issueDisplayRef } from '@podium/protocol'

/** The short human-facing ref for an issue row/label (#474): `POD-13` (falls
 *  back to `#13` for legacy payloads). The single accessor every render site uses. */
export function issueRefLabel(issue: Pick<IssueViewModel, 'seq' | 'displayRef'>): string {
  return issueDisplayRef(issue)
}

/** The long form for a hover/label: `POD-13 · <title>` (title truncated ~40). */
export function issueRefLong(issue: Pick<IssueViewModel, 'seq' | 'displayRef' | 'title'>): string {
  return formatLong(issueDisplayRef(issue), issue.title)
}

/** Hover text for any issue row/reference — the canonical long form with the
 *  FULL title (#474 spec §display), plus the internal id on a second line so
 *  agents' `iss_…` references can still be matched by eye (#21). */
export function issueIdTitle(
  issue: Pick<IssueViewModel, 'seq' | 'id' | 'displayRef' | 'title'>,
): string {
  return `${issueDisplayRef(issue)} · ${issue.title}\n${issue.id}`
}
