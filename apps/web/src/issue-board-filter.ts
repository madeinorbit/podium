import type { IssueWire } from '@podium/protocol'

export interface BoardFilter {
  text?: string
  priority?: number
  type?: string
  assignee?: string
  label?: string
  status?: 'open' | 'closed' | 'ready' | 'blocked' | 'deferred'
}

/**
 * Filter a board's issues by an AND-composed `BoardFilter`. Every set field
 * narrows the result; an empty filter passes everything through. Text matches
 * case-insensitively over title + description; `status` is derived from the
 * wire flags (`closed = stage === 'done' || closedReason`). Pure — no mutation.
 */
export function filterBoardIssues(issues: IssueWire[], f: BoardFilter): IssueWire[] {
  const text = f.text?.toLowerCase()
  return issues.filter((i) => {
    if (f.priority != null && i.priority !== f.priority) return false
    if (f.type && i.type !== f.type) return false
    if (f.assignee && i.assignee !== f.assignee) return false
    if (f.label && !i.labels.includes(f.label)) return false
    const closed = i.stage === 'done' || !!i.closedReason
    if (f.status === 'open' && closed) return false
    if (f.status === 'closed' && !closed) return false
    if (f.status === 'ready' && !i.ready) return false
    if (f.status === 'blocked' && !i.blocked) return false
    if (f.status === 'deferred' && !i.deferred) return false
    if (text && !`${i.title} ${i.description}`.toLowerCase().includes(text)) return false
    return true
  })
}
