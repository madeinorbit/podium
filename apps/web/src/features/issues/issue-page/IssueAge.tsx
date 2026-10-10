import { relativeTime } from '@podium/client-core/focus'
import { activityDayLabel } from '@podium/client-core/values'
import { useAgeNow } from '@/lib/clock-hooks'

/** Minute changes repaint labels, without reading any issue/session/history fields. */
export function IssueAge({ stamp }: { stamp: string }) {
  return relativeTime(stamp, useAgeNow(stamp))
}

export function IssueDayLabel({ day, stamp }: { day: string; stamp: string }) {
  return activityDayLabel(day, stamp, useAgeNow(stamp))
}
