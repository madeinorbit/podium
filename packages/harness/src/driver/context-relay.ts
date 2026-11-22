import {
  type ContextInvalidationCause,
  type ContextRevision,
  invalidateContextSummary,
  sameContextSample,
} from '@podium/model'
import {
  admitContextReadResult,
  type ContextObservation,
  ContextDetailRequest as DetailRequestSchema,
  ContextObservation as ObservationSchema,
} from '@podium/protocol/daemon'
import type {
  ContextProbePort,
  ContextReader,
  ContextReadOptions,
  ContextSessionStrategy,
} from '../context-types.js'
import { compareProviderCursor, providerCursorRegressed } from '../observer.js'
import { contextStrategyFor } from '../registry.js'
import type { SessionBinding } from './binding.js'
import type { CausalEnvelope, RuntimeEvent, SessionMetadataObservation } from './events.js'

/** Native resume can replay frames before the RPC supplies the binding identity.
 * Keep that bounded connection window, including the original source time. */
export function createContextPayloadBuffer(now: () => string, limit = 128) {
  type Source = Pick<CausalEnvelope, 'at' | 'provenance'>
  let sink: ((payload: unknown, source: Source) => void) | undefined
  const pending: { payload: unknown; source: Source }[] = []
  return {
    push(payload: unknown): void {
      const source: Source = { at: now(), provenance: sink ? 'live' : 'bootstrap' }
      if (sink) sink(payload, source)
      else {
        pending.push({ payload, source })
        if (pending.length > limit) pending.splice(0, pending.length - limit)
      }
    },
    bind(next: (payload: unknown, source: Source) => void): void {
      sink = next
      for (const entry of pending.splice(0)) next(entry.payload, entry.source)
    },
  }
}

/** Deadlines/lifetimes surround opaque IO; operation selection remains adapter-owned. */
export async function boundedContextRead<T>(
  options: ContextReadOptions,
  lifetime: AbortSignal,
  read: (options: ContextReadOptions) => Promise<T>,
): Promise<T> {
  const abort = new AbortController()
  const stop = () => abort.abort()
  if (options.signal?.aborted || lifetime.aborted) stop()
  options.signal?.addEventListener('abort', stop, { once: true })
  lifetime.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, options.timeoutMs)
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        abort.signal.throwIfAborted()
        return read({ ...options, signal: abort.signal })
      }),
      new Promise<never>((_, reject) => {
        const fail = () =>
          reject(new DOMException('Context read cancelled or timed out', 'AbortError'))
        abort.signal.addEventListener('abort', fail, { once: true })
        if (abort.signal.aborted) fail()
      }),
    ])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
    lifetime.removeEventListener('abort', stop)
  }
}

export function initializeContextPayload(
  harness: string,
  driver: SessionBinding['driver'],
  payload: unknown,
): unknown {
  const declaration = contextStrategyFor(harness, driver)
  return declaration.supported ? (declaration.value.initialize?.(payload) ?? payload) : payload
}

/** One context strategy per causal binding, on the existing native transport.
 * No native payload inspection, capacity lookup or token arithmetic lives here.
 */
export class RuntimeContextRelay {
  private lifetime = new AbortController()
  private strategy?: ContextSessionStrategy
  private revision?: ContextRevision
  private bindingKey?: string
  private latest?: ContextObservation
  private disposed = false
  private compactionOpen = false
  private compactionRevision?: number
  private compactionEnd?: CausalEnvelope

  constructor(
    private readonly ports: {
      binding(): SessionBinding
      causal(): CausalEnvelope
      probe?: ContextProbePort
      emit(event: SessionMetadataObservation): void
    },
  ) {}

  private bind(): void {
    if (this.disposed) return
    const binding = this.ports.binding()
    const causal = this.ports.causal()
    const nativeSessionId = binding.resume?.value
    const key = JSON.stringify([binding.bindingVersion, causal.observerGeneration, nativeSessionId])
    if (key === this.bindingKey) return
    const previous = this.latest?.context
    const rebound = this.bindingKey !== undefined
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.bindingKey = key
    this.compactionOpen = false
    this.compactionRevision = undefined
    this.compactionEnd = undefined
    const revision = {
      bindingVersion: binding.bindingVersion,
      observerGeneration: causal.observerGeneration,
      turnEpoch: causal.turnEpoch,
      contextRevision: (this.revision?.contextRevision ?? 0) + 1,
    }
    this.revision = revision
    this.strategy = undefined
    const declaration = contextStrategyFor(binding.harness, binding.driver)
    this.latest = {
      ...causal,
      context: declaration.supported
        ? rebound
          ? invalidateContextSummary(previous, 'binding-changed', revision)
          : {
              version: 1,
              status: 'pending',
              revision,
              reason: {
                code: 'waiting',
                message: 'Waiting for an attributable context measurement',
              },
            }
        : {
            version: 1,
            status: 'unsupported',
            reason: { code: 'no-channel', message: declaration.reason },
          },
    }
    if (rebound) this.emit(this.latest)
    if (!declaration.supported) return
    const lifetime = this.lifetime
    this.strategy = declaration.value.bind({
      harness: binding.harness,
      driver: binding.driver,
      nativeSessionId,
      revision,
      probe: this.ports.probe
        ? {
            request: (operation, options) =>
              boundedContextRead(options, lifetime.signal, (bounded) =>
                this.ports.probe!.request(operation, bounded),
              ),
          }
        : undefined,
      signal: lifetime.signal,
      publish: (observation) => {
        if (lifetime.signal.aborted || this.disposed) return
        this.accept(observation)
      },
    })
  }

  private emit(observation: ContextObservation): void {
    const { context, ...causal } = observation
    this.ports.emit({ ...causal, t: 'metadata', change: { kind: 'context-observation', context } })
  }

  private accept(input: ContextObservation): void {
    this.bind()
    if (this.disposed) return
    const parsed = ObservationSchema.safeParse(input)
    if (!parsed.success) return
    const observation = parsed.data
    const revision = this.revision
    if (!revision) return
    if (observation.observerGeneration !== revision.observerGeneration) return
    const context = observation.context
    const identity =
      context.status === 'available' || context.status === 'stale'
        ? context.sample
        : context.status === 'pending' || context.status === 'unavailable'
          ? context.revision
          : undefined
    if (identity) {
      if (
        identity.bindingVersion !== revision.bindingVersion ||
        identity.observerGeneration !== revision.observerGeneration ||
        identity.contextRevision < revision.contextRevision
      )
        return
      if (
        'nativeSessionId' in identity &&
        identity.nativeSessionId !== undefined &&
        identity.nativeSessionId !== this.ports.binding().resume?.value
      )
        return
    }
    const previous = this.latest
    if (
      previous &&
      previous.at === observation.at &&
      previous.observerGeneration === observation.observerGeneration &&
      JSON.stringify(previous.cursor) === JSON.stringify(observation.cursor) &&
      JSON.stringify(previous.context) === JSON.stringify(observation.context)
    )
      return
    const previousContext = previous?.context
    const previousSample =
      previousContext?.status === 'available' || previousContext?.status === 'stale'
        ? previousContext.sample
        : undefined
    const previousIdentity =
      previousSample ??
      (previousContext?.status === 'pending' || previousContext?.status === 'unavailable'
        ? previousContext.revision
        : undefined)
    const afterClear =
      (previousContext?.status === 'pending' || previousContext?.status === 'unavailable') &&
      previousContext.invalidation !== undefined &&
      previousContext.invalidation.cause !== 'binding-changed' &&
      previousContext.invalidation.cause !== 'resume'
    if (
      previous &&
      identity &&
      previousIdentity &&
      identity.contextRevision === previousIdentity.contextRevision &&
      (((previousSample !== undefined || afterClear) &&
        identity.turnEpoch < previousIdentity.turnEpoch) ||
        (afterClear && providerCursorRegressed(previous.cursor, observation.cursor)))
    )
      return
    if (
      (context.status === 'available' || context.status === 'stale') &&
      previousSample &&
      sameContextSample(previousSample, context.sample) &&
      context.status === previousContext?.status
    )
      return
    if (
      previous &&
      (previousContext?.status === 'available' || previousContext?.status === 'stale')
    ) {
      const priorIdentity = previousContext.sample
      if (
        (context.status === 'available' || context.status === 'stale') &&
        identity?.contextRevision === priorIdentity.contextRevision &&
        Date.parse(context.sample.at) < Date.parse(priorIdentity.at)
      )
        return
      if (priorIdentity && identity && identity.contextRevision < priorIdentity.contextRevision)
        return
      const recoveredSameSample =
        previousContext.status !== context.status &&
        (context.status === 'available' || context.status === 'stale') &&
        sameContextSample(previousContext.sample, context.sample)
      if (
        !recoveredSameSample &&
        (!identity ||
          !priorIdentity ||
          identity.contextRevision === priorIdentity.contextRevision) &&
        compareProviderCursor(previous.cursor, observation.cursor) !== 'after'
      )
        return
    }
    if (identity) this.revision = { ...revision, contextRevision: identity.contextRevision }
    this.latest = observation
    if (
      (context.status === 'pending' || context.status === 'unavailable') &&
      context.invalidation?.cause === 'compaction'
    )
      this.compactionRevision = context.revision.contextRevision
    this.emit(observation)
  }

  observe(payload: unknown, causal = this.ports.causal()): void {
    this.bind()
    if (this.disposed) return
    try {
      const observation = this.strategy?.observe(payload, causal)
      if (observation) this.accept(observation)
    } catch {
      // Context telemetry cannot interrupt the owning native protocol/turn.
      this.lost(causal)
    }
  }

  invalidate(cause: ContextInvalidationCause, causal = this.ports.causal()): void {
    this.bind()
    const strategy = this.strategy
    const revision = this.revision
    if (!strategy || !revision || this.disposed) return
    const observation = strategy.invalidate(cause, causal)
    // A faulty strategy cannot leave an old sample current at a known boundary.
    const identity =
      observation.context.status === 'pending' || observation.context.status === 'unavailable'
        ? observation.context.revision
        : undefined
    this.accept(
      identity && identity.contextRevision > revision.contextRevision
        ? observation
        : {
            ...causal,
            context: invalidateContextSummary(this.latest?.context, cause, {
              ...revision,
              ...causal,
              contextRevision: revision.contextRevision + 1,
            }),
          },
    )
  }

  event(event: RuntimeEvent): void {
    if (event.t === 'metadata' && event.change.kind === 'context-observation') return
    this.bind()
    if (this.disposed || event.observerGeneration !== this.revision?.observerGeneration) return
    if (event.t === 'transcript-reset' && event.provenance !== 'bootstrap')
      this.invalidate('reset', event)
    else if (event.t === 'state' && event.change.kind === 'compaction') {
      if (event.change.phase === 'start') {
        if (this.compactionOpen) return
        this.compactionOpen = true
        if (this.compactionRevision === undefined) this.invalidate('compaction', event)
      } else {
        if (
          this.compactionEnd &&
          JSON.stringify(this.compactionEnd.cursor) === JSON.stringify(event.cursor) &&
          this.compactionEnd.at === event.at
        )
          return
        this.compactionEnd = event
        const alreadyInvalidated = this.compactionOpen || this.compactionRevision !== undefined
        this.compactionOpen = false
        this.compactionRevision = undefined
        if (!alreadyInvalidated) this.invalidate('compaction', event)
      }
    } else if (event.t === 'state' && event.change.kind === 'observation_gap') this.lost(event)
    else if (event.t === 'process' && event.ev.ev === 'exited') {
      this.lost(event)
      this.dispose()
    }
  }

  lost(causal = this.ports.causal()): void {
    this.bind()
    const context = this.latest?.context
    if (context?.status !== 'available') return
    this.accept({
      ...causal,
      context: {
        ...context,
        status: 'stale',
        reason: {
          code: 'observation-lost',
          message: 'The native observation channel is disconnected',
        },
      },
    })
  }

  snapshot(): ContextObservation | undefined {
    this.bind()
    return this.latest
  }

  /** Bootstrap may ask an existing native transport for its cheap summary.
   * A missing transport declines; this never acquires a process or a fine watch. */
  async replay(): Promise<ContextObservation | undefined> {
    this.bind()
    if (
      this.strategy &&
      (this.latest?.context.status === 'pending' ||
        this.latest?.context.status === 'unavailable' ||
        this.latest?.context.status === 'stale')
    ) {
      await this.reader.summary({ timeoutMs: 1000 })
    }
    return this.latest
  }

  readonly reader: ContextReader = {
    summary: async (options) => {
      this.bind()
      if (options.signal?.aborted || this.disposed)
        return {
          status: 'cancelled',
          reason: { code: 'cancelled', message: 'Context session closed' },
        }
      const strategy = this.strategy
      if (!strategy && this.latest) return { status: 'observation', observation: this.latest }
      if (!strategy)
        return {
          status: 'refused',
          reason: { code: 'unbound', message: 'No context binding is available' },
        }
      try {
        const result = await boundedContextRead(options, this.lifetime.signal, (bounded) =>
          strategy.summary(bounded),
        )
        if (result.status === 'observation') this.accept(result.observation)
        return result.status === 'observation' && this.latest
          ? { status: 'observation', observation: this.latest }
          : result
      } catch {
        return {
          status: options.signal?.aborted || this.disposed ? 'cancelled' : 'refused',
          reason: {
            code: 'read-unavailable',
            message: 'Context read did not complete within this binding and deadline',
          },
        }
      }
    },
    detail: async (request) => {
      this.bind()
      const decline = (
        status: 'cancelled' | 'refused' | 'superseded' | 'unsupported',
        message: string,
      ) => ({
        version: 1 as const,
        sample: request.sample,
        status,
        reason: { code: status, message },
      })
      if (request.signal?.aborted || this.disposed)
        return decline('cancelled', 'Context detail read was cancelled')
      if (!DetailRequestSchema.safeParse(request).success)
        return decline('refused', 'Context detail read exceeds its request bounds')
      const strategy = this.strategy
      if (!strategy)
        return {
          version: 1,
          status: 'unsupported',
          sample: request.sample,
          reason: { code: 'no-channel', message: 'No context detail strategy is available' },
        }
      const declared = contextStrategyFor(this.ports.binding().harness, this.ports.binding().driver)
      if (!declared.supported || declared.value.capability.detail !== 'on-demand')
        return decline('unsupported', 'This binding does not support on-demand detail')
      const before = this.latest?.context
      if (before?.status !== 'available' || !sameContextSample(before.sample, request.sample))
        return decline('superseded', 'The requested context sample is no longer current')
      const revision = this.revision?.contextRevision
      try {
        const result = await boundedContextRead(request, this.lifetime.signal, (bounded) => {
          // Admission and native invocation share the same synchronous turn.
          // A new observation/rebind may have arrived at the bounded-read yield.
          this.bind()
          const current = this.latest?.context
          if (
            strategy !== this.strategy ||
            current?.status !== 'available' ||
            !sameContextSample(current.sample, request.sample) ||
            current.model?.modelId !== before.model?.modelId ||
            current.model?.providerId !== before.model?.providerId
          )
            return Promise.resolve(
              decline('superseded', 'The requested context sample changed before the read'),
            )
          return strategy.detail({ ...request, ...bounded })
        })
        this.bind()
        const current = this.latest?.context
        if (
          !request.signal?.aborted &&
          !this.disposed &&
          strategy === this.strategy &&
          revision === this.revision?.contextRevision &&
          current?.status === 'available' &&
          sameContextSample(current.sample, request.sample) &&
          current.model?.modelId === before.model?.modelId &&
          current.model?.providerId === before.model?.providerId
        ) {
          const admitted = admitContextReadResult(
            { ...request, intent: 'breakdown' },
            { intent: 'breakdown', result },
          )
          if (admitted.intent === 'breakdown') return admitted.result
        }
        return {
          version: 1,
          status: 'superseded',
          sample: request.sample,
          reason: { code: 'superseded', message: 'The requested context sample changed' },
        }
      } catch {
        return {
          version: 1,
          status: request.signal?.aborted || this.disposed ? 'cancelled' : 'unavailable',
          sample: request.sample,
          reason: {
            code: 'read-unavailable',
            message: 'Context detail did not complete within this binding and deadline',
          },
        }
      }
    },
  }

  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
  }
}
