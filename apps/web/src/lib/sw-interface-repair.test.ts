import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.useRealTimers())

it('activates over an old non-responsive page while keeping a matching or unsaved page', async () => {
  vi.useFakeTimers()
  let activate!: (event: { waitUntil: (work: Promise<void>) => void }) => void
  class Channel {
    port1 = { close() {}, onmessage: null as ((event: { data: unknown }) => void) | null }
    port2 = { reply: (data: unknown) => this.port1.onmessage?.({ data }) }
  }
  const client = (path: string, answer?: unknown) => ({
    url: `https://podium.example${path}`,
    navigate: vi.fn(async () => {}),
    postMessage: (_message: unknown, ports: Channel['port2'][]) => {
      if (answer !== undefined) ports[0]?.reply(answer)
    },
  })
  const old = client('/workspace')
  const current = client('/issues', { bundle: 'bundle+current', mayReload: true })
  const unsaved = client('/workspace?pane=editor', { bundle: 'bundle+earlier', mayReload: false })
  const phone = client('/mobile/')
  const clients = [old, current, unsaved, phone]
  runInNewContext(
    readFileSync(new NodeURL('../../public/sw-interface-repair.js', import.meta.url), 'utf8'),
    {
      self: {
        addEventListener: (_type: string, listener: typeof activate) => {
          activate = listener
        },
        registration: { scope: 'https://podium.example/' },
        location: { origin: 'https://podium.example' },
        clients: { claim: async () => {}, matchAll: async () => clients },
      },
      fetch: async () => ({ ok: true, json: async () => ({ bundleVersion: 'bundle+current' }) }),
      URL,
      AbortSignal,
      MessageChannel: Channel,
      setTimeout,
      clearTimeout,
    },
  )
  let finished!: Promise<void>
  activate({
    waitUntil: (work) => {
      finished = work
    },
  })
  await vi.advanceTimersByTimeAsync(3000)
  await finished
  expect(old.navigate).toHaveBeenCalledExactlyOnceWith(old.url)
  for (const value of [current, unsaved, phone]) expect(value.navigate).not.toHaveBeenCalled()
})
