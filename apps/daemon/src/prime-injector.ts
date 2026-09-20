import {
  createBoundaryContext,
  type BoundaryContextEvent,
  type BoundaryContextOperation,
} from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import { hookEventName, hookString } from './hook-payload'

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
  // Codex never sends PreCompact (hooks.json omits it: PreCompact supports
  // only the common output fields, never additionalContext). Its only
  // post-compaction signal is SessionStart with source 'compact', so re-arm
  // here before priming — otherwise the once/rearm logic treats it as an
  // already-consumed start and the agent loses scoped context after every
  // compaction.
  if (name === 'SessionStart' && hookString(payload, 'source', 'source') === 'compact') {
    await respond({ event: 'before-compaction' })
    const context = await respond({ event: 'start', ...(signal ? { signal } : {}) })
    return context === null
      ? null
      : JSON.stringify({
          hookSpecificOutput: { hookEventName: name, additionalContext: context },
        })
  }
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
