/** Delivers issue mail at the Stop hook: when a session's issue has unread mail, respond
 *  with `decision:"block"` so the agent continues and reads its inbox instead of going idle.
 *  Guards: `stop_hook_active` (Claude Code sets it after a Stop hook already blocked this
 *  turn — blocking again risks an infinite loop) and a per-session 60s rate limit (an agent
 *  may legitimately decline to act; don't nag every Stop while unread persists). */
export const MAIL_BLOCK_COOLDOWN_MS = 60_000

const MAIL_BLOCK_REASON =
  "You have mail on your issue: run 'podium issue mail inbox' to read it now; " +
  "claim a message with 'podium issue mail claim <id>' only if you will act on it."

export function createMailInjector(
  relay: (sessionId: string) => Promise<{ ok: boolean; result?: unknown }>,
  now: () => number = Date.now,
): { respondTo(sessionId: string, payload: unknown): Promise<string | null> } {
  const lastBlockedAt = new Map<string, number>()
  return {
    async respondTo(sessionId, payload) {
      const fields = payload as { hook_event_name?: unknown; stop_hook_active?: unknown } | null
      if (fields?.hook_event_name !== 'Stop') return null
      // Loop guard: a Stop hook already blocked this turn; blocking again can loop forever.
      if (fields.stop_hook_active === true) return null
      const at = lastBlockedAt.get(sessionId)
      if (at !== undefined && now() - at < MAIL_BLOCK_COOLDOWN_MS) return null
      let unread: unknown
      try {
        const r = await relay(sessionId)
        if (!r.ok) return null
        unread = (r.result as { unread?: unknown } | null)?.unread
      } catch {
        // Non-issue sessions / relay errors / timeouts: never block, never throw.
        return null
      }
      if (typeof unread !== 'number' || unread <= 0) return null
      lastBlockedAt.set(sessionId, now())
      return JSON.stringify({ decision: 'block', reason: MAIL_BLOCK_REASON })
    },
  }
}

/** First non-null response wins; a responder that throws is skipped (fail-open). */
export function composeResponders(
  ...fns: Array<(sessionId: string, payload: unknown) => Promise<string | null>>
): (sessionId: string, payload: unknown) => Promise<string | null> {
  return async (sessionId, payload) => {
    for (const fn of fns) {
      try {
        const r = await fn(sessionId, payload)
        if (r !== null) return r
      } catch {
        // fail-open: a broken responder must not silence the others
      }
    }
    return null
  }
}
