import { lazy } from '@podium/mobx-helpers'
import {
  asSessionId,
  CONTEXT_MAX_ROWS,
  type ContextDetailResult,
  type ContextReason,
  sameContextSample,
} from '@podium/model'
import type { ContextReadResult, SessionContextReadInput } from '@podium/protocol/daemon'
import { action, observable, observableRef, reaction, runInAction } from 'mobx'
import type { SessionModel } from './models'

/** Structural port: apps pass their existing typed tRPC client. Cancellation
 * must reach the request, rather than merely hiding the eventual answer. */
export interface ContextDetailApi {
  sessions: {
    contextRead: {
      query(
        input: SessionContextReadInput,
        options?: { signal?: AbortSignal },
      ): Promise<ContextReadResult>
    }
  }
}

/** One visible opening owns this answer. Constructing/rendering/opening never
 * probes. load() is explicit and may count native tokens; repeated intents for
 * the same sample reuse this attempt, including failures. Only retry() starts
 * another attempt. Other views share native work at the generic server port. */
export class ContextDetailView {
  @observable accessor opened = false
  @observable accessor loading = false
  @observableRef accessor answer: ContextDetailResult | undefined = undefined
  private stop: (() => void) | undefined
  private abort: AbortController | undefined
  private pending: Promise<void> | undefined
  private attempted = false
  private generation = 0

  constructor(
    readonly session: SessionModel,
    private readonly api: ContextDetailApi,
  ) {}

  @lazy get error(): ContextReason | undefined {
    return this.answer?.status === 'available' ? undefined : this.answer?.reason
  }

  @lazy private get requestKey(): string | undefined {
    const context = this.session.context
    if (this.session.contextDetailLevel !== 'on-demand' || context?.status !== 'available')
      return undefined
    return JSON.stringify([
      this.session.id,
      this.session.machineId,
      this.session.driverId,
      context.sample,
      context.model,
    ])
  }

  @action open(): void {
    if (this.opened) return
    this.opened = true
    this.stop = reaction(
      () => this.requestKey,
      () => this.clear(),
    )
  }

  @action private clear(): void {
    ++this.generation
    this.abort?.abort()
    this.abort = undefined
    this.pending = undefined
    this.attempted = false
    this.loading = false
    this.answer = undefined
  }

  /** Hide/unmount closes the opening, removes demand and cancels its waiter. */
  @action close(): void {
    this.opened = false
    this.stop?.()
    this.stop = undefined
    this.clear()
  }

  @action cancel(): void {
    this.clear()
    this.attempted = true
  }

  @action retry(options?: { timeoutMs?: number; maxRows?: number }): Promise<void> {
    this.clear()
    return this.load(options)
  }

  @action load(options: { timeoutMs?: number; maxRows?: number } = {}): Promise<void> {
    if (!this.opened) return Promise.resolve()
    if (this.pending) return this.pending
    if (this.attempted || !this.requestKey) return Promise.resolve()
    const context = this.session.context
    if (context?.status !== 'available') return Promise.resolve()
    const sample = context.sample
    const key = this.requestKey
    const generation = ++this.generation
    const abort = new AbortController()
    this.abort = abort
    this.attempted = true
    this.loading = true
    const timeoutMs = options.timeoutMs ?? 5000
    const maxRows = options.maxRows ?? CONTEXT_MAX_ROWS
    const failure = (
      status: 'cancelled' | 'refused' | 'unavailable' | 'unsupported',
      code: string,
      message: string,
    ): ContextDetailResult => ({
      version: 1,
      status,
      sample,
      reason: { code, message },
    })
    const validBounds =
      Number.isInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 60_000 &&
      Number.isInteger(maxRows) &&
      maxRows > 0 &&
      maxRows <= CONTEXT_MAX_ROWS
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => {}
    const request = validBounds
      ? Promise.race([
          Promise.resolve()
            .then(() => {
              abort.signal.throwIfAborted()
              return this.api.sessions.contextRead.query(
                {
                  sessionId: asSessionId(this.session.id),
                  read: { intent: 'breakdown', sample, timeoutMs, maxRows },
                },
                { signal: abort.signal },
              )
            })
            .then((value) =>
              value.intent === 'breakdown' && sameContextSample(value.result.sample, sample)
                ? value.result
                : failure(
                    'refused',
                    'invalid-response',
                    'Context answer does not describe this sample',
                  ),
            ),
          new Promise<ContextDetailResult>((resolve) => {
            onAbort = () => resolve(failure('cancelled', 'cancelled', 'Context read cancelled'))
            abort.signal.addEventListener('abort', onAbort, { once: true })
            timer = setTimeout(() => {
              resolve(failure('unavailable', 'timed-out', 'Context detail timed out'))
              abort.abort()
            }, timeoutMs)
          }),
        ])
      : Promise.resolve(
          failure('refused', 'request-bounds', 'Context read exceeds its request bounds'),
        )
    const work = request
      .catch((cause: unknown) => {
        const data = cause && typeof cause === 'object' && 'data' in cause ? cause.data : undefined
        const code = data && typeof data === 'object' && 'code' in data ? data.code : undefined
        if (code === 'NOT_FOUND' || code === 'METHOD_NOT_SUPPORTED')
          return failure(
            'unsupported',
            'unsupported-peer',
            'This server does not support context detail reads',
          )
        if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN')
          return failure('refused', 'unauthorized', 'Context read is not authorized')
        return failure('unavailable', 'transport-error', 'Context detail could not be read')
      })
      .then((answer) =>
        runInAction(() => {
          if (generation === this.generation && this.opened && key === this.requestKey)
            this.answer = answer
        }),
      )
      .finally(() => {
        clearTimeout(timer)
        abort.signal.removeEventListener('abort', onAbort)
        runInAction(() => {
          if (generation === this.generation) {
            this.loading = false
            this.abort = undefined
          }
          if (this.pending === work) this.pending = undefined
        })
      })
    this.pending = work
    return work
  }
}
