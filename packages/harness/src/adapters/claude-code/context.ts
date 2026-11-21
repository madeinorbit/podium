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
  ContextReadOptions,
  ContextSessionStrategy,
  ContextStrategyInput,
  HarnessContextSection,
  HarnessContextStrategy,
} from '../../context-types.js'
import { canonicalDriverId, supported, unsupported } from '../../manifest.js'
import {
  claudeComposition,
  claudeContextVersion,
  claudeRequestAccounting,
  count,
  normalizeClaudeControl,
  normalizeClaudeStatus,
  object,
  text,
} from './context-native.js'

/** No default/omitted detail: that native path can make token-count API calls.
 * Summary already contains the measured semantic attribution we can expose on
 * demand without spending tokens or starting another conversation. */
const SUMMARY_OPERATION = { subtype: 'get_context_usage', detail: 'summary' } as const
const AUTOMATIC_TIMEOUT_MS = 2_000
const reason = (code: string, message: string) => ({ code, message })
const validTimeout = (value: number) => Number.isInteger(value) && value > 0 && value <= 60_000

/** Deadline/cancellation is enforced even for a port that fails to settle. */
export async function readClaudeContext<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: ContextReadOptions,
  lifetime?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const signals = [options.signal, lifetime].filter((signal): signal is AbortSignal => !!signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => controller.abort(new Error('cancelled'))
  for (const signal of signals) signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signals.some((signal) => signal.aborted)) cancel()
    if (controller.signal.aborted) throw controller.signal.reason
    return await new Promise<T>((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      })
      timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs)
      void Promise.resolve()
        .then(() => work(controller.signal))
        .then(resolve, reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
    for (const signal of signals) signal.removeEventListener('abort', cancel)
  }
}

type Mode = 'structured' | 'terminal' | 'headless'

function bindClaudeContext(input: ContextStrategyInput, mode: Mode): ContextSessionStrategy {
  let revision: ContextRevision = { ...input.revision }
  let nativeSessionId = input.nativeSessionId
  let causal: CausalEnvelope | undefined
  let current: ContextObservation | undefined
  let nativeReport: Record<string, unknown> | undefined
  let lastRequest: ContextLastRequest | undefined
  let observedModel: string | undefined
  let nativeSampleId: string | undefined
  let observedRequestAnchor: string | undefined
  let serial = 0
  let admission = 0
  let fingerprint: string | undefined
  let inFlight: Promise<ContextObservation | undefined> | undefined
  let reading: AbortController | undefined
  let queued = false
  let refreshAgain = false
  let afterCompaction = false
  let terminalUsageKey: string | undefined
  let blockedTerminalUsageKey: string | undefined
  let verifiedTerminalUsageKey: string | undefined
  let verifiedTerminalModel: string | undefined
  let boundaryAt: string | undefined
  const requestKey = (request: ContextLastRequest | undefined): string | undefined =>
    request?.input
      ? JSON.stringify([
          request.input.value,
          request.output?.value,
          request.cacheRead?.value,
          request.cacheWrite?.value,
        ])
      : undefined
  const modelCapacities = new Map<string, number>()

  const known = (): Pick<
    Extract<ContextSummary, { status: 'available' }>,
    'model' | 'effectiveCapacity' | 'modelCapacity' | 'compaction'
  > => {
    const value = current?.context
    return value && value.status !== 'unsupported'
      ? {
          ...('model' in value ? { model: value.model } : {}),
          ...('effectiveCapacity' in value ? { effectiveCapacity: value.effectiveCapacity } : {}),
          ...('modelCapacity' in value ? { modelCapacity: value.modelCapacity } : {}),
          ...('compaction' in value ? { compaction: value.compaction } : {}),
        }
      : {}
  }
  function unavailable(
    code: string,
    message: string,
    metadata = known(),
  ): ContextObservation | undefined {
    if (!causal) return undefined
    current = {
      ...causal,
      context: {
        version: 1,
        status: 'unavailable',
        revision: { ...revision },
        ...metadata,
        reason: reason(code, message),
      },
    }
    nativeReport = undefined
    lastRequest = undefined
    fingerprint = undefined
    return current
  }
  function invalidate(
    cause: ContextInvalidationCause,
    envelope: CausalEnvelope,
  ): ContextObservation {
    causal = envelope
    admission++
    reading?.abort()
    observedRequestAnchor = undefined
    afterCompaction = true
    blockedTerminalUsageKey = terminalUsageKey
    verifiedTerminalUsageKey = undefined
    verifiedTerminalModel = undefined
    boundaryAt = envelope.at
    nativeReport = undefined
    lastRequest = undefined
    fingerprint = undefined
    const metadata =
      cause === 'model-changed' || cause === 'binding-changed' || cause === 'resume' ? {} : known()
    revision = {
      ...revision,
      observerGeneration: envelope.observerGeneration,
      turnEpoch: envelope.turnEpoch,
      contextRevision: revision.contextRevision + 1,
    }
    current = {
      ...envelope,
      context: { ...invalidateContextSummary(current?.context, cause, revision), ...metadata },
    }
    return current
  }
  function sample(envelope: CausalEnvelope) {
    return {
      ...revision,
      id: `claude-context-${++serial}`,
      at: envelope.at,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(nativeSampleId ? { nativeSampleId } : {}),
    }
  }
  function acceptControl(raw: unknown, envelope: CausalEnvelope): ContextObservation | undefined {
    causal = envelope
    const value = object(raw)
    const decoded = normalizeClaudeControl(value, sample(envelope))
    if (!decoded)
      return unavailable(
        'malformed-native-context',
        'Claude returned no valid current context estimate',
      )
    const model = decoded.summary.model?.modelId
    if (observedModel && model && model !== observedModel) invalidate('model-changed', envelope)
    if (model) observedModel = model
    let snapshot: string
    try {
      snapshot = JSON.stringify({ ...value, gridRows: undefined })
    } catch {
      return unavailable(
        'malformed-native-context',
        'Claude context report is not a serializable native snapshot',
      )
    }
    const key = `${nativeSampleId ?? ''}:${snapshot}`
    if (key === fingerprint && current?.context.status === 'available') return current
    // A model boundary advances revision; build the admitted sample afterward.
    decoded.summary.sample = { ...decoded.summary.sample, ...revision }
    const capacity = model && modelCapacities.get(model)
    if (capacity)
      decoded.summary.modelCapacity = {
        value: capacity,
        accuracy: 'reported',
        basis: 'model-metadata',
        source: 'claude matching model contextWindow metadata',
      }
    nativeReport = JSON.parse(snapshot) as Record<string, unknown>
    // apiUsage can lag selection and exposes no per-request identity. Neither
    // the selected model nor a nearby stream header may relabel this ledger.
    lastRequest = decoded.lastRequest
    fingerprint = key
    current = { ...envelope, context: decoded.summary }
    return current
  }
  function refresh(timeoutMs = AUTOMATIC_TIMEOUT_MS): Promise<ContextObservation | undefined> {
    if (inFlight) return inFlight
    if (!causal || input.signal.aborted) return Promise.resolve(undefined)
    const probe = input.probe
    if (!probe)
      return Promise.resolve(
        unavailable(
          'no-native-control',
          'The existing Claude engine has no context control channel',
        ),
      )
    const envelope = causal
    const ticket = admission
    const capturedRevision = { ...revision }
    const capturedSession = nativeSessionId
    const controller = new AbortController()
    reading = controller
    inFlight = readClaudeContext(
      (signal) => probe.request(SUMMARY_OPERATION, { timeoutMs, signal }),
      { timeoutMs, signal: controller.signal },
      input.signal,
    )
      .then(
        (raw) => {
          if (
            ticket !== admission ||
            input.signal.aborted ||
            capturedSession !== nativeSessionId ||
            capturedRevision.bindingVersion !== revision.bindingVersion ||
            capturedRevision.observerGeneration !== revision.observerGeneration ||
            capturedRevision.turnEpoch !== revision.turnEpoch ||
            capturedRevision.contextRevision !== revision.contextRevision
          )
            return undefined
          return acceptControl(raw, envelope)
        },
        () => {
          if (ticket !== admission || input.signal.aborted) return undefined
          return unavailable(
            'native-context-unavailable',
            'Claude summary control was refused, malformed, or exceeded its bounded deadline',
          )
        },
      )
      .finally(() => {
        inFlight = undefined
        reading = undefined
        if (refreshAgain) {
          refreshAgain = false
          schedule()
        }
      })
    return inFlight
  }
  function schedule(): void {
    if (mode !== 'structured' || input.signal.aborted) return
    if (inFlight) {
      refreshAgain = true
      return
    }
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      void refresh().then((observation) => {
        if (observation && !input.signal.aborted) input.publish(observation)
      })
    })
  }
  const strategy: ContextSessionStrategy = {
    invalidate,
    observe(payload, envelope) {
      if (
        input.signal.aborted ||
        envelope.observerGeneration !== input.revision.observerGeneration ||
        envelope.turnEpoch < revision.turnEpoch
      )
        return undefined
      const outer = object(payload)
      const callback = outer?.type === 'control_request' ? object(outer.request) : undefined
      const raw = callback?.subtype === 'hook_callback' ? object(callback.input) : outer
      if (
        !raw ||
        raw.isSidechain === true ||
        raw.isMeta === true ||
        raw.parent_tool_use_id ||
        raw.agent_id
      )
        return undefined
      const id = text(raw.session_id) ?? text(raw.sessionId)
      if (id && nativeSessionId && id !== nativeSessionId) return undefined
      causal = envelope
      revision = { ...revision, turnEpoch: envelope.turnEpoch }
      if (!nativeSessionId && id) nativeSessionId = id
      const event = raw.hook_event_name ?? (raw.type === 'system' ? raw.subtype : undefined)
      if (
        event === 'PreCompact' ||
        event === 'compact_boundary' ||
        (event === 'SessionStart' && raw.source === 'compact')
      ) {
        return invalidate('compaction', envelope)
      }
      if (event === 'SessionStart' && (raw.source === 'resume' || raw.source === 'clear'))
        return invalidate(raw.source === 'resume' ? 'resume' : 'reset', envelope)
      if (event === 'PostCompact') {
        schedule()
        return undefined
      }
      const message = object(raw.message)
      if (raw.type === 'assistant' && message && raw.isApiErrorMessage !== true) {
        if (afterCompaction && envelope.provenance !== 'live') return undefined
        if (afterCompaction && boundaryAt && Date.parse(envelope.at) <= Date.parse(boundaryAt))
          return undefined
        const model = text(message.model)
        if (model?.startsWith('<')) return undefined
        const accounting = claudeRequestAccounting(message.usage)
        if (mode === 'headless') {
          const iterations = object(message.usage)?.iterations
          if (Array.isArray(iterations) && iterations.length)
            return unavailable(
              'unverified-request-iterations',
              'The native iteration ledger cannot establish one verified main request',
            )
          if (!accounting?.input)
            return unavailable(
              'no-main-request-usage',
              'The native assistant record omits inclusive main-request input',
            )
          if (observedModel && model && model !== observedModel)
            invalidate('model-changed', envelope)
          observedModel = model
          nativeSampleId = text(raw.uuid) ?? text(message.id)
          const key = JSON.stringify({
            nativeSampleId,
            model,
            usage: message.usage,
            store: !!text(raw.sessionId),
          })
          if (key === fingerprint && current?.context.status === 'available') return current
          lastRequest = {
            ...accounting,
            ...(model ? { model: { modelId: model } } : {}),
            ...(text(message.id) ? { requestId: text(message.id) } : {}),
          }
          // Stream headers precede final output usage. Completed Store
          // records retain that count; never borrow cumulative result totals.
          if (!text(raw.sessionId)) delete lastRequest.output
          nativeReport = undefined
          fingerprint = key
          afterCompaction = false
          current = {
            ...envelope,
            context: {
              version: 1,
              status: 'available',
              sample: sample(envelope),
              ...(model ? { model: { modelId: model } } : {}),
              occupancy: { basis: 'last-request', usedTokens: accounting.input },
            },
          }
          return current
        }
        if (accounting) {
          if (mode === 'terminal' && text(raw.sessionId)) {
            verifiedTerminalUsageKey = requestKey(accounting)
            verifiedTerminalModel = model
          } else if (mode !== 'terminal') afterCompaction = false
        }
        if (model && observedModel && model !== observedModel) {
          const clear = invalidate('model-changed', envelope)
          observedModel = model
          schedule()
          return clear
        }
        if (mode === 'structured' && accounting?.input) {
          const anchor = JSON.stringify([
            model,
            text(message.id) ?? text(raw.uuid),
            requestKey(accounting),
          ])
          if (anchor !== observedRequestAnchor) {
            observedRequestAnchor = anchor
            nativeSampleId = text(message.id) ?? text(raw.uuid)
            admission++
            reading?.abort()
            schedule()
          }
        }
      }
      if (mode === 'terminal' && 'context_window' in raw) {
        if (!claudeContextVersion(raw.version))
          return unavailable(
            'unsupported-status-version',
            'Claude status context fields are unverified before 2.1.319',
            {},
          )
        nativeSampleId = text(raw.prompt_id)
        const window = object(raw.context_window)
        const request = claudeRequestAccounting(window?.current_usage)
        const usageKey = requestKey(request)
        const model = text(object(raw.model)?.id)
        if (observedModel && model && observedModel !== model) invalidate('model-changed', envelope)
        observedModel = model
        const cap = count(window?.context_window_size)
        const metadata = {
          ...(model ? { model: { modelId: model } } : {}),
          ...(cap && cap > 0
            ? {
                effectiveCapacity: {
                  value: cap,
                  accuracy: 'reported' as const,
                  source: 'claude status context window',
                  basis: 'native' as const,
                },
              }
            : {}),
        }
        if (
          !request?.input ||
          (request.input.value === 0 && (request.output?.value ?? 0) === 0) ||
          (afterCompaction &&
            !(usageKey === verifiedTerminalUsageKey && model === verifiedTerminalModel) &&
            (!blockedTerminalUsageKey || usageKey === blockedTerminalUsageKey))
        )
          return unavailable(
            'no-main-response',
            'Waiting for valid main-response usage after startup or compaction',
            metadata,
          )
        const decoded = normalizeClaudeStatus(raw, sample(envelope))
        if (!decoded)
          return unavailable(
            'malformed-status-context',
            'Claude status line omitted valid current input accounting',
            metadata,
          )
        const key = JSON.stringify({ model, window, nativeSampleId })
        if (key === fingerprint && current?.context.status === 'available') return current
        fingerprint = key
        lastRequest = decoded.lastRequest
        nativeReport = undefined
        afterCompaction = false
        terminalUsageKey = usageKey
        current = { ...envelope, context: decoded.summary }
        return current
      }
      if (mode === 'structured') {
        if (raw.type === 'result') {
          const ledger = object(raw.modelUsage)
          for (const [model, entry] of Object.entries(ledger ?? {})) {
            const capacity = count(object(entry)?.contextWindow)
            if (capacity && capacity > 0) modelCapacities.set(model, capacity)
          }
          nativeSampleId = text(raw.uuid)
          admission++
          reading?.abort()
          schedule()
        } else if (
          event === 'init' ||
          (raw.type === 'control_response' &&
            text(object(object(raw.response)?.response)?.claude_code_version))
        )
          schedule()
      }
      return undefined
    },
    async summary(options) {
      if (options.signal?.aborted || input.signal.aborted)
        return {
          status: 'cancelled',
          reason: reason('cancelled', 'Claude context read was cancelled'),
        }
      if (!validTimeout(options.timeoutMs))
        return {
          status: 'refused',
          reason: reason('invalid-request', 'Context read requires a bounded positive timeout'),
        }
      if (mode === 'structured') {
        try {
          const observation = await readClaudeContext(
            () => refresh(options.timeoutMs),
            options,
            input.signal,
          )
          if (observation) return { status: 'observation', observation }
        } catch {
          return {
            status: options.signal?.aborted || input.signal.aborted ? 'cancelled' : 'refused',
            reason: reason(
              'read-interrupted',
              'Claude context read was cancelled or exceeded its deadline',
            ),
          }
        }
      }
      if (current) return { status: 'observation', observation: current }
      const observation = unavailable(
        mode === 'terminal' ? 'no-status-observation' : 'no-main-request-observation',
        mode === 'terminal'
          ? 'No validated launch-scoped status observation has arrived; instrumentation may be unavailable'
          : 'No primary assistant request usage is available in this constrained execution mode',
        {},
      )
      return observation
        ? { status: 'observation', observation }
        : {
            status: 'refused',
            reason: reason(
              'not-bound',
              'No native observation has established this context binding',
            ),
          }
    },
    async detail(request) {
      const decline = (
        status: 'cancelled' | 'refused' | 'superseded' | 'unavailable',
        message: string,
      ): ContextDetailResult => ({
        version: 1,
        status,
        sample: request.sample,
        reason: reason(status, message),
      })
      if (request.signal?.aborted || input.signal.aborted)
        return decline('cancelled', 'Claude context detail was cancelled')
      if (
        !validTimeout(request.timeoutMs) ||
        !Number.isInteger(request.maxRows) ||
        request.maxRows < 1 ||
        request.maxRows > CONTEXT_MAX_ROWS
      )
        return decline('refused', 'Context detail exceeds its request bounds')
      await Promise.resolve()
      if (request.signal?.aborted || input.signal.aborted)
        return decline('cancelled', 'Claude context detail was cancelled')
      const summary = current?.context
      if (summary?.status !== 'available' || !sameContextSample(summary.sample, request.sample))
        return decline('superseded', 'The requested Claude context sample is no longer current')
      const composition =
        nativeReport && summary.occupancy.usedTokens
          ? claudeComposition(nativeReport, summary.occupancy.usedTokens.value, request.maxRows)
          : undefined
      if (!lastRequest && !composition)
        return decline(
          'unavailable',
          'This native sample contains no supported request accounting or semantic attribution',
        )
      return {
        version: 1,
        status: 'available',
        sample: request.sample,
        ...(lastRequest ? { lastRequest } : {}),
        ...(composition ? { composition } : {}),
      }
    },
  }
  input.signal.addEventListener(
    'abort',
    () => {
      admission++
      reading?.abort()
      nativeReport = undefined
      lastRequest = undefined
    },
    { once: true },
  )
  return strategy
}

function strategy(mode: Mode): HarnessContextStrategy {
  return {
    capability: {
      summary: mode === 'structured' ? 'passive-and-explicit' : 'passive',
      detail: 'on-demand',
    },
    async probe(options, port) {
      if (!validTimeout(options.timeoutMs))
        return {
          status: 'unavailable',
          reason: reason('invalid-request', 'Context probe requires a bounded positive timeout'),
        }
      if (mode !== 'structured' || !port)
        return {
          status: 'unavailable',
          reason: reason(
            'awaiting-native-observation',
            mode === 'terminal'
              ? 'Terminal context requires an installed launch-only status bridge and validated status payload'
              : 'This mode requires primary native assistant request observations; model capacity is unverified',
          ),
        }
      try {
        const raw = await readClaudeContext(
          (signal) => port.request(SUMMARY_OPERATION, { ...options, signal }),
          options,
        )
        return count(object(raw)?.totalTokens) !== undefined
          ? { status: 'available' }
          : {
              status: 'unavailable',
              reason: reason(
                'malformed-native-context',
                'Claude summary control omitted a valid total estimate',
              ),
            }
      } catch {
        return {
          status: 'unavailable',
          reason: reason(
            'native-context-unavailable',
            'The existing Claude engine refused or did not answer a bounded summary probe',
          ),
        }
      }
    },
    bind: (input) => bindClaudeContext(input, mode),
  }
}

const structured = strategy('structured')
const terminal = strategy('terminal')
const headless = strategy('headless')
export const claudeContext: HarnessContextSection = {
  forDriver(driver) {
    switch (canonicalDriverId(driver)) {
      case 'claude-sdk':
        return supported(structured)
      case 'generic-pty':
        return supported(terminal)
      case 'headless':
        return supported(headless)
      default:
        return unsupported(
          'This Claude driver has no verified native context observation mechanism',
        )
    }
  },
}
