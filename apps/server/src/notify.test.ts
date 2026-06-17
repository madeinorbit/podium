import type { AgentRuntimeState } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { attentionNotice, pushTelegram } from './notify'

const waitFor = async (assertion: () => void | Promise<void>): Promise<void> => {
  const deadline = Date.now() + 1000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

const state = (
  phase: AgentRuntimeState['phase'],
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState => ({ phase, since: '2026-06-12T10:00:00.000Z', openTaskCount: 0, ...extra })

describe('attentionNotice', () => {
  it('fires on the transition into needs_user with the real question', () => {
    const n = attentionNotice(
      'podium / keyboard',
      state('working'),
      state('needs_user', {
        need: { kind: 'question', summary: 'SQLite or Postgres?' },
      }),
    )
    expect(n).toEqual({ title: 'podium / keyboard needs you', body: 'SQLite or Postgres?' })
  })

  it('stays quiet on a re-report of the same blocked phase', () => {
    const blocked = state('needs_user', { need: { kind: 'permission' } })
    expect(attentionNotice('s', blocked, blocked)).toBeNull()
  })

  it('fires for errors and idle questions/approvals, not plain done', () => {
    expect(
      attentionNotice(
        's',
        state('working'),
        state('errored', {
          error: { class: 'rate_limit', retryable: true },
        }),
      )?.body,
    ).toContain('rate_limit')
    expect(
      attentionNotice('s', state('working'), state('idle', { idle: { kind: 'approval' } }))?.title,
    ).toContain('plan ready')
    expect(
      attentionNotice('s', state('working'), state('idle', { idle: { kind: 'done' } })),
    ).toBeNull()
    expect(
      attentionNotice('s', state('working'), state('idle', { idle: { kind: 'interrupted' } })),
    ).toBeNull()
    expect(attentionNotice('s', state('working'), state('working'))).toBeNull()
  })
})

describe('pushTelegram', () => {
  it('posts a plain-text sendMessage request with trimmed config', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })

    pushTelegram(
      { botToken: ' 123456:secret ', chatId: ' -100123 ' },
      { title: 'podium / keyboard needs you', body: 'SQLite or Postgres?' },
      { fetch },
    )
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:secret/sendMessage',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: '-100123',
          text: 'podium / keyboard needs you\n\nSQLite or Postgres?',
        }),
      },
    )
  })

  it('does nothing when either Telegram field is blank', async () => {
    const fetch = vi.fn()

    pushTelegram({ botToken: '', chatId: '-100123' }, { title: 't', body: 'b' }, { fetch })
    pushTelegram({ botToken: '123456:secret', chatId: '   ' }, { title: 't', body: 'b' }, { fetch })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('logs and swallows network failures', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('socket closed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    pushTelegram(
      { botToken: '123456:secret', chatId: '-100123' },
      { title: 't', body: 'b' },
      { fetch },
    )

    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(warn.mock.calls.flat().join(' ')).toContain('socket closed')
    warn.mockRestore()
  })

  it('logs non-ok Telegram responses without exposing the bot token', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    pushTelegram(
      { botToken: '123456:secret', chatId: '-100123' },
      { title: 't', body: 'b' },
      { fetch },
    )

    await waitFor(() => expect(warn).toHaveBeenCalled())
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).toContain('400')
    expect(logged).toContain('chat not found')
    expect(logged).not.toContain('123456:secret')
    warn.mockRestore()
  })
})
