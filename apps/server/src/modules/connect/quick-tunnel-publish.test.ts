/**
 * The quick-tunnel wrapper's rotation, observed where it matters: at the
 * Connect publisher (POD-4640). Config holding B is necessary but not the
 * point — the point is that Connect is TOLD B, so a daemon that asks the
 * locator gets an address that answers.
 */
import type { InstallationIdentity } from '@podium/runtime/installation-identity'
import { loadConfig, resolvePublicUrl, saveConfig } from '@podium/runtime/config'
import {
  QuickTunnelSupervisor,
  recordQuickTunnelUrl,
  type TunnelProcess,
} from '@podium/runtime/quick-tunnel'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckResult, ConnectClient, LocatorRecord } from './client'
import { watchPublicUrl } from './public-url-watch'
import { ConnectPublisher, TICK_MS } from './publisher'

const identity: InstallationIdentity = {
  version: 1,
  installationId: `pdm_${'a'.repeat(43)}`,
  privateKey: 'x',
  publicKey: 'y',
  generation: 1,
  createdAt: '2026-09-23T00:00:00.000Z',
}

const URL_TIMEOUT_MS = 987_654
const A = 'https://prairie-otter-lamp-nine.trycloudflare.com'
const B = 'https://copper-hill-mango-seven.trycloudflare.com'

class FakeCloudflared implements TunnelProcess {
  alive = true
  #output: ((chunk: string) => void)[] = []
  #exit: ((exit: { code: number | null; signal: string | null }) => void)[] = []
  constructor(readonly pid: number) {}
  onOutput(listener: (chunk: string) => void): void {
    this.#output.push(listener)
  }
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void {
    this.#exit.push(listener)
  }
  kill(): void {
    this.die()
  }
  print(url: string): void {
    for (const listener of this.#output) listener(`INF |  ${url}  |\n`)
  }
  die(): void {
    if (!this.alive) return
    this.alive = false
    for (const listener of this.#exit) listener({ code: 1, signal: null })
  }
}

describe('quick tunnel rotation → Connect publisher', () => {
  const priorStateDir = process.env.PODIUM_STATE_DIR
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-quick-tunnel-publish-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('cloudflared prints A, dies, restarts printing B: the publisher publishes B without waiting for its tick', async () => {
    saveConfig({ mode: 'all-in-one', networkOption: 'cloudflare-tunnel', port: 18787 })

    // --- the server side: the real publisher, with a recording Connect client
    const published: string[] = []
    const client: ConnectClient = {
      register: async () => ({ ok: true }),
      publish: async (record: LocatorRecord) => {
        published.push(record.endpoints[0]!.url)
        return { ok: true }
      },
      clear: async () => ({ ok: true }),
      check: async (url): Promise<CheckResult> => ({ ok: true, url, resolvedTo: [] }),
      resolve: async () => undefined,
    }
    const publisherTimers: { fn: () => void; ms: number }[] = []
    // The same reader server.ts hands the publisher: env, then config.json.
    const readPublicUrl = (): string | undefined => resolvePublicUrl(loadConfig(), {})
    const publisher = new ConnectPublisher({
      client,
      identity: () => identity,
      publicUrl: readPublicUrl,
      enabled: () => true,
      log: { info: () => {}, warn: () => {} },
      // Never fired below: nothing in this test waits for the 5-minute tick.
      setTimer: (fn, ms) => {
        const t = { fn, ms }
        publisherTimers.push(t)
        return t
      },
      clearTimer: (h) => {
        const i = publisherTimers.indexOf(h as { fn: () => void; ms: number })
        if (i >= 0) publisherTimers.splice(i, 1)
      },
    })
    let pollWatch: () => void = () => {}
    const watch = watchPublicUrl({
      read: readPublicUrl,
      onChange: () => publisher.publicUrlChanged(),
      setInterval: (fn) => {
        pollWatch = fn
        return 1
      },
      clearInterval: () => {},
    })
    publisher.start()
    await publisher.settled
    expect(published).toEqual([])
    expect(publisherTimers.map((t) => t.ms)).toEqual([TICK_MS])

    // --- the wrapper side: the real supervisor and the real config write
    const children: FakeCloudflared[] = []
    const restarts: (() => void)[] = []
    const supervisor = new QuickTunnelSupervisor({
      spawn: () => {
        const child = new FakeCloudflared(children.length + 1)
        children.push(child)
        return child
      },
      recordUrl: (url) => {
        recordQuickTunnelUrl(url)
      },
      recordedUrl: loadConfig().publicUrl,
      log: { info: () => {}, warn: () => {} },
      urlTimeoutMs: URL_TIMEOUT_MS,
      // Every timer but the URL deadline is a restart; each is fired by hand.
      setTimer: (fn, ms) => {
        if (ms !== URL_TIMEOUT_MS) restarts.push(fn)
        return fn
      },
      clearTimer: () => {},
    })
    supervisor.start()
    children.at(-1)!.print(A)
    await supervisor.settled
    pollWatch()
    await publisher.settled
    expect(published).toEqual([A])

    // The tunnel rotates.
    children.at(-1)!.die()
    restarts.shift()!()
    children.at(-1)!.print(B)
    await supervisor.settled
    expect(loadConfig().publicUrl).toBe(B)
    pollWatch()
    await publisher.settled
    expect(published).toEqual([A, B])
    expect(publisher.state).toBe('published')

    // An unchanged restart: no config write, so the watch sees nothing and
    // Connect hears nothing.
    children.at(-1)!.die()
    restarts.shift()!()
    children.at(-1)!.print(B)
    await supervisor.settled
    pollWatch()
    await publisher.settled
    expect(published).toEqual([A, B])

    watch.stop()
    await supervisor.stop()
    publisher.stop()
  })
})

describe('watchPublicUrl', () => {
  it('fires only when the answer changes, and a read that throws is not a change', () => {
    let value: string | undefined = A
    let throwNext = false
    const seen: (string | undefined)[] = []
    let poll: () => void = () => {}
    watchPublicUrl({
      read: () => {
        if (throwNext) throw new Error('config.json mid-write')
        return value
      },
      onChange: (url) => seen.push(url),
      setInterval: (fn) => {
        poll = fn
        return 1
      },
      clearInterval: () => {},
    })
    poll()
    expect(seen).toEqual([])
    throwNext = true
    poll()
    expect(seen).toEqual([])
    throwNext = false
    value = B
    poll()
    poll()
    expect(seen).toEqual([B])
    value = undefined
    poll()
    expect(seen).toEqual([B, undefined])
  })
})
