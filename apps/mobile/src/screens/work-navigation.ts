import type { PhoneWorkFilterSnapshot, PhoneWorkLane } from '@podium/client-graph/worklist/phone'

export type WorkRouteParams = {
  workLane?: string | string[]
  workQuery?: string | string[]
  workOffset?: string | string[]
  workFocus?: string | string[]
}
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
export function readWorkNavigation(params: WorkRouteParams) {
  const value = first(params.workLane)
  const lane: PhoneWorkLane = value === 'snoozed' || value === 'closed' ? value : 'open'
  const offset = Number(first(params.workOffset) ?? 0)
  return {
    lane,
    query: first(params.workQuery) ?? '',
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
    focus: first(params.workFocus),
  }
}
export function workFilterParams(snapshot: PhoneWorkFilterSnapshot) {
  return {
    workLane: snapshot.lane === 'open' ? undefined : snapshot.lane,
    workQuery: snapshot.query || undefined,
    workOffset: undefined,
    workFocus: undefined,
  }
}
