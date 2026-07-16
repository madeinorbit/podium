import type { AgentRuntimeState } from '@podium/protocol'

/**
 * Notification triage for agent-state transitions. High-signal by design: only
 * states where the human is genuinely the blocker fire, and only on the
 * *transition* into them — a re-broadcast of the same blocked state stays quiet.
 */
export interface AttentionNotice {
  title: string
  body: string
}

function wantsHuman(state: AgentRuntimeState): boolean {
  if (state.phase === 'needs_user' || state.phase === 'errored') return true
  if (state.phase === 'idle') {
    const kind = state.idle?.kind
    return kind === 'question' || kind === 'approval'
  }
  return false
}

export function attentionNotice(
  sessionName: string,
  prev: AgentRuntimeState | undefined,
  next: AgentRuntimeState,
): AttentionNotice | null {
  if (!wantsHuman(next)) return null
  // Same blocked condition re-reported (e.g. another hook echo) — no re-ping.
  if (prev && wantsHuman(prev) && prev.phase === next.phase) return null
  if (next.phase === 'needs_user') {
    return {
      title: `${sessionName} needs you`,
      body:
        next.need?.summary ??
        (next.need?.kind === 'question' ? 'Asked you a question.' : 'Waiting for permission.'),
    }
  }
  if (next.phase === 'errored') {
    const cls = next.error?.class ?? 'unknown'
    return {
      title: `${sessionName} hit an error`,
      body: next.error?.retryable ? `${cls} — a retry may work.` : `${cls} — needs a look.`,
    }
  }
  // idle question/approval
  return {
    title:
      next.idle?.kind === 'approval' ? `${sessionName}: plan ready` : `${sessionName} asked you`,
    body: next.idle?.summary ?? 'Ended its turn waiting on you.',
  }
}

/** Fire-and-forget mobile push via ntfy.sh. Failures are logged, never thrown. */
export function pushNtfy(topic: string, notice: AttentionNotice): void {
  // Publish as a JSON body, NOT via the X-Title header: titles carry the session
  // name, and Claude sets non-ASCII spinner titles (e.g. '✳ …'). undici rejects
  // any header value > U+00FF ('Cannot convert … to a ByteString'), which threw
  // synchronously and dropped the push for exactly the events this exists for.
  // The JSON body is UTF-8 and has no such restriction.
  fetch('https://ntfy.sh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic,
      title: notice.title,
      message: notice.body,
      priority: 4, // "high" in ntfy's 1–5 scale
      tags: ['robot'],
    }),
  }).catch((err) => {
    console.warn('[podium] ntfy push failed:', err instanceof Error ? err.message : err)
  })
}

export interface TelegramConfig {
  botToken: string
  chatId: string
}

type PushTelegramFetch = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

interface PushTelegramOptions {
  fetch?: PushTelegramFetch
}

type TelegramResponseBody = {
  ok?: boolean
  description?: string
}

async function telegramDescription(res: Pick<Response, 'json'>): Promise<string | undefined> {
  try {
    const body = (await res.json()) as TelegramResponseBody
    return typeof body.description === 'string' ? body.description : undefined
  } catch {
    return undefined
  }
}

/** Fire-and-forget Telegram push (bare sendMessage). Failures are logged, never thrown. */
export function pushTelegramText(
  config: TelegramConfig,
  text: string,
  opts: PushTelegramOptions = {},
): void {
  const botToken = config.botToken.trim()
  const chatId = config.chatId.trim()
  if (!botToken || !chatId) return

  const send = opts.fetch ?? fetch
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`
  send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  })
    .then(async (res) => {
      if (res.ok) return
      const description = await telegramDescription(res)
      console.warn(
        '[podium] Telegram push failed:',
        description ? `${res.status} ${description}` : `HTTP ${res.status}`,
      )
    })
    .catch((err) => {
      console.warn('[podium] Telegram push failed:', err instanceof Error ? err.message : err)
    })
}

/** Fire-and-forget Telegram push. Failures are logged, never thrown. */
export function pushTelegram(
  config: TelegramConfig,
  notice: AttentionNotice,
  opts: PushTelegramOptions = {},
): void {
  pushTelegramText(config, `${notice.title}\n\n${notice.body}`, opts)
}
