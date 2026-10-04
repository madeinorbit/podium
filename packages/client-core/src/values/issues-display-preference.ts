import type { IssuesOrdering } from './issue-board-rows'

export interface SharedIssuesDisplayPreference {
  ordering: IssuesOrdering
  showAgentTasks: boolean
  /** Every platform preserves fields it does not own in the shared ui-state row. */
  source: Record<string, unknown>
}

const ORDERINGS = new Set<IssuesOrdering>(['priority', 'updated', 'created'])

/** Browser-free parser for the fields shared by desktop and mobile Tasks. */
export function readSharedIssuesDisplay(raw: string | null): SharedIssuesDisplayPreference {
  if (!raw) return { ordering: 'priority', showAgentTasks: false, source: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    const source = parsed as Record<string, unknown>
    const candidate = source.ordering
    return {
      ordering:
        typeof candidate === 'string' && ORDERINGS.has(candidate as IssuesOrdering)
          ? (candidate as IssuesOrdering)
          : 'priority',
      showAgentTasks: source.showAgentTasks === true,
      source,
    }
  } catch {
    return { ordering: 'priority', showAgentTasks: false, source: {} }
  }
}

/** Merge only shared fields so a phone write cannot erase desktop presentation state. */
export function writeSharedIssuesDisplay(display: SharedIssuesDisplayPreference): string {
  return JSON.stringify({
    ...display.source,
    ordering: display.ordering,
    showAgentTasks: display.showAgentTasks,
  })
}
