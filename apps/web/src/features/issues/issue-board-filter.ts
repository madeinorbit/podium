import type { IssueStage, IssueWire } from '@podium/protocol'
import { STAGE_LABELS } from './issue-card'

export interface BoardFilter {
  text?: string
  priority?: number
  type?: string
  assignee?: string
  label?: string
  status?: 'open' | 'closed' | 'ready' | 'blocked' | 'deferred'
  stage?: IssueStage
  /** Reveal archived issues. Off/unset → archived stay hidden (board default). */
  archived?: boolean
  /** Reveal recoverable soft-deleted issues. */
  deleted?: boolean
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
    // Deleted issues have their own recovery view; their prior archived bit must
    // not make them disappear from that view.
    if (i.deletedAt ? !f.deleted : i.archived && !f.archived) return false
    if (f.priority != null && i.priority !== f.priority) return false
    if (f.type && i.type !== f.type) return false
    if (f.assignee && i.assignee !== f.assignee) return false
    if (f.label && !i.labels.includes(f.label)) return false
    if (f.stage && i.stage !== f.stage) return false
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

/** Chip descriptors for every set dimension except free-text search. */
export function filterChips(f: BoardFilter): { key: keyof BoardFilter; label: string }[] {
  const chips: { key: keyof BoardFilter; label: string }[] = []
  if (f.priority != null) chips.push({ key: 'priority', label: `Priority: P${f.priority}` })
  if (f.type) chips.push({ key: 'type', label: `Type: ${f.type}` })
  if (f.assignee) chips.push({ key: 'assignee', label: `Assignee: ${f.assignee}` })
  if (f.label) chips.push({ key: 'label', label: `Label: ${f.label}` })
  if (f.status) chips.push({ key: 'status', label: `Status: ${f.status}` })
  if (f.stage) chips.push({ key: 'stage', label: `Stage: ${STAGE_LABELS[f.stage]}` })
  if (f.archived) chips.push({ key: 'archived', label: 'Archived' })
  if (f.deleted) chips.push({ key: 'deleted', label: 'Deleted' })
  return chips
}

export function clearChip(f: BoardFilter, key: keyof BoardFilter): BoardFilter {
  const next = { ...f }
  delete next[key]
  return next
}
