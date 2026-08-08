import { formatLong, issueDisplayRef } from '@podium/protocol'

/** Minimal issue shape for display-ref helpers — keeps lib free of feature imports. */
type IssueRefFields = { seq: number; displayRef?: string }
type IssueTitleFields = IssueRefFields & { title: string }
type IssueIdTitleFields = IssueTitleFields & { id: string }

/** The short human-facing ref for an issue row/label (#474): `POD-13` (falls
 *  back to `#13` for legacy payloads). The single accessor every render site uses. */
export function issueRefLabel(issue: IssueRefFields): string {
  return issueDisplayRef(issue)
}

/** The long form for a hover/label: `POD-13 · <title>` (title truncated ~40). */
export function issueRefLong(issue: IssueTitleFields): string {
  return formatLong(issueDisplayRef(issue), issue.title)
}

/** Hover text for any issue row/reference — the canonical long form with the
 *  FULL title (#474 spec §display), plus the internal id on a second line so
 *  agents' `iss_…` references can still be matched by eye (#21). */
export function issueIdTitle(issue: IssueIdTitleFields): string {
  return `${issueDisplayRef(issue)} · ${issue.title}\n${issue.id}`
}
