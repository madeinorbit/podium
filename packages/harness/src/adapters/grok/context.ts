import {
  CONTEXT_MAX_ROWS,
  type ContextDetailResult,
  type ContextInvalidationCause,
  type ContextLastRequest,
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
  grokContextModel,
  grokContextUpdate,
  grokContextVersion,
  grokRequestAccounting,
  grokSessionContextMetadata,
  grokStatusMetadata,
  initializeGrokContext,
  normalizeGrokStatus,
  object,
  text,
} from './context-native.js'

const reason = (code: string, message: string) => ({ code, message })
const validTimeout = (n: number) => Number.isInteger(n) && n > 0 && n <= 60_000
type Inference = {
  id: string
  model: string
  revision: number
  start: number
  completed?: number
  accounting?: ContextLastRequest
  published?: boolean
}

function bindGrokContext(input: ContextStrategyInput): ContextSessionStrategy {
  let revision: ContextRevision = { ...input.revision }
  let current: ContextObservation | undefined
  let model: string | undefined
  let selectedModel: string | undefined
  let inference: Inference | undefined
  let lastRequest: ContextLastRequest | undefined
  let lastNativeAt = -1
  let boundaryAt = -1
  let fingerprint: string | undefined
  let serial = 0
  // A binding alone cannot tell a fresh session from an unproven resume.
  let fenced = true

  function admitted(envelope: CausalEnvelope): boolean {
    return (
      !input.signal.aborted &&
      envelope.provenance === 'live' &&
      envelope.observerGeneration === revision.observerGeneration &&
      envelope.turnEpoch >= revision.turnEpoch
    )
  }
  function known(): Pick<
    Extract<ContextSummary, { status: 'available' }>,
    'model' | 'effectiveCapacity' | 'compaction'
  > {
    const value = current?.context
    return value && value.status !== 'unsupported'
      ? {
          model: value.model,
          effectiveCapacity: value.effectiveCapacity,
          compaction: value.compaction,
        }
      : {}
  }
  function clear(
    code: string,
    message: string,
    envelope: CausalEnvelope,
    status: 'pending' | 'unavailable' = 'unavailable',
    metadata = known(),
  ): ContextObservation {
    lastRequest = undefined
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
  function invalidate(
    cause: ContextInvalidationCause,
    envelope: CausalEnvelope,
  ): ContextObservation {
    if (!admitted(envelope)) {
      // Public invalidation is synchronous; an old caller may not advance this
      // binding. Its returned clear is never installed as the current reading.
      return {
        ...envelope,
        context: {
          version: 1,
          status: 'unavailable',
          revision: {
            ...revision,
            observerGeneration: envelope.observerGeneration,
            turnEpoch: envelope.turnEpoch,
          },
          reason: reason('obsolete-binding', 'Context boundary belongs to an obsolete binding'),
        },
      }
    }
    fenced = true
    boundaryAt = Math.max(lastNativeAt, Date.parse(envelope.at))
    inference = undefined
    lastRequest = undefined
    fingerprint = undefined
    const metadata =
      cause === 'model-changed' || cause === 'resume' || cause === 'binding-changed' ? {} : known()
    if (cause === 'resume' || cause === 'binding-changed') {
      model = undefined
      selectedModel = undefined
    }
    revision = {
      ...revision,
      turnEpoch: envelope.turnEpoch,
      contextRevision: revision.contextRevision + 1,
    }
    current = {
      ...envelope,
      context: { ...invalidateContextSummary(current?.context, cause, revision), ...metadata },
    }
    return current
  }
  function acceptModel(next: string | undefined, envelope: CausalEnvelope) {
    if (!next || next === model) return undefined
    const changed = model !== undefined
    model = next
    return changed ? invalidate('model-changed', envelope) : undefined
  }

  return {
    invalidate,
    observe(payload, causal) {
      if (!admitted(causal) || !input.nativeSessionId) return undefined
      const raw = object(payload)
      if (!raw) return undefined
      const result = object(raw.result)
      const meta = object(result?._meta)
      const sessionMetadata = result && grokSessionContextMetadata(result, input.nativeSessionId)
      if (sessionMetadata) {
        selectedModel = sessionMetadata.model.modelId
        const changed = acceptModel(selectedModel, causal)
        if (changed) return changed
        return fenced
          ? clear(
              'awaiting-fresh-inference',
              'Grok session configuration does not prove fresh occupancy',
              causal,
              'pending',
              sessionMetadata,
            )
          : undefined
      }
      if (
        meta?.sessionId === input.nativeSessionId &&
        inference?.completed !== undefined &&
        meta.promptId === inference.id &&
        inference.revision === revision.contextRevision &&
        meta.modelId === inference.model &&
        !fenced
      ) {
        // The result follows the idle status in the captured ACP ordering.
        // It can supply detail for that exact sample, never new occupancy.
        lastRequest = grokRequestAccounting(meta.usage, inference.id, inference.model)
        return undefined
      }
      const native = grokContextUpdate(raw)
      const update = native?.update
      const sessionId = text(native?.params.sessionId ?? raw.session_id ?? raw.sessionId)
      if (sessionId !== input.nativeSessionId || native?.meta?.isReplay === true) return undefined
      const nativeMs = count(native?.meta?.agentTimestampMs) ?? Date.parse(causal.at)
      if (!Number.isFinite(nativeMs) || nativeMs < lastNativeAt) return undefined
      const envelope = { ...causal, at: new Date(nativeMs).toISOString() }

      if (!update) return undefined
      const kind = update.sessionUpdate
      const status = kind === 'session_status'
      // usage_update is deliberately not admitted. Its type exists in ACP,
      // but neither measured build emitted it, live or persisted.
      if (kind === 'usage_update') return undefined
      if (status && text(update.session_id) !== input.nativeSessionId) return undefined
      if (status && (!grokContextVersion(update.version) || update.schema_version !== 1)) {
        lastNativeAt = nativeMs
        return clear(
          'unverified-native-status',
          'Grok context status requires measured build 1.0.70 or 1.0.89 and schema 1',
          envelope,
        )
      }
      lastNativeAt = nativeMs
      revision = { ...revision, turnEpoch: causal.turnEpoch }

      if (['auto_compact_completed', 'compaction_checkpoint'].includes(String(kind)))
        return invalidate('compaction', envelope)
      if (kind === 'model_changed' || kind === 'config_option_update') {
        selectedModel = grokContextModel(update) ?? selectedModel
        return acceptModel(selectedModel, envelope)
      }

      if (kind === 'turn_completed') {
        if (update.stop_reason !== 'end_turn') return undefined
        const calls = count(object(update.usage)?.modelCalls)
        if (calls === undefined || calls < 1) return undefined
        if (inference?.id !== text(update.prompt_id)) {
          // A lost/reordered start cannot attach new occupancy or accounting
          // to the preceding request. Only a later matched inference recovers.
          inference = undefined
          fenced = true
          boundaryAt = nativeMs
          return clear(
            'unmatched-inference',
            'Grok completed an inference without its matching native start',
            envelope,
            'pending',
          )
        }
        if (
          !inference ||
          inference.revision !== revision.contextRevision ||
          inference.model !== model ||
          nativeMs < inference.start
        )
          return undefined
        // A request started before a boundary is never fresh evidence, even if
        // its completion and the following status carry the new model/window.
        inference.completed = nativeMs
        inference.accounting = grokRequestAccounting(update.usage, inference.id, inference.model)
        return undefined
      }
      if (!status) return undefined
      if (selectedModel && grokContextModel(update) !== selectedModel) return undefined
      const changed = acceptModel(grokContextModel(update), envelope)
      if (changed) return changed
      const promptId = text(update.prompt_id)
      const start = count(object(update.turn)?.started_at_ms)
      if (promptId) {
        if (
          model &&
          start !== undefined &&
          start > boundaryAt &&
          start <= nativeMs &&
          (!inference || inference.id !== promptId)
        ) {
          inference = { id: promptId, model, revision: revision.contextRevision, start }
        }
        // Start statuses repeat the previous response anchor.
        return undefined
      }
      if (
        inference?.completed === undefined ||
        inference.revision !== revision.contextRevision ||
        inference.model !== grokContextModel(update) ||
        nativeMs < inference.completed
      ) {
        return fenced
          ? clear(
              'awaiting-fresh-inference',
              'Waiting for a matching post-boundary inference and native status',
              envelope,
              'pending',
              grokStatusMetadata(update),
            )
          : undefined
      }
      const sample = {
        ...revision,
        id: `grok-context-${++serial}`,
        at: envelope.at,
        nativeSessionId: input.nativeSessionId,
        turnRevision: inference.id,
      }
      const summary = normalizeGrokStatus(update, sample)
      if (!summary)
        return clear(
          'malformed-native-context',
          'Grok native status has no valid occupancy count or percentage',
          envelope,
        )
      const key = JSON.stringify([
        inference.id,
        revision.contextRevision,
        summary.model,
        summary.occupancy,
        summary.effectiveCapacity,
        summary.compaction,
      ])
      if (key === fingerprint) return undefined
      if (inference.published) return undefined
      fenced = false
      fingerprint = key
      inference.published = true
      lastRequest = inference.accounting
      current = { ...envelope, context: summary }
      return current
    },
    async summary(options) {
      if (input.signal.aborted || options.signal?.aborted)
        return {
          status: 'cancelled',
          reason: reason('cancelled', 'Grok context read was cancelled'),
        }
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
              'No matching Grok context observation has arrived',
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
        return decline('cancelled', 'Grok context detail was cancelled')
      if (
        !validTimeout(request.timeoutMs) ||
        !Number.isInteger(request.maxRows) ||
        request.maxRows < 1 ||
        request.maxRows > CONTEXT_MAX_ROWS
      )
        return decline('refused', 'Grok context detail exceeds request bounds')
      const summary = current?.context
      if (summary?.status !== 'available' || !sameContextSample(summary.sample, request.sample))
        return decline('superseded', 'The requested Grok context sample is no longer current')
      if (!lastRequest)
        return decline(
          'unsupported',
          'No verified single-request accounting or semantic composition is available',
        )
      return { version: 1, status: 'available', sample: request.sample, lastRequest }
    },
  }
}

function strategy(): HarnessContextStrategy {
  return {
    capability: { summary: 'passive', detail: 'on-demand' },
    initialize: initializeGrokContext,
    async probe(options) {
      if (options.signal?.aborted)
        return {
          status: 'unavailable',
          reason: reason('cancelled', 'Grok context admission was cancelled'),
        }
      return {
        status: 'unavailable',
        reason: reason(
          validTimeout(options.timeoutMs) ? 'awaiting-native-observation' : 'invalid-request',
          'Grok context admission requires a bound schema-1 status from measured build 1.0.70 or 1.0.89',
        ),
      }
    },
    bind: bindGrokContext,
  }
}
const acp = strategy()
export const grokContext: HarnessContextSection = {
  forDriver(driver) {
    switch (canonicalDriverId(driver)) {
      case 'grok-acp':
        return supported(acp)
      case 'generic-pty':
        return unsupported(
          'Grok terminal status requires shared config.toml; measured launch overlays ignore ui.status_line, so no isolated status bridge is available. Persisted signals lag inference',
        )
      case 'headless':
        return unsupported(
          'Grok --single has no verified fresh context channel; persisted signals lag inference and usage ledgers are turn accounting',
        )
      default:
        return unsupported('This Grok driver has no verified context observation mechanism')
    }
  },
}
