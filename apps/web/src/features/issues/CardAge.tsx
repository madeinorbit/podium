import { cardAge } from './issue-card'
import { useAgeNow } from '@/lib/clock-hooks'

export function CardAge({ stamp, now: pinned = 0 }: { stamp: string; now?: number }) {
  const live = useAgeNow(stamp, 0, pinned === 0)
  return cardAge(stamp, pinned || live)
}
