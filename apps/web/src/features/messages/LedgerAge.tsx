import type { MessageModel } from '@podium/client-graph/message-models'
import { relativeTime } from '@podium/client-core/focus'
import { observer } from 'mobx-react-lite'
import { useAgeNow } from '@/lib/clock-hooks'

/** Only the timestamp label observes the shared clock at its age precision. */
export const LedgerAge = observer(function LedgerAge({ message }: { message: MessageModel }) {
  return <AgeStamp stamp={message.createdAt} />
})

/** The clock hook owns time observation, independently of record observation. */
function AgeStamp({ stamp }: { stamp: string }) {
  const now = useAgeNow(stamp)
  return <>{relativeTime(stamp, now)}</>
}
