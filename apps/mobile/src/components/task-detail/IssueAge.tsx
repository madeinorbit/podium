import { relativeTime } from '@podium/client-core/focus'
import { activityDayLabel } from '@podium/client-core/values'
import { useAgeNow } from '../../lib/clock-hooks'

export function IssueAge({ stamp }: { stamp: string }) {
  return relativeTime(stamp, useAgeNow(stamp))
}

export function IssueDayLabel({ day, stamp }: { day: string; stamp: string }) {
  return activityDayLabel(day, stamp, useAgeNow(stamp))
}
