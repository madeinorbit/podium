import type { IssuesOrdering } from '@podium/client-core/viewmodels'

export interface MobileTaskDisplay {
  ordering: IssuesOrdering
  showAgentTasks: boolean
  /** Preserve desktop-only fields when the shared preference row is updated. */
  source: Record<string, unknown>
}

const ORDERINGS = new Set<IssuesOrdering>(['priority', 'updated', 'created'])

export function readMobileTaskDisplay(raw: string | null): MobileTaskDisplay {
  if (!raw) return { ordering: 'priority', showAgentTasks: false, source: {} }
  try {
    const parsed = JSON.parse(raw)
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

export function writeMobileTaskDisplay(display: MobileTaskDisplay): string {
  return JSON.stringify({
    ...display.source,
    ordering: display.ordering,
    showAgentTasks: display.showAgentTasks,
  })
}
