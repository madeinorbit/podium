import { createHash } from 'node:crypto'
import {
  CONTEXT_MAX_ROWS,
  type ContextCapacity,
  type ContextDetailResult,
  type ContextInvalidationCause,
  type ContextLastRequest,
  type ContextModelIdentity,
  type ContextRevision,
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
import { compareProviderCursor } from '../../observer.js'
import { CODEX_INVOCATION, CODEX_INVOCATION_SEGMENT } from './context-invocation.js'
import {
  type CodexContextSource,
  type CodexUsage,
  codexCapacity,
  codexContextVersion,
  codexRequestAccounting,
  count,
  decodeCodexUsage,
  nativeTime,
  object,
  text,
  zeroComponents,
} from './context-native.js'

type Turn = {
  id: string
  model?: ContextModelIdentity
  ordinary: boolean
  main: boolean
  compacting: boolean
  measured: boolean
}
type Measurement = {
  usage: CodexUsage
  window: unknown
  source: CodexContextSource
  causal: CausalEnvelope
  key: string
}
const boundedTimeout = (n: number) => Number.isInteger(n) && n > 0 && n <= 60_000

/** One state machine for native app-server frames and the existing Store's
 * bounded raw rollout tail. Exec stdout completion is cumulative accounting;
 * it is deliberately never an occupancy source. No probes, timers or turns. */
class CodexContext implements ContextSessionStrategy {
  private revision: ContextRevision
  private current?: ContextObservation
  private accounting?: ContextLastRequest
  private model?: ContextModelIdentity
  private capacity?: ContextCapacity
  private turn?: Turn
  private version?: string
  private rolloutVersion?: string
  private invocation?: { version: string; after: number }
  private fingerprint?: string
  private fenceAt = -1
  private lastNativeAt = -1
  private lastOrdinal = -1
  private lastCausal?: CausalEnvelope
  private compactEstimate?: Measurement
  private readonly retiredTurns = new Set<string>()

  constructor(private readonly input: ContextStrategyInput) {
    this.revision = { ...input.revision }
  }

  private known() {
    return {
      ...(this.model ? { model: this.model } : {}),
      ...(this.capacity ? { effectiveCapacity: this.capacity } : {}),
    }
  }

  private pending(causal: CausalEnvelope, code: string, message: string, unavailable = false) {
    this.accounting = undefined
    this.fingerprint = undefined
    this.current = {
      ...causal,
      context: {
        version: 1,
        status: unavailable ? 'unavailable' : 'pending',
        revision: { ...this.revision },
        ...this.known(),
        reason: { code, message },
      },
    }
    return this.current
  }

  private retire(id: string | undefined) {
    if (!id) return
    this.retiredTurns.add(id)
    if (this.retiredTurns.size > 32)
      this.retiredTurns.delete(this.retiredTurns.values().next().value ?? '')
  }

  invalidate(cause: ContextInvalidationCause, causal: CausalEnvelope): ContextObservation {
    this.retire(this.turn?.id)
    this.turn = undefined
    this.compactEstimate = undefined
    this.accounting = undefined
    this.fingerprint = undefined
    // Resume recovery may re-read an original Store timestamp. Other
    // boundaries require a new attributable native turn, not a replay at now.
    this.fenceAt = cause === 'resume' || cause === 'binding-changed' ? -1 : Date.parse(causal.at)
    if (
      cause === 'resume' ||
      cause === 'binding-changed' ||
      causal.observerGeneration !== this.revision.observerGeneration
    ) {
      this.lastCausal = undefined
      this.lastOrdinal = -1
      this.lastNativeAt = -1
    }
    if (cause === 'binding-changed' || cause === 'resume') {
      this.version = undefined
      this.rolloutVersion = undefined
      this.invocation = undefined
      this.model = undefined
      this.capacity = undefined
      this.retiredTurns.clear()
    }
    this.revision = {
      ...this.revision,
      observerGeneration: causal.observerGeneration,
      turnEpoch: causal.turnEpoch,
      contextRevision: this.revision.contextRevision + 1,
    }
    this.current = {
      ...causal,
      context: {
        ...invalidateContextSummary(this.current?.context, cause, this.revision),
        ...this.known(),
      },
    }
    return this.current
  }

  private select(
    model: ContextModelIdentity | undefined,
    causal: CausalEnvelope,
    explicitUnknown = false,
  ) {
    if (!model && !explicitUnknown) return
    if (
      this.model &&
      ((explicitUnknown && this.model.modelId !== undefined) ||
        (this.model.modelId !== undefined &&
          model?.modelId !== undefined &&
          this.model.modelId !== model.modelId) ||
        (this.model.providerId !== undefined &&
          model?.providerId !== undefined &&
          this.model.providerId !== model.providerId))
    ) {
      this.capacity = undefined
      this.invalidate('model-changed', causal)
    }
    this.model = model
    if (!this.current || this.current.context.status === 'pending')
      this.pending(causal, 'waiting', 'Waiting for an attributable Codex main-request measurement')
  }

  private start(
    id: string | undefined,
    causal: CausalEnvelope,
    ordinary: boolean,
    main = ordinary,
  ) {
    if (!id || this.retiredTurns.has(id)) return
    if (this.turn?.id === id) return
    this.retire(this.turn?.id)
    this.compactEstimate = undefined
    this.turn = { id, model: this.model, ordinary, main, compacting: false, measured: false }
    if (!this.current) this.pending(causal, 'waiting', 'Waiting for a completed Codex main request')
  }

  private setWindow(window: unknown, source: CodexContextSource, causal: CausalEnvelope) {
    const capacity = codexCapacity(window, source)
    const changed = this.capacity && capacity?.value !== this.capacity.value
    this.capacity = capacity
    if (changed) {
      // There is no shared window-changed cause. This is a change of the
      // model/window association, and invalidates that association together.
      const turn = this.turn
      this.invalidate('model-changed', causal)
      this.turn = turn
      if (turn) this.retiredTurns.delete(turn.id)
    }
  }

  private usage(
    last: unknown,
    total: unknown,
    window: unknown,
    includesReasoning: unknown,
    source: CodexContextSource,
    causal: CausalEnvelope,
  ) {
    // A creation header is historical provenance, not proof of the next
    // process's build. New live records need a fresh invocation witness.
    const version =
      source === 'app-server'
        ? this.version
        : causal.provenance === 'bootstrap'
          ? !this.invocation || this.invocation.version === this.rolloutVersion
            ? this.rolloutVersion
            : undefined
          : this.invocation && Date.parse(causal.at) >= this.invocation.after
            ? this.invocation.version
            : undefined
    if (!codexContextVersion(version)) {
      this.pending(
        causal,
        'unverified-native-version',
        'Codex context fields are verified only for native 0.169.0',
        true,
      )
      return
    }
    const usage = decodeCodexUsage(last, source)
    this.setWindow(window, source, causal)
    if (!usage || (window != null && !codexCapacity(window, source))) {
      this.pending(
        causal,
        'invalid-native-usage',
        'Codex omitted or malformed the latest usage or effective window',
        true,
      )
      return
    }
    const turn = this.turn
    if (!turn) {
      // Resume emits old usage with a new emittedAtMs and an OLD turn ID.
      // Only an existing Store lineage can recover its original sample time.
      this.pending(
        causal,
        'unattributed-usage',
        'Waiting for original Store lineage or a new native main request',
      )
      return
    }
    // Lifetime counters only distinguish repeated native response boundaries;
    // none participate in occupied-token or percentage calculations.
    const key = JSON.stringify([
      turn.id,
      turn.model,
      usage,
      decodeCodexUsage(total, source),
      window,
    ])
    const measurement: Measurement = { usage, source, window, causal, key }
    if (turn.compacting) {
      if (usage.total > 0 && zeroComponents(usage)) this.compactEstimate = measurement
      // Old re-emissions and helper traffic are never main-request accounting.
      return
    }
    if (!turn.ordinary) {
      this.pending(
        causal,
        'unattributed-usage',
        'The bounded rollout lacks a matching ordinary turn context',
      )
      return
    }
    if (source === 'rollout' && includesReasoning !== true) {
      this.pending(
        causal,
        'unverified-reasoning-inclusion',
        'The native reasoning-exclusion variant has no verified normalization',
        true,
      )
      return
    }
    const accounting = codexRequestAccounting(usage, source)
    if (!accounting) {
      this.pending(
        causal,
        'unverified-request-usage',
        'The native components do not establish verified inclusive main-request accounting',
        true,
      )
      return
    }
    this.render(measurement, accounting)
    turn.measured = true
  }

  private render(measurement: Measurement, accounting?: ContextLastRequest) {
    if (measurement.key === this.fingerprint && this.current?.context.status === 'available') return
    const { usage, source, causal } = measurement
    const capacity = codexCapacity(measurement.window, source)
    const estimate = (value: number) => ({
      value,
      accuracy: 'estimated' as const,
      source: `Codex ${source} ${accounting ? 'latest-request proxy' : 'post-compaction estimate'}`,
    })
    const percent = capacity ? (usage.total / capacity.value) * 100 : undefined
    this.accounting = accounting
      ? { ...accounting, ...(this.turn?.model ? { model: this.turn.model } : {}) }
      : undefined
    this.fingerprint = measurement.key
    this.current = {
      ...causal,
      context: {
        version: 1,
        status: 'available',
        sample: {
          ...this.revision,
          id: `codex-${createHash('sha256').update(measurement.key).digest('hex').slice(0, 32)}`,
          at: causal.at,
          nativeSessionId: this.input.nativeSessionId,
          nativeSampleId: this.turn?.id,
          turnRevision: this.turn?.id,
        },
        ...(this.turn?.model ? { model: this.turn.model } : {}),
        occupancy: {
          basis: accounting ? 'last-request' : 'native-estimate',
          usedTokens: estimate(usage.total),
          ...(percent !== undefined && Number.isFinite(percent) && capacity
            ? {
                percent: estimate(percent),
                remainingTokens: estimate(Math.max(0, capacity.value - usage.total)),
              }
            : {}),
        },
        ...(capacity ? { effectiveCapacity: capacity } : {}),
      },
    }
  }

  private compact(causal: CausalEnvelope) {
    if (this.turn?.compacting) return
    const turn = this.turn
    this.invalidate('compaction', causal)
    if (turn) {
      this.retiredTurns.delete(turn.id)
      this.turn = { ...turn, compacting: true, ordinary: false, measured: false }
    }
  }

  private finish(causal: CausalEnvelope) {
    if (this.turn?.compacting) {
      if (this.compactEstimate) this.render(this.compactEstimate)
    } else if (this.turn && !this.turn.measured)
      this.pending(
        causal,
        'no-request-usage',
        'The native turn completed without attributable latest-request usage',
      )
  }

  private app(raw: Record<string, unknown>, causal: CausalEnvelope) {
    const result = object(raw.result)
    const agent = text(result?.userAgent)
    if (agent) {
      this.version = agent.split(' ')[0]?.split('/')[1]
      return
    }
    const params = object(raw.params)
    const thread = object(result?.thread)
    if (result && thread?.id === this.input.nativeSessionId) {
      const modelId = text(result.model)
      const providerId = text(result.modelProvider)
      this.select(
        modelId
          ? { modelId, ...(providerId ? { providerId } : {}) }
          : providerId
            ? { providerId }
            : undefined,
        causal,
        'model' in result && !modelId,
      )
      return
    }
    if (!params || params.threadId !== this.input.nativeSessionId) return
    const id = text(params.turnId)
    const turn = object(params.turn)
    if (raw.method === 'thread/settings/updated') {
      const settings = object(params.threadSettings)
      const modelId = text(settings?.model)
      const providerId = text(settings?.modelProvider)
      this.select(
        modelId
          ? { modelId, ...(providerId ? { providerId } : {}) }
          : providerId
            ? { providerId }
            : undefined,
        causal,
        settings !== undefined && 'model' in settings && !modelId,
      )
    } else if (raw.method === 'turn/started') {
      const turnId = text(turn?.id)
      // A distinct root/parent identifies helper lineage, not the main request.
      const ordinary =
        !!turnId &&
        (turn?.rootTurnId == null || turn.rootTurnId === turnId) &&
        turn?.parentTurnId == null
      this.start(turnId, causal, ordinary)
    } else if (
      (raw.method === 'item/started' || raw.method === 'item/completed') &&
      object(params.item)?.type === 'contextCompaction'
    ) {
      if (id && id !== this.turn?.id) this.start(id, causal, false)
      this.compact(causal)
      if (raw.method === 'item/completed') this.finish(causal)
    } else if (raw.method === 'thread/tokenUsage/updated') {
      if (!id || id !== this.turn?.id) {
        if (id && this.retiredTurns.has(id)) return
        this.pending(
          causal,
          'unattributed-replay',
          'An old native turn replay cannot establish a new context sample',
        )
        return
      }
      const info = object(params.tokenUsage)
      if (info)
        this.usage(info.last, info.total, info.modelContextWindow, true, 'app-server', causal)
    } else if (raw.method === 'turn/completed' && turn?.id === this.turn?.id) this.finish(causal)
  }

  private rollout(raw: Record<string, unknown>, causal: CausalEnvelope) {
    const payload = object(raw.payload)
    if (!payload) return
    if (raw.type === 'session_meta') {
      if (
        payload.id !== this.input.nativeSessionId &&
        payload.session_id !== this.input.nativeSessionId
      )
        return
      this.rolloutVersion = text(payload.cli_version)
      const providerId = text(payload.model_provider)
      if (providerId) this.model = { providerId }
      return
    }
    if (raw.type === 'event_msg' && payload.type === 'task_started') {
      const attribution = object(payload.turn_attribution)
      const id = text(payload.turn_id)
      const main =
        attribution?.parent_turn_id == null &&
        (payload.root_turn_id == null || payload.root_turn_id === id)
      this.start(id, causal, false, main)
      if (payload.model_context_window !== undefined)
        this.setWindow(payload.model_context_window, 'rollout', causal)
    } else if (raw.type === 'turn_context') {
      const id = text(payload.turn_id)
      if (!id || this.retiredTurns.has(id)) return
      if (!this.turn) this.start(id, causal, false)
      if (id !== this.turn?.id) return
      const modelId = text(payload.model)
      const model = modelId
        ? { modelId, ...(this.model?.providerId ? { providerId: this.model.providerId } : {}) }
        : undefined
      const turn = this.turn
      this.select(model, causal, 'model' in payload && !modelId)
      // A new turn_context may itself prove an observed model switch.
      this.turn = { ...turn, model, ordinary: turn.main && !turn.compacting }
      this.retiredTurns.delete(turn.id)
    } else if (raw.type === 'compacted') this.compact(causal)
    else if (raw.type === 'event_msg' && payload.type === 'token_count') {
      // info:null is a rate-limit-only event, not a measured zero or a clear.
      const info = object(payload.info)
      if (info) {
        this.usage(
          info.last_token_usage,
          info.total_token_usage,
          info.model_context_window,
          info.last_usage_includes_reasoning,
          'rollout',
          causal,
        )
        // A persisted compacted record proves this estimate's lineage.
        if (this.compactEstimate) this.render(this.compactEstimate)
      }
    } else if (
      raw.type === 'event_msg' &&
      payload.type === 'task_complete' &&
      payload.turn_id === this.turn?.id
    )
      this.finish(causal)
  }

  observe(payload: unknown, causal: CausalEnvelope): ContextObservation | undefined {
    if (
      this.input.signal.aborted ||
      !this.input.nativeSessionId ||
      causal.observerGeneration !== this.revision.observerGeneration ||
      causal.turnEpoch < this.revision.turnEpoch
    )
      return undefined
    const raw = object(payload)
    if (!raw) return undefined
    if (raw.type === CODEX_INVOCATION) {
      const startedAt = nativeTime(raw.startedAt)
      const version = text(raw.version)
      if (
        this.input.driver !== 'codex-app-server' &&
        causal.provenance === 'live' &&
        causal.cursor.segmentId === CODEX_INVOCATION_SEGMENT &&
        raw.nativeSessionId === this.input.nativeSessionId &&
        version &&
        startedAt
      )
        this.invocation = { version, after: Date.parse(startedAt) }
      return undefined
    }
    const rollout =
      raw.type === 'session_meta' ||
      raw.type === 'turn_context' ||
      raw.type === 'event_msg' ||
      raw.type === 'compacted'
    const time = nativeTime(rollout ? raw.timestamp : raw.emittedAtMs)
    const at = time ?? causal.at
    const ordinal = rollout ? count(raw.ordinal) : undefined
    if (time && (Date.parse(at) < this.fenceAt || (rollout && Date.parse(at) < this.lastNativeAt)))
      return undefined
    if (rollout && ordinal !== undefined && ordinal <= this.lastOrdinal) return undefined
    if (
      this.lastCausal &&
      compareProviderCursor(this.lastCausal.cursor, causal.cursor) === 'same_or_before'
    )
      return undefined
    // Ignore exec's thread/turn completion ledger. The Store's raw rollout is
    // the one attributable latest-request source in process-per-turn mode.
    if (!rollout && !raw.method && !raw.result) return undefined
    const previous = this.current
    this.lastCausal = causal
    if (rollout && time) this.lastNativeAt = Date.parse(at)
    if (ordinal !== undefined) this.lastOrdinal = ordinal
    this.revision = { ...this.revision, turnEpoch: causal.turnEpoch }
    if (rollout) this.rollout(raw, { ...causal, at })
    else this.app(raw, { ...causal, at })
    return previous !== this.current ? this.current : undefined
  }

  async summary(options: Parameters<ContextSessionStrategy['summary']>[0]) {
    if (options.signal?.aborted || this.input.signal.aborted)
      return {
        status: 'cancelled' as const,
        reason: { code: 'cancelled', message: 'Codex context read cancelled' },
      }
    if (!boundedTimeout(options.timeoutMs))
      return {
        status: 'refused' as const,
        reason: {
          code: 'invalid-request',
          message: 'Context read requires a bounded positive timeout',
        },
      }
    return this.current
      ? { status: 'observation' as const, observation: this.current }
      : {
          status: 'refused' as const,
          reason: {
            code: 'waiting',
            message: 'No attributable Codex context observation has arrived',
          },
        }
  }

  async detail(
    request: Parameters<ContextSessionStrategy['detail']>[0],
  ): Promise<ContextDetailResult> {
    const decline = (
      status: 'cancelled' | 'refused' | 'superseded' | 'unavailable',
      message: string,
    ): ContextDetailResult => ({
      version: 1,
      sample: request.sample,
      status,
      reason: { code: status, message },
    })
    if (request.signal?.aborted || this.input.signal.aborted)
      return decline('cancelled', 'Codex context detail cancelled')
    if (
      !boundedTimeout(request.timeoutMs) ||
      !Number.isInteger(request.maxRows) ||
      request.maxRows < 1 ||
      request.maxRows > CONTEXT_MAX_ROWS
    )
      return decline('refused', 'Context detail exceeds its request bounds')
    const context = this.current?.context
    if (context?.status !== 'available' || !sameContextSample(context.sample, request.sample))
      return decline('superseded', 'The requested Codex context sample is no longer current')
    if (!this.accounting)
      return decline(
        'unavailable',
        'The native compaction estimate contains no main-request accounting or semantic attribution',
      )
    return { version: 1, sample: request.sample, status: 'available', lastRequest: this.accounting }
  }
}

const strategy: HarnessContextStrategy = {
  capability: { summary: 'passive', detail: 'on-demand' },
  probe: async (options) =>
    options.signal?.aborted
      ? {
          status: 'unavailable',
          reason: { code: 'cancelled', message: 'Codex context admission cancelled' },
        }
      : {
          status: 'unavailable',
          reason: {
            code: 'awaiting-native-version',
            message:
              'Requires native 0.169.0 and validated main-request or post-compaction telemetry',
          },
        },
  bind: (input) => new CodexContext(input),
}

export const codexContext: HarnessContextSection = {
  forDriver(driver) {
    return driver === 'codex-app-server' || driver === 'generic-pty' || driver === 'headless'
      ? { supported: true, value: strategy }
      : { supported: false, reason: 'This Codex driver has no verified context telemetry source' }
  },
}
