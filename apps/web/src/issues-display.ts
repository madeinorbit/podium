import type { IssueWire } from '@podium/protocol'

export type IssuesLayout = 'board' | 'list'
export type IssuesOrdering = 'priority' | 'updated' | 'created'

export interface IssuesDisplay {
  layout: IssuesLayout
  ordering: IssuesOrdering
  badges: { labels: boolean; type: boolean; estimate: boolean; due: boolean; sessions: boolean }
}

export const DISPLAY_KEY = 'podium.issues.display'

export const DEFAULT_DISPLAY: IssuesDisplay = {
  layout: 'board',
  ordering: 'updated',
  badges: { labels: true, type: true, estimate: true, due: true, sessions: true },
}

const LAYOUTS = new Set<string>(['board', 'list'])
const ORDERINGS = new Set<string>(['priority', 'updated', 'created'])

/** Parse a persisted display-options blob, falling back field-by-field so a
 *  stale or hand-edited value never breaks the view. */
export function readIssuesDisplay(raw: string | null): IssuesDisplay {
  if (!raw) return DEFAULT_DISPLAY
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return DEFAULT_DISPLAY
  }
  if (typeof v !== 'object' || v == null) return DEFAULT_DISPLAY
  const o = v as Record<string, unknown>
  const badges = (typeof o.badges === 'object' && o.badges != null ? o.badges : {}) as Record<
    string,
    unknown
  >
  const badge = (k: keyof IssuesDisplay['badges']): boolean =>
    typeof badges[k] === 'boolean' ? (badges[k] as boolean) : DEFAULT_DISPLAY.badges[k]
  return {
    layout: LAYOUTS.has(String(o.layout)) ? (o.layout as IssuesLayout) : DEFAULT_DISPLAY.layout,
    ordering: ORDERINGS.has(String(o.ordering))
      ? (o.ordering as IssuesOrdering)
      : DEFAULT_DISPLAY.ordering,
    badges: {
      labels: badge('labels'),
      type: badge('type'),
      estimate: badge('estimate'),
      due: badge('due'),
      sessions: badge('sessions'),
    },
  }
}

export function writeIssuesDisplay(d: IssuesDisplay): string {
  return JSON.stringify(d)
}

/** Stable ordering for board columns and list groups. Pure — returns a copy. */
export function orderIssues(issues: IssueWire[], ordering: IssuesOrdering): IssueWire[] {
  const c = [...issues]
  if (ordering === 'priority') c.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  else if (ordering === 'updated') c.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  else c.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return c
}
