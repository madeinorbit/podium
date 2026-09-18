import {
  createBoundaryContext,
  type BoundaryContextEvent,
  type BoundaryContextOperation,
} from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import { hookEventName } from './hook-payload'

/** Legacy responder retained until every provider has demonstrated boundary parity. */
export function createPrimeInjector(
  relay: (sessionId: SessionId) => Promise<{ ok: boolean; result?: unknown }>,
) {
  const contexts = new Map<SessionId, ReturnType<typeof createBoundaryContext>>()
  return {
    reset(sessionId: SessionId) {
      contexts.get(sessionId)?.reset()
      contexts.delete(sessionId)
    },
    async respondTo(sessionId: SessionId, payload: unknown, signal?: AbortSignal) {
      let context = contexts.get(sessionId)
      if (!context) {
        context = createBoundaryContext(() => relay(sessionId))
        contexts.set(sessionId, context)
      }
      return primeHookResponse(context.respond, payload, signal)
    },
  }
}

/** Wire codec only. The driver operation owns once/rearm and fetch state. */
export async function primeHookResponse(
  respond: BoundaryContextOperation,
  payload: unknown,
  signal?: AbortSignal,
): Promise<string | null> {
  const name = hookEventName(payload)
  const event: BoundaryContextEvent | undefined =
    name === 'SessionStart'
      ? 'start'
      : name === 'UserPromptSubmit'
        ? 'prompt'
        : name === 'PreCompact'
          ? 'before-compaction'
          : undefined
  if (!event) return null
  const context = await respond({ event, ...(signal ? { signal } : {}) })
  return context === null
    ? null
    : JSON.stringify({
        hookSpecificOutput: { hookEventName: name, additionalContext: context },
      })
}
