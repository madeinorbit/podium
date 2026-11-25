import { chatUploadUnavailable } from '@podium/client-graph/chat-context'
import { observer } from 'mobx-react-lite'
import { useMobilePool } from '../client/mobile-pool'
import { BodyPending } from './BodyPending'

/** Stored chat uploads share the issue's on-demand artifact body. */
export const ChatUploadPending = observer(function ChatUploadPending({
  label,
  sessionId,
}: {
  label: string
  sessionId?: string
}) {
  const pool = useMobilePool()
  const unavailable = pool && sessionId ? chatUploadUnavailable(pool, sessionId) : false
  return <BodyPending label={label} unavailable={unavailable} />
})
