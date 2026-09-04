import type { InstallationIdentity } from '@podium/runtime/installation-identity'
import { describe, expect, it } from 'vitest'
import type { CheckResult, ConnectClient, ConnectOutcome, LocatorRecord } from './client'
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  ConnectPublisher,
  REPUBLISH_MS,
  TICK_MS,
} from './publisher'

const identity: InstallationIdentity = {
  version: 1,
  installationId: `pdm_${'a'.repeat(43)}`,
  privateKey: 'x',
  publicKey: 'y',
  generation: 3,
  createdAt: '2026-09-04T00:00:00.000Z',
}

function harness(over: { publicUrl?: string | undefined; enabled?: boolean } = {}) {
  let enabled = over.enabled ?? true
  const calls: string[] = []
  const published: LocatorRecord[] = []
  let now = 1_800_000_000_000
  let publicUrl = 'publicUrl' in over ? over.publicUrl : 'https://my.example'
  const answers = {
    register: [] as ConnectOutcome[],
    publish: [] as ConnectOutcome[],
    clear: [] as ConnectOutcome[],
  }
  const next = (name: keyof typeof answers): ConnectOutcome => answers[name].shift() ?? { ok: true }
  const client: ConnectClient = {
    async register() {
      calls.push('register')
      return next('register')
    },
    async publish(record) {
      calls.push('publish')
      published.push(record)
      return next('publish')
    },
    async clear() {
      calls.push('clear')
      return next('clear')
    },
    async check(url): Promise<CheckResult> {
      calls.push(`check:${url}`)
      return { ok: true, url, resolvedTo: [] }
    },
  }
  const timers: { fn: () => void; ms: number }[] = []
  const logs: string[] = []
  let transferred = 0
  const publisher = new ConnectPublisher({
    client,
    identity: () => identity,
    publicUrl: () => publicUrl,
    enabled: () => enabled,
    log: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) },
    onTransferred: () => {
      transferred++
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as { fn: () => void; ms: number })
      if (i >= 0) timers.splice(i, 1)
    },
    now: () => now,
  })
  const fire = async () => {
    const t = timers.shift()
    if (!t) throw new Error('no timer armed')
    now += t.ms
    t.fn()
    await publisher.settled
    return t.ms
  }
  return {
    publisher,
    calls,
    published,
    answers,
    timers,
    logs,
    fire,
    setPublicUrl: (u: string | undefined) => {
      publicUrl = u
    },
    setEnabled: (e: boolean) => {
      enabled = e
    },
    advance: (ms: number) => {
      now += ms
    },
    get transferred() {
      return transferred
    },
  }
}

describe('ConnectPublisher', () => {
  it('registers once, publishes the public URL, then idles on the tick', async () => {
    const h = harness()
    h.publisher.start()
    await h.publisher.settled
    expect(h.calls).toEqual(['register', 'publish'])
    expect(h.published[0]).toEqual({
      generation: 3,
      issuedAt: new Date(1_800_000_000_000).toISOString(),
      expiresAt: null,
      endpoints: [{ url: 'https://my.example', priority: 100 }],
    })
    expect(h.publisher.state).toBe('published')
    expect(h.timers[0]?.ms).toBe(TICK_MS)
    await h.fire()
    // Same URL, less than a day: nothing sent.
    expect(h.calls).toEqual(['register', 'publish'])
  })

  it('sends nothing before a public URL exists, then everything once it does', async () => {
    const h = harness({ publicUrl: undefined })
    h.publisher.start()
    await h.publisher.settled
    expect(h.calls).toEqual([])
    expect(h.publisher.state).toBe('idle')
    h.setPublicUrl('https://late.example')
    await h.fire()
    expect(h.calls).toEqual(['register', 'publish'])
  })

  it('republishes when the URL changes and after a day', async () => {
    const h = harness()
    h.publisher.start()
    await h.publisher.settled
    h.setPublicUrl('https://moved.example')
    h.publisher.publicUrlChanged()
    await h.publisher.settled
    expect(h.published[1]?.endpoints[0]?.url).toBe('https://moved.example')
    h.advance(REPUBLISH_MS)
    await h.fire()
    expect(h.published).toHaveLength(3)
  })

  it('backs off from a minute to an hour on failure and resets on success', async () => {
    const h = harness()
    h.answers.register.push({ ok: false, failure: { kind: 'network', message: 'down' } })
    h.publisher.start()
    await h.publisher.settled
    expect(h.publisher.state).toBe('backoff')
    expect(h.timers[0]?.ms).toBe(BACKOFF_MIN_MS)
    h.answers.publish.push(
      { ok: false, failure: { kind: 'http', status: 500, code: 'INTERNAL', message: 'x' } },
      { ok: false, failure: { kind: 'network', message: 'down' } },
      { ok: false, failure: { kind: 'network', message: 'down' } },
      { ok: false, failure: { kind: 'network', message: 'down' } },
      { ok: false, failure: { kind: 'network', message: 'down' } },
      { ok: false, failure: { kind: 'network', message: 'down' } },
      { ok: false, failure: { kind: 'network', message: 'down' } },
    )
    const delays: number[] = []
    for (let i = 0; i < 8; i++) delays.push(await h.fire())
    expect(delays).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
    ])
    expect(h.publisher.state).toBe('published')
    expect(h.timers[0]?.ms).toBe(TICK_MS)
    expect(BACKOFF_MAX_MS).toBe(3_600_000)
  })

  it('stops for good on GENERATION_BEHIND and says the installation moved', async () => {
    const h = harness()
    h.answers.publish.push({
      ok: false,
      failure: { kind: 'http', status: 409, code: 'GENERATION_BEHIND', message: 'moved' },
    })
    h.publisher.start()
    await h.publisher.settled
    expect(h.publisher.state).toBe('transferred')
    expect(h.transferred).toBe(1)
    expect(h.timers).toHaveLength(0)
    expect(h.logs.some((l) => l.includes('transferred to another server'))).toBe(true)
    h.publisher.publicUrlChanged()
    h.publisher.start()
    await h.publisher.settled
    expect(h.calls).toEqual(['register', 'publish'])
  })

  it('turning Connect off clears the record once and keeps ticking; on resumes', async () => {
    const h = harness()
    h.publisher.start()
    await h.publisher.settled
    h.setEnabled(false)
    await h.fire()
    expect(h.calls).toEqual(['register', 'publish', 'clear'])
    expect(h.publisher.state).toBe('disabled')
    await h.fire()
    expect(h.calls).toEqual(['register', 'publish', 'clear'])
    h.setEnabled(true)
    await h.fire()
    expect(h.calls).toEqual(['register', 'publish', 'clear', 'publish'])
    expect(h.publisher.state).toBe('published')
  })

  it('off from the start sends nothing at all', async () => {
    const h = harness({ enabled: false })
    h.publisher.start()
    await h.publisher.settled
    expect(h.calls).toEqual([])
    expect(h.publisher.state).toBe('disabled')
    expect(h.timers[0]?.ms).toBe(TICK_MS)
  })

  it('stop disarms without sending anything', async () => {
    const h = harness()
    h.publisher.start()
    await h.publisher.settled
    h.publisher.stop()
    expect(h.timers).toHaveLength(0)
    expect(h.publisher.state).toBe('stopped')
  })

  it('check goes straight to the client', async () => {
    const h = harness()
    expect(await h.publisher.check('https://x.example')).toMatchObject({ ok: true })
    expect(h.calls).toEqual(['check:https://x.example'])
  })
})
