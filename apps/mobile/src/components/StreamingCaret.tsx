import { CaretMotion } from './streaming-caret-motion'
import { ActivityLine } from './transcript-activity'

export function StreamingCaret({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <ActivityLine testID="streaming-caret-line">
      <CaretMotion reduceMotion={reduceMotion} />
    </ActivityLine>
  )
}
