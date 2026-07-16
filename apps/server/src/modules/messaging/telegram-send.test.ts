import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramChannel } from './telegram'

describe('TelegramChannel.send MarkdownV2 fallback', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('sends with MarkdownV2 parse_mode on success', async () => {
    const bodies: unknown[] = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
    }) as typeof fetch

    const channel = new TelegramChannel({ botToken: 'tok', chatId: '42' })
    await channel.send({ channel: 'telegram', chatId: '42' }, '**hello**')

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ parse_mode: 'MarkdownV2', text: '*hello*' })
  })

  it('falls back to plain text when MarkdownV2 parse fails', async () => {
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) {
        return new Response(
          JSON.stringify({
            ok: false,
            description: "Bad Request: can't parse entities: Can't find end of Bold entity",
          }),
          { status: 400 },
        )
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
    }) as typeof fetch

    const channel = new TelegramChannel({ botToken: 'tok', chatId: '42' })
    await channel.send({ channel: 'telegram', chatId: '42' }, '**hello**')

    expect(call).toBe(2)
    const secondBody = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]![1]?.body))
    expect(secondBody.parse_mode).toBeUndefined()
    expect(secondBody.text).toBe('hello')
  })
})