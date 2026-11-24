import { cardAge, cardAgeNextChangeAt } from '@podium/client-core/focus'
import { useAgeNow } from '@/lib/clock-hooks'

export function CardAge({ stamp, now: pinned = 0 }: { stamp: string; now?: number }) {
  const live = useAgeNow(stamp, 0, pinned === 0, 0, cardAgeNextChangeAt)
  return cardAge(stamp, pinned || live)
}
