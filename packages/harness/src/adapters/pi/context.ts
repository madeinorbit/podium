import {
  CONTEXT_MAX_ROWS,
  type ContextDetailResult,
  type ContextInvalidationCause,
  type ContextLastRequest,
  type ContextModelIdentity,
  type ContextRevision,
  type ContextSummary,
  invalidateContextSummary,
  sameContextSample,
} from '@podium/model'
import type { CausalEnvelope } from '@podium/protocol/daemon'
import type {
  ContextObservation,
  ContextSessionStrategy,
  ContextStrategyInput,
  HarnessContextSection,
  HarnessContextStrategy,
} from '../../context-types.js'
import { canonicalDriverId, supported, unsupported } from '../../manifest.js'
import {
  count,
  object,
  PI_CONTEXT_SCHEMA,
  piAssistant,
  piContextModel,
  piContextVersion,
  piRequestAccounting,
  quantity,
  samePiModel,
  text,
} from './context-native.js'

const reason = (code: string, message: string) => ({ code, message })
const validTimeout = (value: number) => Number.isInteger(value) && value > 0 && value <= 60_000

function bindPiContext(input: ContextStrategyInput): ContextSessionStrategy {
  let revision: ContextRevision = { ...input.revision }
  let current: ContextObservation | undefined
  let model: ContextModelIdentity | undefined
  let lastRequest: ContextLastRequest | undefined
  let runId: string | undefined
  const retiredRuns = new Set<string>()
  let sequence = 0
  let lastAt = -1
  // HTTP already in flight at rebind may arrive on the new callback lifetime.
  // Its request timestamp must not become a fresh witness for this binding.
  let boundaryAt = Date.now()
  let anchorId: string | undefined
  let compactionId: string | undefined
  let started: { timestamp: number; model: ContextModelIdentity; revision: number } | undefined
  let fenced = true
  let streamBound = false
  let fingerprint: string | undefined
  let serial = 0

  function admitted(causal: CausalEnvelope): boolean {
    return (
      !input.signal.aborted &&
      causal.provenance === 'live' &&
      causal.observerGeneration === revision.observerGeneration &&
      causal.turnEpoch >= revision.turnEpoch
    )
  }
  function known() {
    const summary = current?.context
    return summary && summary.status !== 'unsupported'
      ? { model: summary.model, effectiveCapacity: summary.effectiveCapacity }
      : {}
  }
  function clear(
    envelope: CausalEnvelope,
    code: string,
    message: string,
    status: 'pending' | 'unavailable' = 'pending',
    metadata = known(),
  ): ContextObservation {
    lastRequest = undefined
    fingerprint = undefined
    current = {
      ...envelope,
      context: {
        version: 1,
        status,
        revision: { ...revision },
        ...metadata,
        ...(current?.context.status === 'pending' && current.context.invalidation
          ? { invalidation: current.context.invalidation }
          : {}),
        reason: reason(code, message),
      },
    }
    return current
  }
  function invalidate(cause: ContextInvalidationCause, causal: CausalEnvelope): ContextObservation {
    if (!admitted(causal))
      return {
        ...causal,
        context: {
          version: 1,
          status: 'unavailable',
          revision: {
            ...revision,
            observerGeneration: causal.observerGeneration,
            turnEpoch: causal.turnEpoch,
          },
          reason: reason('obsolete-binding', 'Pi boundary belongs to an obsolete binding'),
        },
      }
    const metadata = ['model-changed', 'resume', 'binding-changed'].includes(cause) ? {} : known()
    fenced = true
    started = undefined
    anchorId = undefined
    lastRequest = undefined
    fingerprint = undefined
    if (cause === 'resume' || cause === 'binding-changed') {
      streamBound = false
      model = undefined
      compactionId = undefined
    }
    boundaryAt = Math.max(boundaryAt, lastAt, Date.parse(causal.at))
    revision = {
      ...revision,
      turnEpoch: causal.turnEpoch,
      contextRevision: revision.contextRevision + 1,
    }
    current = {
      ...causal,
      context: { ...invalidateContextSummary(current?.context, cause, revision), ...metadata },
    }
    return current
  }
  function start(message: Record<string, unknown> | undefined) {
    const timestamp = count(message?.timestamp)
    const identity = piContextModel(message)
    if (
      message?.role === 'assistant' &&
      timestamp !== undefined &&
      timestamp >= boundaryAt &&
      identity
    )
      started = { timestamp, model: identity, revision: revision.contextRevision }
  }
  function publish(
    envelope: CausalEnvelope,
    summary: Omit<Extract<ContextSummary, { status: 'available' }>, 'sample'>,
    nativeSampleId?: string,
  ): ContextObservation | undefined {
    const key = JSON.stringify([revision, summary, nativeSampleId])
    if (key === fingerprint) return undefined
    fingerprint = key
    current = {
      ...envelope,
      context: {
        ...summary,
        sample: {
          ...revision,
          id: `pi-context-${++serial}`,
          at: envelope.at,
          nativeSessionId: input.nativeSessionId,
          nativeSampleId,
        },
      },
    }
    return current
  }

  return {
    invalidate,
    observe(payload, causal) {
      if (!admitted(causal) || !input.nativeSessionId) return undefined
      const raw = object(payload)
      if (!raw) return undefined
      if (raw.schema !== PI_CONTEXT_SCHEMA) {
        // A constrained print invocation has request accounting, no extension
        // API window or trailing-message estimate. Bind its exact header first.
        if (canonicalDriverId(input.driver) !== 'headless' || runId) return undefined
        if (raw.type === 'session') {
          if (raw.id !== input.nativeSessionId) return undefined
          if (streamBound) return undefined
          const observation = invalidate('resume', causal)
          streamBound = true
          return observation
        }
        if (!streamBound) return undefined
        revision = { ...revision, turnEpoch: causal.turnEpoch }
        if (
          ['compaction', 'auto_compaction_start', 'auto_compaction_end'].includes(String(raw.type))
        )
          return invalidate('compaction', causal)
        if (raw.type === 'model_change') return invalidate('model-changed', causal)
        const message = object(raw.message)
        if (raw.type === 'message_start') {
          start(message)
          return undefined
        }
        if (raw.type !== 'message_end' || !piAssistant(message)) return undefined
        const accounting = piRequestAccounting(message)
        if (
          !started ||
          started.revision !== revision.contextRevision ||
          started.timestamp !== message?.timestamp ||
          !samePiModel(started.model, piContextModel(message))
        )
          return clear(
            causal,
            'unmatched-response',
            'Waiting for a matching live Pi assistant response',
          )
        if (!accounting?.input || !accounting.output)
          return clear(
            causal,
            'partial-request-accounting',
            'Pi stream lacks complete request input/output accounting',
            'unavailable',
          )
        model = started.model
        lastRequest = accounting
        fenced = false
        const used = count(accounting.input.value + accounting.output.value)
        if (used === undefined)
          return clear(
            causal,
            'malformed-request-accounting',
            'Pi request accounting exceeds finite bounds',
            'unavailable',
          )
        return publish(
          causal,
          {
            version: 1,
            status: 'available',
            model,
            occupancy: {
              basis: 'last-request',
              usedTokens: quantity(
                used,
                'pi live assistant request input + output; active window and trailing context unavailable',
                'estimated',
              ),
            },
          },
          text(message?.responseId) ?? String(started.timestamp),
        )
      }
      if (raw.sessionId !== input.nativeSessionId) return undefined
      if (!piContextVersion(raw.piVersion))
        return clear(
          causal,
          'unverified-native-version',
          'Pi context API is verified only on Pi 1.5.0',
          'unavailable',
          {},
        )
      const nextRun = text(raw.runId)
      const nextSequence = count(raw.sequence)
      const nativeAt = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN
      if (
        !nextRun ||
        !Number.isSafeInteger(nextSequence) ||
        (nextSequence ?? 0) < 1 ||
        !Number.isFinite(nativeAt) ||
        nativeAt < lastAt ||
        nativeAt < boundaryAt ||
        retiredRuns.has(nextRun)
      )
        return undefined
      let inferredResume: number | undefined
      if (nextRun !== runId) {
        if (raw.event !== 'session_start') {
          // Binding can finish after session_start. A live assistant start
          // can identify that run, but an idle historical snapshot cannot.
          const message = object(raw.message)
          const timestamp = count(message?.timestamp)
          if (
            raw.event !== 'message_start' ||
            message?.role !== 'assistant' ||
            timestamp === undefined ||
            timestamp < Math.max(lastAt, boundaryAt) ||
            timestamp > nativeAt ||
            !samePiModel(piContextModel(message), piContextModel(raw.model))
          )
            return undefined
          inferredResume = timestamp
        }
        if (runId) retiredRuns.add(runId)
        if (retiredRuns.size > 64) retiredRuns.delete(retiredRuns.values().next().value as string)
        runId = nextRun
        sequence = 0
      }
      if ((nextSequence as number) <= sequence) return undefined
      sequence = nextSequence as number
      const envelope = { ...causal, at: new Date(nativeAt).toISOString() }
      revision = { ...revision, turnEpoch: causal.turnEpoch }
      if (inferredResume !== undefined)
        invalidate('resume', { ...envelope, at: new Date(inferredResume).toISOString() })
      lastAt = nativeAt
      const identity = piContextModel(raw.model)
      const usage = object(raw.contextUsage)
      const window = count(usage?.contextWindow)
      const metadata = {
        model: identity,
        ...(window !== undefined && window > 0
          ? {
              effectiveCapacity: {
                ...quantity(window, 'pi getContextUsage().contextWindow'),
                basis: 'native' as const,
              },
            }
          : {}),
      }
      const event = raw.event
      let boundary: ContextInvalidationCause | undefined
      if (event === 'session_start')
        boundary = raw.reason === 'fork' ? 'fork' : raw.reason === 'new' ? 'reset' : 'resume'
      else if (
        event === 'session_shutdown' &&
        ['fork', 'new', 'resume', 'reload'].includes(String(raw.reason))
      )
        boundary = raw.reason === 'fork' ? 'fork' : raw.reason === 'new' ? 'reset' : 'resume'
      else if (event === 'session_before_fork') boundary = 'fork'
      else if (event === 'session_before_switch') boundary = 'resume'
      else if (event === 'session_before_tree' || event === 'session_tree') boundary = 'rewind'
      else if (event === 'session_before_compact' || event === 'session_compact')
        boundary = 'compaction'
      else if (
        identity &&
        (model ?? known().model) &&
        !samePiModel(identity, model ?? known().model)
      )
        boundary = 'model-changed'
      else if (
        window !== undefined &&
        window > 0 &&
        known().effectiveCapacity &&
        window !== known().effectiveCapacity?.value
      )
        boundary = 'model-changed'
      const nextCompaction = text(raw.compactionId)
      if (
        nextCompaction &&
        compactionId !== nextCompaction &&
        event !== 'session_start' &&
        inferredResume === undefined
      )
        boundary ??= 'compaction'
      compactionId = nextCompaction
      model = identity
      if (boundary) {
        invalidate(boundary, envelope)
        return clear(
          envelope,
          boundary,
          'Waiting for a fresh Pi response after a context boundary',
          'pending',
          metadata,
        )
      }
      if (event === 'message_start') start(object(raw.message))
      if (event === 'session_shutdown') return undefined // Retain the last idle sample.
      if (!identity || !usage || window === undefined || window <= 0) {
        fenced = true
        started = undefined
        anchorId = undefined
        return clear(
          envelope,
          'native-context-unavailable',
          'Pi has no valid active model/context window',
          'unavailable',
          metadata,
        )
      }
      const tokens = count(usage.tokens)
      const percent = count(usage.percent)
      if (usage.tokens === null && usage.percent === null) {
        if (!fenced) invalidate('compaction', envelope)
        return clear(
          envelope,
          'awaiting-post-compaction-response',
          'Pi context usage is unknown until a trustworthy new response',
          'pending',
          metadata,
        )
      }
      if (tokens === undefined || percent === undefined)
        return clear(
          envelope,
          'malformed-native-context',
          'Pi context estimate has invalid or missing counts',
          'unavailable',
          metadata,
        )
      const anchor = piAssistant(raw.anchor)
      const nextAnchor = text(anchor?.id)
      if (!anchor || !nextAnchor || !samePiModel(identity, piContextModel(anchor)))
        return clear(
          envelope,
          'awaiting-compatible-response',
          'Pi native estimate has no compatible assistant witness',
          'pending',
          metadata,
        )
      if (fenced || anchorId !== nextAnchor) {
        if (
          !started ||
          started.revision !== revision.contextRevision ||
          started.timestamp !== anchor.timestamp ||
          !samePiModel(started.model, identity)
        )
          return clear(
            envelope,
            'awaiting-fresh-response',
            'Pi has not committed a matching response in this binding',
            'pending',
            metadata,
          )
        // message_end is pre-persistence in 1.5.0. A later event must actually
        // see the new committed branch anchor before it becomes eligible.
        fenced = false
        anchorId = nextAnchor
      }
      lastRequest = piRequestAccounting(anchor)
      return publish(
        envelope,
        {
          version: 1,
          status: 'available',
          ...metadata,
          occupancy: {
            basis: 'native-estimate',
            usedTokens: quantity(tokens, 'pi getContextUsage().tokens', 'estimated'),
            percent: quantity(percent, 'pi getContextUsage().percent', 'estimated'),
            remainingTokens: quantity(
              Math.max(0, window - tokens),
              'pi context window minus native estimate',
              'estimated',
            ),
          },
        },
        text(raw.leafId) ?? nextAnchor,
      )
    },
    async summary(options) {
      if (input.signal.aborted || options.signal?.aborted)
        return { status: 'cancelled', reason: reason('cancelled', 'Pi context read was cancelled') }
      if (!validTimeout(options.timeoutMs))
        return {
          status: 'refused',
          reason: reason('invalid-request', 'Context read requires a bounded positive timeout'),
        }
      return current
        ? { status: 'observation', observation: current }
        : {
            status: 'refused',
            reason: reason(
              'awaiting-native-observation',
              'No live Pi context observation has arrived',
            ),
          }
    },
    async detail(request): Promise<ContextDetailResult> {
      const decline = (
        status: 'cancelled' | 'refused' | 'superseded' | 'unsupported',
        message: string,
      ): ContextDetailResult => ({
        version: 1,
        status,
        sample: request.sample,
        reason: reason(status, message),
      })
      if (input.signal.aborted || request.signal?.aborted)
        return decline('cancelled', 'Pi context detail was cancelled')
      if (
        !validTimeout(request.timeoutMs) ||
        !Number.isInteger(request.maxRows) ||
        request.maxRows < 1 ||
        request.maxRows > CONTEXT_MAX_ROWS
      )
        return decline('refused', 'Pi context detail exceeds request bounds')
      const summary = current?.context
      if (summary?.status !== 'available' || !sameContextSample(summary.sample, request.sample))
        return decline('superseded', 'The requested Pi sample is no longer current')
      if (!lastRequest)
        return decline(
          'unsupported',
          'Pi has no request accounting or semantic composition for this sample',
        )
      return { version: 1, status: 'available', sample: request.sample, lastRequest }
    },
  }
}

const strategy: HarnessContextStrategy = {
  capability: { summary: 'passive', detail: 'on-demand' },
  async probe(options) {
    return {
      status: 'unavailable',
      reason: reason(
        options.signal?.aborted
          ? 'cancelled'
          : validTimeout(options.timeoutMs)
            ? 'awaiting-native-observation'
            : 'invalid-request',
        'Pi context requires a bound 1.5.0 session extension; restricted print streams provide request accounting only',
      ),
    }
  },
  bind: bindPiContext,
}
export const piContext: HarnessContextSection = {
  forDriver(driver) {
    return ['generic-pty', 'headless'].includes(canonicalDriverId(driver))
      ? supported(strategy)
      : unsupported(
          'Pi has no admitted context mechanism on this driver; RPC/server remains unimplemented',
        )
  },
}
