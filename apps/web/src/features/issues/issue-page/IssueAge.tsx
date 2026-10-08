import { relativeTime } from '@podium/client-core/focus'
import { activityDayLabel } from '@podium/client-core/values'
import { useNow } from '@/lib/useNow'

/** Minute changes repaint labels, without reading any issue/session/history fields. */
export function IssueAge({ stamp }: { stamp: string }) {
  return relativeTime(stamp, useNow(60_000))
}

export function IssueDayLabel({ day, stamp }: { day: string; stamp: string }) {
  return activityDayLabel(day, stamp, useNow(60_000))
}
