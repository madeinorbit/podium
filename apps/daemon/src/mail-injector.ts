import { hookBoolean, hookEventName, isGrokHookPayload } from './hook-payload'

/** Delivers issue mail at each harness's blocking boundary. Claude/Codex block Stop;
 *  Grok can only deny PreToolUse, so one tool call is denied with the inbox pointer and
 *  can be retried after the agent reads it. [spec:SP-79c5] The Stop path keeps its
 *  stop_hook_active loop guard; both modes share the per-session cooldown. */
export const MAIL_BLOCK_COOLDOWN_MS = 60_000

type MailDeliveryMode = 'stop' | 'grok_pre_tool'

function mailDeliveryMode(payload: unknown): MailDeliveryMode | undefined {
  const event = hookEventName(payload)
  if (isGrokHookPayload(payload)) return event === 'PreToolUse' ? 'grok_pre_tool' : undefined
  return event === 'Stop' ? 'stop' : undefined
}

function intervention(mode: MailDeliveryMode, reason: string): string {
  return JSON.stringify({
    // Grok's only blocking hook is PreToolUse and its native decision is deny.
    // Claude/Codex Stop hooks use block to continue the turn.
    decision: mode === 'grok_pre_tool' ? 'deny' : 'block',
    reason,
  })
}

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
      const mode = mailDeliveryMode(payload)
      if (!mode) return null
      // Loop guard: a Stop hook already blocked this turn; blocking again can loop forever.
      if (mode === 'stop' && hookBoolean(payload, 'stop_hook_active', 'stopHookActive') === true)
        return null
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
      return intervention(mode, mailBlockReason(unread, senders))
    },
  }
}

/**
 * Ack single-reminder (#237) [spec:SP-34d7 acks]: at Stop for Claude/Codex or
 * PreToolUse for Grok, delivered-but-unacked non-fyi messages get ONE reminder.
 * The server persists reminded_at before returning, so this stays stateless
 * beyond the standard loop guard and cooldown; afterward the steward owns it.
 */
export function createAckReminderInjector(
  relay: (sessionId: string) => Promise<{ ok: boolean; result?: unknown }>,
  now: () => number = Date.now,
): { respondTo(sessionId: string, payload: unknown): Promise<string | null> } {
  const lastBlockedAt = new Map<string, number>()
  return {
    async respondTo(sessionId, payload) {
      const mode = mailDeliveryMode(payload)
      if (!mode) return null
      if (mode === 'stop' && hookBoolean(payload, 'stop_hook_active', 'stopHookActive') === true)
        return null
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
        decision: mode === 'grok_pre_tool' ? 'deny' : 'block',
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
