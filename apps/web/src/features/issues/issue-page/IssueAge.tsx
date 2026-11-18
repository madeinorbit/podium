import { relativeTime } from '@podium/client-core/focus'
import { activityDayLabel, activityDayLabelNextChangeAt } from '@podium/client-core/values'
import { useCallback } from 'react'
import { useAgeNow } from '@/lib/clock-hooks'

/** Text boundaries repaint labels without reading issue/session/history fields. */
export function IssueAge({ stamp }: { stamp: string }) {
  return relativeTime(stamp, useAgeNow(stamp))
}

export function IssueDayLabel({ day, stamp }: { day: string; stamp: string }) {
  const nextChangeAt = useCallback(
    (_since: number, now: number) => activityDayLabelNextChangeAt(day, stamp, now),
    [day, stamp],
  )
  const now = useAgeNow(stamp, 0, true, 0, nextChangeAt)
  return activityDayLabel(day, stamp, now)
}
