import type { SessionId } from '@podium/model'
import type { DaemonContext } from '../control/context'

/** Quiet server reconnect: history is authoritative even without a new tail event. */
export async function seedRuntimeHistory(
  ctx: Pick<DaemonContext, 'agentRuntime' | 'send'>,
  sessionId: SessionId,
): Promise<void> {
  const handle = ctx.agentRuntime?.handleFor(sessionId)
  if (!handle) return
  const page = await handle.transcript.history({ direction: 'before', limit: 2000 })
  // Do not let a retired handle's outstanding read replace the new conversation.
  if (ctx.agentRuntime?.handleFor(sessionId) !== handle) return
  const tail = page.items.at(-1)?.cursor
  // send's terminal observation adapter publishes the explicit runtime reset.
  ctx.send({
    type: 'transcriptDelta', sessionId, items: [...page.items], reset: true,
    ...(tail !== undefined ? { tail } : {}),
  })
}
