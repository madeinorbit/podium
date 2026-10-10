/**
 * THE PUBLISHER: keeps Podium Connect's record of where this installation is
 * reachable in step with `publicUrl` (PDM-51).
 *
 * A small state machine driven by one timer. Register once (a repeat is a 200,
 * so a lost first answer costs nothing), then publish whenever the public URL
 * differs from what was last published or a day has passed. Failures back off
 * from a minute to an hour and never block anything: a server whose Connect
 * is unreachable is a server with clients that fall back to their cached URL.
 *
 * GENERATION_BEHIND is the one answer that stops the machine for good. It means
 * a newer generation of this installation has published — a transfer target is
 * serving — so this process is the demoted source and its URL must not win.
 *
 * Every `publicUrl` read goes through the injected reader, which resolves
 * env → config.json → default on each call, so a settings write is picked up
 * on the next tick with no hook into the settings path.
 */
import { connectStableLink } from '@podium/protocol/server-locate'
import type { InstallationIdentity } from '@podium/runtime/installation-identity'
import type { CheckResult, ConnectClient, ConnectFailure, LocatorRecord } from './client'

export type PublisherState =
  | 'idle'
  | 'registering'
  | 'published'
  | 'backoff'
  | 'transferred'
  | 'stopped'
  /** The operator turned Connect off; the record was cleared. */
  | 'disabled'

export interface PublisherDeps {
  client: ConnectClient
  identity: () => InstallationIdentity
  publicUrl: () => string | undefined
  /** PODIUM_CONNECT, read per tick so a config change lands without a restart. */
  enabled: () => boolean
  log: {
    info(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
  }
  /** Called once when GENERATION_BEHIND arrives: this installation moved elsewhere. */
  onTransferred?: () => void
  /** The Connect origin, for the stable link a browser bookmarks (POD-5921). */
  baseUrl?: string
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Milliseconds. */
  now?: () => number
}

export const TICK_MS = 5 * 60_000
export const REPUBLISH_MS = 24 * 3_600_000
export const BACKOFF_MIN_MS = 60_000
export const BACKOFF_MAX_MS = 3_600_000
export const PUBLIC_URL_PRIORITY = 100

export class ConnectPublisher {
  #state: PublisherState = 'idle'
  #registered = false
  #timer: unknown
  #backoffMs = BACKOFF_MIN_MS
  #publishedUrl: string | undefined
  #publishedAt = 0
  #inFlight: Promise<void> | undefined
  /** A URL change arrived while a tick was running: run once more after it. */
  #rerun = false
  readonly #deps: PublisherDeps
  readonly #setTimer: (fn: () => void, ms: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #now: () => number

  constructor(deps: PublisherDeps) {
    this.#deps = deps
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
    this.#now = deps.now ?? (() => Date.now())
  }

  get state(): PublisherState {
    return this.#state
  }

  /** Publish now (or register first), then keep publishing on the timer. */
  start(): void {
    if (this.#state === 'transferred') return
    this.#state = 'idle'
    void this.#tick()
  }

  stop(): void {
    this.#disarm()
    if (this.#state !== 'transferred') this.#state = 'stopped'
  }

  /** The public URL changed: publish on the next tick rather than in a day. */
  publicUrlChanged(): void {
    if (this.#state === 'transferred' || this.#state === 'stopped') return
    // A tick already running may have read the OLD url (a reboot: the publisher starts
    // while the tunnel is still coming up). Joining it would leave the new one for the
    // 5-minute timer, so ask for one more run after it instead.
    if (this.#inFlight) {
      this.#rerun = true
      return
    }
    this.#disarm()
    void this.#tick()
  }

  /**
   * `https://connect.podium.do/to/<installationId>` (POD-5921): a bookmark that
   * survives this server's address changing. `undefined` while publishing is
   * off — the link would lead nowhere — or without a Connect origin.
   */
  stableLink(): string | undefined {
    if (!this.#deps.baseUrl || !this.#deps.enabled()) return undefined
    try {
      return connectStableLink(this.#deps.identity().installationId, this.#deps.baseUrl)
    } catch {
      return undefined
    }
  }

  check(url: string): Promise<CheckResult> {
    return this.#deps.client.check(url)
  }

  /** Awaitable for tests: the current tick, if one is running. */
  get settled(): Promise<void> {
    return this.#inFlight ?? Promise.resolve()
  }

  #fields(failure: ConnectFailure): Record<string, unknown> {
    return failure.kind === 'http'
      ? { status: failure.status, code: failure.code, message: failure.message }
      : { message: failure.message }
  }

  #disarm(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer)
    this.#timer = undefined
  }

  #arm(ms: number): void {
    this.#disarm()
    this.#timer = this.#setTimer(() => void this.#tick(), ms)
  }

  #tick(): Promise<void> {
    if (this.#inFlight) return this.#inFlight
    this.#inFlight = this.#run().finally(() => {
      this.#inFlight = undefined
      if (this.#rerun) {
        this.#rerun = false
        this.#disarm()
        void this.#tick()
      }
    })
    return this.#inFlight
  }

  async #run(): Promise<void> {
    if (this.#state === 'transferred' || this.#state === 'stopped') return
    if (!this.#deps.enabled()) {
      // Off: clear what we published (once), then keep ticking so turning it
      // back on needs no restart either.
      if (this.#registered && this.#publishedUrl !== undefined) {
        const result = await this.#deps.client.clear()
        if (result.ok) {
          this.#publishedUrl = undefined
          this.#deps.log.info('connect: disabled, record cleared')
        } else {
          this.#deps.log.warn('connect: could not clear the record', this.#fields(result.failure))
        }
      }
      this.#state = 'disabled'
      this.#arm(TICK_MS)
      return
    }
    const url = this.#deps.publicUrl()
    if (!url) {
      // Nothing to say yet. Nothing leaves this server before a public URL exists.
      this.#state = 'idle'
      this.#arm(TICK_MS)
      return
    }
    if (!this.#registered) {
      this.#state = 'registering'
      const result = await this.#deps.client.register()
      if (!result.ok) return this.#fail('connect: registration failed, retrying', result.failure)
      this.#registered = true
    }
    const due = this.#publishedUrl !== url || this.#now() - this.#publishedAt >= REPUBLISH_MS
    if (due) {
      const record: LocatorRecord = {
        generation: this.#deps.identity().generation,
        issuedAt: new Date(this.#now()).toISOString(),
        expiresAt: null,
        endpoints: [{ url, priority: PUBLIC_URL_PRIORITY }],
      }
      const result = await this.#deps.client.publish(record)
      if (!result.ok) {
        if (result.failure.kind === 'http' && result.failure.code === 'GENERATION_BEHIND') {
          this.#state = 'transferred'
          this.#disarm()
          this.#deps.log.warn('connect: this installation was transferred to another server', {
            generation: record.generation,
          })
          this.#deps.onTransferred?.()
          return
        }
        return this.#fail('connect: publish failed, retrying', result.failure)
      }
      this.#publishedUrl = url
      this.#publishedAt = this.#now()
      this.#deps.log.info('connect: published', { url, generation: record.generation })
    }
    this.#state = 'published'
    this.#backoffMs = BACKOFF_MIN_MS
    this.#arm(TICK_MS)
  }

  #fail(message: string, failure: ConnectFailure): void {
    this.#state = 'backoff'
    // While Connect still holds an OLD address, joined machines that lost this server
    // can only find it once a retry lands, so never wait longer than the normal tick.
    const pending = this.#deps.publicUrl() !== this.#publishedUrl
    const ceiling = pending ? TICK_MS : BACKOFF_MAX_MS
    const delay = Math.min(this.#backoffMs, ceiling)
    this.#deps.log.warn(message, { ...this.#fields(failure), retryInMs: delay })
    this.#arm(delay)
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS)
  }
}
