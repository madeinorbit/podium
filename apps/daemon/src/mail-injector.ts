/** Delivers issue mail at the Stop hook: when a session's issue has unread mail, respond
 *  with `decision:"block"` so the agent continues and reads its inbox instead of going idle.
 *  Guards: `stop_hook_active` (Claude Code sets it after a Stop hook already blocked this
 *  turn — blocking again risks an infinite loop) and a per-session 60s rate limit (an agent
 *  may legitimately decline to act; don't nag every Stop while unread persists). */
export const MAIL_BLOCK_COOLDOWN_MS = 60_000

/** Pointer rendering (#237) [spec:SP-34d7]: coalesce N pending messages into one
 *  inbox pointer naming the senders when the server supplies them. */
function mailBlockReason(unread: number, senders: string[]): string {
  const who = senders.length > 0 ? ` from ${senders.join(', ')}` : ''
  return (
    `You have ${unread} message(s)${who} on your issue: run 'podium issue mail inbox' to read them now; ` +
    "claim a message with 'podium issue mail claim <id>' only if you will act on it."
  )
}

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
      let senders: string[] = []
      try {
        const r = await relay(sessionId)
        if (!r.ok) return null
        const result = r.result as { unread?: unknown; senders?: unknown } | null
        unread = result?.unread
        // senders is optional (#237): an old server omits it — fall back to the
        // sender-less rendering rather than failing the block.
        if (Array.isArray(result?.senders)) {
          senders = result.senders.filter((s): s is string => typeof s === 'string').slice(0, 5)
        }
      } catch {
        // Non-issue sessions / relay errors / timeouts: never block, never throw.
        return null
      }
      if (typeof unread !== 'number' || unread <= 0) return null
      lastBlockedAt.set(sessionId, now())
      return JSON.stringify({ decision: 'block', reason: mailBlockReason(unread, senders) })
    },
  }
}

/**
 * Ack single-reminder at the Stop hook (#237) [spec:SP-34d7 acks]: a session
 * going idle with delivered-but-unacked non-fyi messages gets ONE
 * block-with-reason per message. The SERVER owns the never-repeats guarantee
 * (messages.pendingReminders marks reminded_at before returning), so this
 * injector is stateless beyond the standard loop guard + per-session cooldown;
 * after the one reminder the steward's deterministic fallback owns the message.
 */
export function createAckReminderInjector(
  relay: (sessionId: string) => Promise<{ ok: boolean; result?: unknown }>,
  now: () => number = Date.now,
): { respondTo(sessionId: string, payload: unknown): Promise<string | null> } {
  const lastBlockedAt = new Map<string, number>()
  return {
    async respondTo(sessionId, payload) {
      const fields = payload as { hook_event_name?: unknown; stop_hook_active?: unknown } | null
      if (fields?.hook_event_name !== 'Stop') return null
      if (fields.stop_hook_active === true) return null
      const at = lastBlockedAt.get(sessionId)
      if (at !== undefined && now() - at < MAIL_BLOCK_COOLDOWN_MS) return null
      let reminders: { id: string; from: string }[]
      try {
        const r = await relay(sessionId)
        if (!r.ok || !Array.isArray(r.result)) return null
        reminders = r.result.filter(
          (m): m is { id: string; from: string } =>
            typeof (m as { id?: unknown })?.id === 'string' &&
            typeof (m as { from?: unknown })?.from === 'string',
        )
      } catch {
        return null // old server / relay error: never block, never throw
      }
      if (reminders.length === 0) return null
      lastBlockedAt.set(sessionId, now())
      const lines = reminders
        .slice(0, 5)
        .map(
          (m) =>
            `- ${m.id} (from ${m.from}): reply with what you did — podium mail reply ${m.id} --body "…"`,
        )
      return JSON.stringify({
        decision: 'block',
        reason:
          `You have ${reminders.length} podium message(s) awaiting your reply before you go idle:\n` +
          `${lines.join('\n')}\n` +
          'This is your only reminder; unanswered senders get a mechanical system notice instead.',
      })
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
