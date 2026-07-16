/**
 * Emitter tests [spec:SP-f933].
 *
 * The behaviors under test are the promises, not the plumbing: nothing is
 * collected before consent, consent is re-read at flush (so `podium telemetry
 * off` lands without a restart), and every failure mode is silent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PodiumConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryEmitter } from './emitter'
import { readLastSent, readQueue } from './queue'

const INSTALL_ID = '3f9c1a2e-0000-4000-8000-000000000000'
const INSTALL = '/opt/podium'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-telemetry-emitter-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A harness whose config is a mutable object — the point being that the
 *  emitter re-reads it, so a test can flip consent mid-run like a user would. */
function harness(initial: PodiumConfig = {}) {
  let config: PodiumConfig = initial
  const posted: unknown[] = []
  let response: Response = new Response('', { status: 200 })
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)))
    return response
  })
  const emitter = new TelemetryEmitter({
    stateDir: dir,
    installRoot: INSTALL,
    version: '1.4.2',
    gauges: () => ({ machines: 3 }),
    env: {},
    loadConfig: () => config,
    now: () => 1_700_000_000_000,
    random: () => 0,
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    platform: 'linux',
    arch: 'x64',
  })
  return {
    emitter,
    posted,
    fetchMock,
    setConfig: (next: PodiumConfig) => {
      config = next
    },
    setResponse: (r: Response) => {
      response = r
    },
  }
}

const onUsage: PodiumConfig = {
  telemetry: { usage: 'on', installId: INSTALL_ID, since: 1_700_000_000_000 - 3 * 86_400_000 },
}
const onBoth: PodiumConfig = {
  telemetry: {
    usage: 'on',
    crash: 'on',
    installId: INSTALL_ID,
    since: 1_700_000_000_000 - 3 * 86_400_000,
  },
}

describe('no collection before consent (D4)', () => {
  it('counts NOTHING while usage is absent', async () => {
    const h = harness({})
    h.emitter.recordSession('claude-code')
    h.emitter.recordSession('codex')
    h.emitter.markFeature('issues')
    await h.emitter.flush()
    expect(h.posted).toEqual([])
    expect(readQueue(dir)).toEqual([])
  })

  it('counts nothing while usage is explicitly off', async () => {
    const h = harness({ telemetry: { usage: 'off', crash: 'off' } })
    h.emitter.recordSession('claude-code')
    await h.emitter.flush()
    expect(h.posted).toEqual([])
  })

  it('counts nothing under DO_NOT_TRACK even with consent stored', async () => {
    const config: PodiumConfig = onBoth
    const posted: unknown[] = []
    const emitter = new TelemetryEmitter({
      stateDir: dir,
      installRoot: INSTALL,
      version: '1.4.2',
      gauges: () => ({ machines: 1 }),
      env: { DO_NOT_TRACK: '1' },
      loadConfig: () => config,
      fetch: (async (_u: unknown, init?: RequestInit) => {
        posted.push(init?.body)
        return new Response('', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    emitter.recordSession('claude-code')
    emitter.recordCrash(new TypeError('x'))
    await emitter.flush()
    expect(posted).toEqual([])
    expect(readQueue(dir)).toEqual([])
    void config
  })

  it('there is no backlog to send when a user opts in later — the window starts empty', async () => {
    // The explicit rejection of Go's local-collect default: turning telemetry on
    // must not ship what happened while it was off.
    const h = harness({})
    h.emitter.recordSession('claude-code')
    h.emitter.recordSession('codex')
    h.setConfig(onUsage)
    await h.emitter.flush()
    expect(h.posted).toEqual([expect.objectContaining({ sessions: {}, features: {} })])
  })
})

describe('usage report', () => {
  it('sends the design-doc shape once a day', async () => {
    const h = harness(onUsage)
    h.emitter.recordSession('claude-code')
    h.emitter.recordSession('claude-code')
    h.emitter.recordSession('codex')
    h.emitter.markFeature('issues')
    h.emitter.markFeature('spec')
    await h.emitter.flush()
    expect(h.posted).toEqual([
      {
        schema: 1,
        installId: INSTALL_ID,
        version: '1.4.2',
        os: 'linux',
        arch: 'x64',
        installAge: '1-7d',
        machines: '2-5',
        sessions: { 'claude-code': 2, codex: 1 },
        features: { issues: true, spec: true },
      },
    ])
  })

  it('resets the counters after a flush (a window is a window)', async () => {
    const h = harness(onUsage)
    h.emitter.recordSession('claude-code')
    await h.emitter.flush()
    await h.emitter.flush()
    expect(h.posted).toHaveLength(2)
    expect(h.posted[1]).toMatchObject({ sessions: {}, features: {} })
  })

  it('records what was actually sent, for `podium telemetry show`', async () => {
    const h = harness(onUsage)
    h.emitter.recordSession('codex')
    await h.emitter.flush()
    expect(readLastSent(dir)?.report).toMatchObject({ sessions: { codex: 1 } })
  })

  it('cannot build a report without an installId (nobody opted in)', () => {
    const h = harness({ telemetry: { usage: 'on' } })
    expect(h.emitter.buildUsageReport()).toBeUndefined()
  })

  it('survives a gauge that throws', async () => {
    const config: PodiumConfig = onUsage
    const emitter = new TelemetryEmitter({
      stateDir: dir,
      installRoot: INSTALL,
      version: '1.4.2',
      gauges: () => {
        throw new Error('registry is gone')
      },
      env: {},
      loadConfig: () => config,
      fetch: (async () => new Response('', { status: 200 })) as unknown as typeof globalThis.fetch,
    })
    await expect(emitter.flush()).resolves.toBeUndefined()
    void config
  })
})

describe('consent read fresh at flush (D9)', () => {
  it('turning usage off mid-run means the next flush sends nothing', async () => {
    const h = harness(onUsage)
    h.emitter.recordSession('claude-code')
    // `podium telemetry off` while the server runs — no restart.
    h.setConfig({ telemetry: { usage: 'off', installId: INSTALL_ID } })
    await h.emitter.flush()
    expect(h.posted).toEqual([])
  })

  it('DROPS a report already queued for a tier that is now off — off means off', async () => {
    const h = harness(onUsage)
    h.emitter.recordSession('claude-code')
    h.setResponse(new Response('', { status: 503 }))
    await h.emitter.flush() // queued, relay down (this attempt is in h.posted)
    expect(readQueue(dir)).toHaveLength(1)
    const attemptsBefore = h.posted.length

    h.setResponse(new Response('', { status: 200 }))
    h.setConfig({ telemetry: { usage: 'off', installId: INSTALL_ID } })
    await h.emitter.flush()
    // Data gathered while it was on does not get to leave after it is off: the
    // relay is healthy now, and we STILL don't send — we drop it.
    expect(h.posted).toHaveLength(attemptsBefore)
    expect(readQueue(dir)).toEqual([])
  })

  it('turning usage on mid-run starts sending with no restart', async () => {
    const h = harness({ telemetry: { usage: 'off', installId: INSTALL_ID, since: 1 } })
    h.emitter.recordSession('claude-code') // not counted — off
    h.setConfig(onUsage)
    h.emitter.recordSession('codex') // counted
    await h.emitter.flush()
    expect(h.posted).toEqual([expect.objectContaining({ sessions: { codex: 1 } })])
  })
})

describe('crash tier', () => {
  const crash = (line: number) => {
    const err = new TypeError('failed to read /home/alice/acme/private.key')
    err.stack = [
      'TypeError: failed to read /home/alice/acme/private.key',
      `    at handleSession (${INSTALL}/apps/server/src/router.ts:${line}:15)`,
    ].join('\n')
    return err
  }

  it('queues a scrubbed report with no message anywhere in it', async () => {
    const h = harness(onBoth)
    h.emitter.recordCrash(crash(412))
    await h.emitter.flush()
    expect(h.posted).toContainEqual({
      schema: 1,
      installId: INSTALL_ID,
      version: '1.4.2',
      os: 'linux',
      arch: 'x64',
      errorType: 'TypeError',
      frames: [{ file: 'apps/server/src/router.ts', line: 412, fn: 'handleSession' }],
    })
    expect(JSON.stringify(h.posted)).not.toContain('private.key')
    expect(JSON.stringify(h.posted)).not.toContain('alice')
  })

  it('never records a crash while the crash tier is off, even with usage on', async () => {
    const h = harness(onUsage)
    h.emitter.recordCrash(crash(412))
    await h.emitter.flush()
    expect(readQueue(dir).filter((r) => 'errorType' in r)).toEqual([])
  })

  it('rate-limits a crash LOOP to one report per signature', async () => {
    const h = harness(onBoth)
    for (let i = 0; i < 50; i++) h.emitter.recordCrash(crash(412))
    await h.emitter.flush()
    expect(h.posted.filter((p) => (p as { errorType?: string }).errorType)).toHaveLength(1)
  })

  it('caps novel signatures per window too', async () => {
    const h = harness(onBoth)
    for (let i = 1; i <= 20; i++) h.emitter.recordCrash(crash(i))
    await h.emitter.flush()
    expect(h.posted.filter((p) => (p as { errorType?: string }).errorType)).toHaveLength(5)
  })

  it('drops a crash with no Podium frames rather than sending a useless beacon', async () => {
    const h = harness(onBoth)
    const err = new TypeError('boom')
    err.stack = 'TypeError: boom\n    at userCode (/home/alice/acme/app.ts:1:1)'
    h.emitter.recordCrash(err)
    expect(readQueue(dir)).toEqual([])
  })
})

describe('failure is silent and free', () => {
  it('a network error leaves the report queued and never throws', async () => {
    const config: PodiumConfig = onUsage
    const emitter = new TelemetryEmitter({
      stateDir: dir,
      installRoot: INSTALL,
      version: '1.4.2',
      gauges: () => ({ machines: 1 }),
      env: {},
      loadConfig: () => config,
      fetch: (async () => {
        throw new Error('ENOTFOUND telemetry.podium.dev')
      }) as unknown as typeof globalThis.fetch,
    })
    emitter.recordSession('claude-code')
    await expect(emitter.flush()).resolves.toBeUndefined()
    expect(readQueue(dir)).toHaveLength(1)
    void config
  })

  it('retries a queued report on the next flush (bounded, no storm)', async () => {
    const h = harness(onUsage)
    h.setResponse(new Response('', { status: 503 }))
    h.emitter.recordSession('claude-code')
    await h.emitter.flush()
    expect(readQueue(dir)).toHaveLength(1)
    h.setResponse(new Response('', { status: 200 }))
    await h.emitter.flush()
    // The queue drains: the retried report plus the (empty) new window's one.
    expect(readQueue(dir)).toEqual([])
    // 3 ATTEMPTS total — the failed one, then its retry, then the new window.
    // One retry per flush, not a storm: nothing re-sends within a flush.
    expect(h.posted).toHaveLength(3)
  })

  it('does NOT re-send forever when the relay rejects the body (4xx)', async () => {
    const h = harness(onUsage)
    h.setResponse(new Response('bad request', { status: 400 }))
    h.emitter.recordSession('claude-code')
    await h.emitter.flush()
    expect(readQueue(dir)).toEqual([])
  })

  it('a config that throws resolves to "no consent", not a crash', async () => {
    const emitter = new TelemetryEmitter({
      stateDir: dir,
      installRoot: INSTALL,
      gauges: () => ({ machines: 1 }),
      env: {},
      loadConfig: () => {
        throw new Error('config.json is corrupt')
      },
    })
    expect(() => emitter.recordSession('claude-code')).not.toThrow()
    await expect(emitter.flush()).resolves.toBeUndefined()
  })

  it('the flush timer never holds the process open', () => {
    const h = harness(onUsage)
    h.emitter.start()
    // unref'd: node/bun exit with this pending. stop() is still idempotent.
    h.emitter.stop()
    h.emitter.stop()
  })
})
