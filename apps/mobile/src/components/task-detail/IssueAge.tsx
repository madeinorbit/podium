import { relativeTime } from '@podium/client-core/focus'
import { activityDayLabel } from '@podium/client-core/values'
import { useCoarseNow } from '../../client/hooks'

export function IssueAge({ stamp }: { stamp: string }) {
  return relativeTime(stamp, useCoarseNow() || Date.now())
}

export function IssueDayLabel({ day, stamp }: { day: string; stamp: string }) {
  return activityDayLabel(day, stamp, useCoarseNow() || Date.now())
}
