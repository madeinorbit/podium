import type { SessionId } from '@podium/model'
/** Mail policy is harness-neutral. Drivers own boundary selection, veto encoding,
 * loop guards and delivery; the server owns unread/reminded_at persistence. */
export const MAIL_BLOCK_COOLDOWN_MS = 60_000

export interface MailContextSource {
  pendingContext(sessionId: SessionId, signal?: AbortSignal): Promise<string | null>
}

/** Suppress concurrent polls, not just successive deliveries. In particular a
 * duplicate completion must not consume two server-persisted reminders. */
function contextSource(
  read: (sessionId: SessionId) => Promise<string | null>,
  now: () => number,
): MailContextSource {
  const lastBlockedAt = new Map<SessionId, number>()
  const pending = new Map<SessionId, object>()
  return {
    async pendingContext(sessionId, signal) {
      if (signal?.aborted) return null
      const at = lastBlockedAt.get(sessionId)
      if (pending.has(sessionId) || (at !== undefined && now() - at < MAIL_BLOCK_COOLDOWN_MS))
        return null
      const claim = {}
      pending.set(sessionId, claim)
      const release = () => {
        if (pending.get(sessionId) === claim) pending.delete(sessionId)
      }
      signal?.addEventListener('abort', release, { once: true })
      try {
        const text = await read(sessionId)
        if (signal?.aborted) return null
        if (text !== null) lastBlockedAt.set(sessionId, now())
        return text
      } catch {
        return null // old server, non-issue session or failed relay: fail open
      } finally {
        signal?.removeEventListener('abort', release)
        release()
      }
    },
  }
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
  relay: (sessionId: SessionId) => Promise<{ ok: boolean; result?: unknown }>,
  now: () => number = Date.now,
): MailContextSource {
  return contextSource(async (sessionId) => {
    const r = await relay(sessionId)
    if (!r.ok) return null
    const result = r.result as { unread?: unknown; senders?: unknown } | null
    const unread = result?.unread
    if (typeof unread !== 'number' || !Number.isFinite(unread) || unread <= 0) return null
    const senders = Array.isArray(result?.senders)
      ? result.senders.filter((s): s is string => typeof s === 'string').slice(0, 5)
      : []
    return mailBlockReason(unread, senders)
  }, now)
}

/**
 * Ack single-reminder (#237) [spec:SP-34d7 acks]: at Stop for Claude/Codex or
 * PreToolUse for Grok, delivered-but-unacked non-fyi messages get ONE reminder.
 * The server persists reminded_at before returning, so this stays stateless
 * beyond the standard loop guard and cooldown; afterward the steward owns it.
 */
export function createAckReminderInjector(
  relay: (sessionId: SessionId) => Promise<{ ok: boolean; result?: unknown }>,
  now: () => number = Date.now,
): MailContextSource {
  return contextSource(async (sessionId) => {
    const r = await relay(sessionId)
    if (!r.ok || !Array.isArray(r.result)) return null
    const reminders = r.result.filter(
      (m): m is { id: string; from: string } =>
        typeof (m as { id?: unknown })?.id === 'string' &&
        typeof (m as { from?: unknown })?.from === 'string',
    )
    if (reminders.length === 0) return null
    const lines = reminders
      .slice(0, 5)
      .map(
        (m) =>
          `- ${m.id} (from ${m.from}): reply with what you did — podium mail reply ${m.id} --body "…"`,
      )
    return (
      `You have ${reminders.length} podium message(s) awaiting your reply before you go idle:\n` +
      `${lines.join('\n')}\n` +
      'This is your only reminder; unanswered senders get a mechanical system notice instead.'
    )
  }, now)
}

/** Unread mail wins. Do not consume persisted ack reminders until they can be
 * delivered; fetching both in parallel would mark an unseen reminder sent. */
export function composeMailContext(...sources: MailContextSource[]): MailContextSource {
  const pending = new Map<SessionId, object>()
  return {
    async pendingContext(sessionId, signal) {
      if (signal?.aborted || pending.has(sessionId)) return null
      const claim = {}
      pending.set(sessionId, claim)
      const release = () => {
        if (pending.get(sessionId) === claim) pending.delete(sessionId)
      }
      signal?.addEventListener('abort', release, { once: true })
      try {
        for (const source of sources) {
          if (signal?.aborted) return null
          try {
            const text = await source.pendingContext(sessionId, signal)
            if (text !== null) return text
          } catch {
            // A failing source must not silence the next source.
          }
        }
        return null
      } finally {
        signal?.removeEventListener('abort', release)
        release()
      }
    },
  }
}

/** First non-null response wins; a responder that throws is skipped (fail-open). */
export function composeResponders(
  ...fns: Array<(sessionId: SessionId, payload: unknown, signal?: AbortSignal) => Promise<string | null>>
): (sessionId: SessionId, payload: unknown, signal?: AbortSignal) => Promise<string | null> {
  return async (sessionId, payload, signal) => {
    for (const fn of fns) {
      if (signal?.aborted) return null
      try {
        const r = await fn(sessionId, payload, signal)
        if (r !== null) return r
      } catch {
        // fail-open: a broken responder must not silence the others
      }
    }
    return null
  }
}
