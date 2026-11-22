import {
  type ContextCapacity,
  type ContextInvalidationCause,
  type ContextLastRequest,
  type ContextRevision,
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
import { compareProviderCursor } from '../../observer.js'
import {
  effectiveCapacity,
  jsonRecord,
  milliseconds,
  modelIdentity,
  type NativeGeneration,
  type NativeScope,
  type NativeSelection,
  nativeScope,
  nativeSelection,
  record,
  requestUsage,
  sameModel,
  scopedPath,
  selectionKey,
} from './context-native.js'

const READ_MS = 1_500
const MAX_STARTS = 16
const HISTORY_RECORDS = 200
type MainStart = {
  id: string
  model: NativeSelection
  created: number
  selectionVersion: number
  admitted: boolean
}
type Measurement = MainStart & {
  at: string
  used: number
  lastRequest: ContextLastRequest
  causal: CausalEnvelope
}

/** A single engine/session/configuration association, never a model-limit
 * table. Store modes deliberately have no capacity subprocess or HTTP client.
 */
class OpenCodeContext implements ContextSessionStrategy {
  private revision: ContextRevision
  private current?: ContextObservation
  private selected?: NativeSelection
  private scope?: NativeScope
  private selectionTime = 0
  private selectionVersion = 0
  private capacity?: ContextCapacity
  private lookup?: { key: string; controller: AbortController }
  private attempted?: string
  private lastCausal?: CausalEnvelope
  private nativeSequence = -1
  private readonly starts = new Map<string, MainStart>()
  private readonly parents = new Set<string>()
  private measurement?: Measurement
  private newestCreated = 0
  private serial = 0
  private fence?: { at: number; previousId?: string }
  private lastCompaction = 0

  constructor(
    private readonly input: ContextStrategyInput,
    private readonly generation: NativeGeneration,
  ) {
    this.revision = { ...input.revision }
    input.signal.addEventListener('abort', () => this.lookup?.controller.abort(), { once: true })
  }

  private pending(causal: CausalEnvelope, code: string, message: string): ContextObservation {
    this.current = {
      ...causal,
      context: {
        version: 1,
        status: 'pending',
        revision: this.revision,
        reason: { code, message },
        ...(this.selected ? { model: modelIdentity(this.selected) } : {}),
        ...(this.capacity ? { effectiveCapacity: this.capacity } : {}),
      },
    }
    return this.current
  }

  invalidate(cause: ContextInvalidationCause, causal: CausalEnvelope): ContextObservation {
    if (causal.observerGeneration !== this.revision.observerGeneration) {
      this.lastCausal = undefined
      this.nativeSequence = -1
    }
    this.lookup?.controller.abort()
    this.lookup = undefined
    this.attempted = undefined
    this.capacity = undefined
    this.selectionVersion++
    this.fence = {
      at: Date.parse(causal.at),
      previousId: this.measurement?.id ?? this.fence?.previousId,
    }
    this.measurement = undefined
    this.starts.clear()
    this.parents.clear()
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
        ...(this.selected ? { model: modelIdentity(this.selected) } : {}),
      },
    }
    return this.current
  }

  private select(
    selected: NativeSelection | undefined,
    scope: NativeScope | undefined,
    at: number,
    causal: CausalEnvelope,
  ): void {
    if (at < this.selectionTime) return
    this.selectionTime = at
    const changed =
      (selected && this.selected && selectionKey(selected) !== selectionKey(this.selected)) ||
      (scope && this.scope && JSON.stringify(scope) !== JSON.stringify(this.scope))
    if (selected) this.selected = selected
    if (scope) this.scope = scope
    if (changed) this.invalidate('model-changed', causal)
    if (!this.current)
      this.pending(causal, 'waiting', 'Waiting for the first completed main-session request')
    this.scheduleCapacity(causal)
  }

  private session(raw: unknown, causal: CausalEnvelope): boolean {
    const row = record(raw)
    if (!row || row.id !== this.input.nativeSessionId) return false
    const preview = this.generation === 'preview'
    const model = nativeSelection.safeParse(jsonRecord(row.model))
    const scope = nativeScope(preview ? row.location : row, preview)
    const at = milliseconds(record(row.time)?.updated ?? row.timeUpdated) ?? Date.parse(causal.at)
    if (at >= this.selectionTime && row.model != null && !model.success) {
      this.selected = undefined
      this.invalidate('model-changed', causal)
      this.pending(
        causal,
        'invalid-model',
        'OpenCode did not provide a valid selected provider/model',
      )
      return true
    }
    this.select(model.success ? model.data : undefined, scope, at, causal)
    const compacting = milliseconds(row.timeCompacting)
    if (compacting) this.compaction(compacting, causal)
    // Session token columns are lifetime accounting. They never reach usage().
    return true
  }

  private start(
    raw: unknown,
    causal: CausalEnvelope,
    explicitStart = false,
  ): MainStart | undefined {
    const row = record(raw)
    if (!row || row.sessionID !== this.input.nativeSessionId || row.role !== 'assistant')
      return undefined
    const time = record(row.time)
    const created = milliseconds(time?.created)
    const model = nativeSelection.safeParse(
      row.model ?? { id: row.modelID, providerID: row.providerID },
    )
    if (typeof row.id !== 'string' || row.id.length === 0 || row.id.length > 256 || !created)
      return undefined
    if (row.summary === true || row.agent === 'compaction' || row.mode === 'compaction') {
      this.compaction(created, causal)
      return undefined
    }
    if (!model.success || row.error !== undefined) return undefined
    let measuredModelChange = false
    if (this.selected && !sameModel(this.selected, model.data)) {
      // A new main request can prove a switch even if its selection SSE was
      // missed. A late finish of a request started before the newer selection
      // cannot undo that selection or resurrect its old capacity association.
      if (created <= this.selectionTime || created < this.newestCreated) return undefined
      this.select(model.data, undefined, created, {
        ...causal,
        at: new Date(created).toISOString(),
      })
      measuredModelChange = true
    }
    const old = this.starts.get(row.id)
    if (old) return sameModel(old.model, model.data) && old.created === created ? old : undefined
    // An old completed row cannot cross a resume/compaction fence just because
    // it was read at a new time. Require a new native start or a post-boundary
    // user parent in the same owned Store/history lineage.
    const admitted =
      !this.fence ||
      (row.id !== this.fence.previousId &&
        created >= this.fence.at &&
        (explicitStart ||
          measuredModelChange ||
          time?.completed === undefined ||
          (typeof row.parentID === 'string' && this.parents.has(row.parentID))))
    const start = {
      id: row.id,
      model: model.data,
      created,
      selectionVersion: this.selectionVersion,
      admitted,
    }
    this.starts.set(start.id, start)
    if (this.starts.size > MAX_STARTS) this.starts.delete(this.starts.keys().next().value ?? '')
    return start
  }

  private sample(start: MainStart, tokens: unknown, at: number, causal: CausalEnvelope): void {
    if (
      !start.admitted ||
      start.selectionVersion !== this.selectionVersion ||
      start.created < this.newestCreated ||
      (this.selected && !sameModel(start.model, this.selected))
    )
      return
    this.newestCreated = start.created
    const usage = requestUsage(tokens, start.id, start.model)
    if (!usage) {
      this.measurement = undefined
      this.current = {
        ...causal,
        context: {
          version: 1,
          status: 'unavailable',
          revision: this.revision,
          reason: {
            code: 'invalid-usage',
            message: 'OpenCode request token fields are incomplete or invalid',
          },
          model: modelIdentity(start.model),
        },
      }
      return
    }
    if (
      this.measurement?.id === start.id &&
      JSON.stringify(this.measurement.lastRequest) === JSON.stringify(usage.lastRequest)
    )
      return
    this.measurement = { ...start, ...usage, at: new Date(at).toISOString(), causal }
    this.render()
    this.scheduleCapacity(causal)
  }

  private render(enrichment = false): void {
    const sample = this.measurement
    if (!sample) return
    if (enrichment) this.advanceRevision()
    const capacity =
      this.selected && sameModel(sample.model, this.selected) ? this.capacity : undefined
    const source = 'OpenCode latest request estimate'
    const estimated = (value: number) => ({ value, accuracy: 'estimated' as const, source })
    const ratio = capacity ? (sample.used / capacity.value) * 100 : undefined
    // Division can overflow for hostile but finite metadata. Keep count-only.
    const complete = capacity && ratio !== undefined && Number.isFinite(ratio)
    this.current = {
      ...sample.causal,
      at: sample.at,
      context: {
        version: 1,
        status: 'available',
        sample: {
          ...this.revision,
          id: `opencode-request-${++this.serial}`,
          nativeSessionId: this.input.nativeSessionId,
          nativeSampleId: sample.id,
          at: sample.at,
          observerGeneration: sample.causal.observerGeneration,
          turnEpoch: sample.causal.turnEpoch,
        },
        model: modelIdentity(sample.model),
        occupancy: {
          basis: 'last-request',
          usedTokens: estimated(sample.used),
          ...(complete
            ? {
                percent: estimated(ratio),
                remainingTokens: estimated(Math.max(0, capacity.value - sample.used)),
              }
            : {}),
        },
        ...(complete ? { effectiveCapacity: capacity } : {}),
      },
    }
  }

  private advanceRevision(): void {
    this.revision = { ...this.revision, contextRevision: this.revision.contextRevision + 1 }
  }

  private compaction(at: number, causal: CausalEnvelope): void {
    if (at <= this.lastCompaction || at < this.newestCreated) return
    this.lastCompaction = at
    this.invalidate('compaction', { ...causal, at: new Date(at).toISOString() })
  }

  private message(raw: unknown, causal: CausalEnvelope, parts?: unknown, lineage = false): void {
    const row = record(raw)
    if (!row || row.sessionID !== this.input.nativeSessionId) return
    const created = milliseconds(record(row.time)?.created)
    if (row.role === 'user' && typeof row.id === 'string' && created) {
      if (this.fence && created >= this.fence.at) {
        this.parents.add(row.id)
        if (this.parents.size > MAX_STARTS)
          this.parents.delete(this.parents.values().next().value ?? '')
      }
    }
    const nativeParts = Array.isArray(parts) ? parts : []
    if (row.type === 'compaction' || nativeParts.some((v) => record(v)?.type === 'compaction')) {
      if (created) this.compaction(created, causal)
      return
    }
    const start = this.start(row, causal, lineage)
    const completed = milliseconds(record(row.time)?.completed)
    if (start && completed) this.sample(start, row.tokens, completed, causal)
    else if (start) {
      // A Store snapshot can catch the finish part before message completion.
      const finish = nativeParts.filter((v) => record(v)?.type === 'step-finish').at(-1)
      if (finish) this.sample(start, record(finish)?.tokens, Date.parse(causal.at), causal)
    }
  }

  private store(payload: Record<string, unknown>, causal: CausalEnvelope): boolean {
    if (!Array.isArray(payload.rows) || !this.session(payload.session, causal)) return false
    // These are the already-read, bounded Store deltas, not a new query. Sort
    // by native creation so compaction and post-boundary parentage survive a
    // mutable part's late time_updated and transcript delivery ordering.
    const rows = payload.rows.map(record).filter((v) => v?.sessionId === this.input.nativeSessionId)
    rows.sort((a, b) => {
      const ta = milliseconds(record(jsonRecord(a?.messageData)?.time)?.created) ?? 0
      const tb = milliseconds(record(jsonRecord(b?.messageData)?.time)?.created) ?? 0
      return ta - tb
    })
    for (const row of rows) {
      const info = jsonRecord(row?.messageData)
      if (!info) continue
      const part = jsonRecord(row?.partData)
      this.message(
        { ...info, id: row?.messageId, sessionID: row?.sessionId },
        {
          ...causal,
          at: new Date(milliseconds(row?.timeUpdated) ?? Date.parse(causal.at)).toISOString(),
        },
        part ? [part] : [],
      )
    }
    return true
  }

  observe(payload: unknown, causal: CausalEnvelope): ContextObservation | undefined {
    if (
      this.input.signal.aborted ||
      !this.input.nativeSessionId ||
      causal.observerGeneration !== this.revision.observerGeneration ||
      causal.turnEpoch < this.revision.turnEpoch
    )
      return undefined
    const raw = record(payload)
    const preview = this.generation === 'preview'
    const data = record(preview ? raw?.data : raw?.properties)
    const info = record(data?.info)
    const belongs =
      data?.sessionID === this.input.nativeSessionId ||
      info?.id === this.input.nativeSessionId ||
      record(raw?.session)?.id === this.input.nativeSessionId ||
      raw?.id === this.input.nativeSessionId ||
      record(raw?.data)?.id === this.input.nativeSessionId ||
      (Array.isArray(payload) &&
        payload
          .slice(-HISTORY_RECORDS)
          .some((v) => record(record(v)?.info)?.sessionID === this.input.nativeSessionId))
    // Catalog settlement is engine-scoped and meaningful only for the current
    // bound lookup; no other session or arbitrary global event can select it.
    const catalog = raw?.type === 'catalog.updated' && this.selected !== undefined
    if (!belongs && !catalog) return undefined
    if (this.lastCausal && compareProviderCursor(this.lastCausal.cursor, causal.cursor) !== 'after')
      return undefined
    const durable = record(raw?.durable)
    const seq = durable?.seq
    if (preview && durable) {
      if (
        durable.aggregateID !== this.input.nativeSessionId ||
        typeof seq !== 'number' ||
        !Number.isInteger(seq) ||
        seq <= this.nativeSequence
      )
        return undefined
      this.nativeSequence = seq
    }
    this.lastCausal = causal
    this.revision = { ...this.revision, turnEpoch: causal.turnEpoch }
    const previous = this.current
    if (raw && this.store(raw, causal)) {
      // Store mode cannot acquire a limit, even if a caller accidentally gives
      // it a probe port. It reports exact-session request accounting only.
    } else if (Array.isArray(payload)) {
      let parent: { created: number; revision: number } | undefined
      for (const entry of payload.slice(-HISTORY_RECORDS)) {
        const row = record(entry)
        const info = record(row?.info)
        const created = milliseconds(record(info?.time)?.created)
        if (info?.sessionID !== this.input.nativeSessionId) continue
        if (info.role === 'user' && created && this.fence && created >= this.fence.at)
          parent = { created, revision: this.revision.contextRevision }
        this.message(
          info,
          causal,
          row?.parts,
          preview &&
            parent !== undefined &&
            created !== undefined &&
            parent.created <= created &&
            parent.revision === this.revision.contextRevision,
        )
      }
    } else if (this.session(raw, causal) || (preview && this.session(raw?.data, causal))) {
      // Raw create/get snapshot.
    } else if (catalog) {
      this.attempted = undefined
      this.capacity = undefined
      if (this.measurement) this.render(true)
      this.scheduleCapacity(causal)
    } else if (raw?.type === 'session.created' || raw?.type === 'session.updated') {
      this.session(preview ? { ...data, id: data?.sessionID } : info, causal)
    } else if (preview && raw?.type === 'session.model.selected') {
      const model = nativeSelection.safeParse(data?.model)
      if (model.success)
        this.select(
          model.data,
          undefined,
          milliseconds(raw.created) ?? Date.parse(causal.at),
          causal,
        )
    } else if (
      raw?.type === 'session.compacted' ||
      raw?.type === 'session.compaction.started' ||
      raw?.type === 'session.compaction.ended'
    ) {
      this.compaction(milliseconds(raw.created) ?? Date.parse(causal.at), causal)
    } else if (preview && raw?.type === 'session.step.started') {
      this.start(
        {
          ...data,
          role: 'assistant',
          id: data?.assistantMessageID,
          time: { created: raw.created },
        },
        causal,
        true,
      )
    } else if (preview && raw?.type === 'session.step.ended') {
      const start =
        typeof data?.assistantMessageID === 'string'
          ? this.starts.get(data.assistantMessageID)
          : undefined
      const at = milliseconds(raw.created)
      if (start && at) this.sample(start, data?.tokens, at, causal)
    } else if (raw?.type === 'message.updated') {
      this.message(info, causal)
    } else if (raw?.type === 'message.part.updated') {
      const part = record(data?.part)
      if (part?.type === 'compaction' && part.sessionID === this.input.nativeSessionId)
        this.compaction(milliseconds(data?.time) ?? Date.parse(causal.at), causal)
      else if (
        part?.type === 'step-finish' &&
        part.sessionID === this.input.nativeSessionId &&
        typeof part.messageID === 'string'
      ) {
        const start = this.starts.get(part.messageID)
        if (start)
          this.sample(start, part.tokens, milliseconds(data?.time) ?? Date.parse(causal.at), causal)
      }
    }
    return this.current !== previous ? this.current : undefined
  }

  private scheduleCapacity(causal: CausalEnvelope): void {
    if (this.generation === 'store' || !this.input.probe || this.input.signal.aborted) return
    const key = JSON.stringify([
      this.selectionVersion,
      this.selected && selectionKey(this.selected),
      this.scope,
      this.measurement?.id,
    ])
    if (this.capacity || this.attempted === key) return
    this.lookup?.controller.abort()
    const controller = new AbortController()
    this.lookup = { key, controller }
    this.attempted = key
    const signal = AbortSignal.any([
      controller.signal,
      this.input.signal,
      AbortSignal.timeout(READ_MS),
    ])
    const captured = this.revision.contextRevision
    const version = this.selectionVersion
    const probe = this.input.probe
    const current = () =>
      !signal.aborted &&
      captured === this.revision.contextRevision &&
      version === this.selectionVersion
    void (async () => {
      try {
        let selected = this.selected
        let scope = this.scope
        if (!selected || !scope) {
          const path = this.generation === 'preview' ? '/api/session/' : '/session/'
          const result = await boundedRead(
            () =>
              probe.request(`${path}${encodeURIComponent(this.input.nativeSessionId ?? '')}`, {
                timeoutMs: READ_MS,
                signal,
              }),
            signal,
          )
          if (!current()) return
          const row = record(this.generation === 'preview' ? record(result)?.data : result)
          if (!row || row.id !== this.input.nativeSessionId) return
          const selection = nativeSelection.safeParse(row.model)
          const location = nativeScope(
            this.generation === 'preview' ? row.location : row,
            this.generation === 'preview',
          )
          if (!selection.success || !location || (selected && !sameModel(selected, selection.data)))
            return
          selected = selection.data
          scope = location
        }
        const preview = this.generation === 'preview'
        const raw = await boundedRead(
          () =>
            probe.request(
              scopedPath(preview ? '/api/model' : '/config/providers', scope, preview),
              { timeoutMs: READ_MS, signal },
            ),
          signal,
        )
        if (!current()) return
        const config = preview
          ? await boundedRead(
              () =>
                probe.request(scopedPath('/api/config', scope, true), {
                  timeoutMs: READ_MS,
                  signal,
                }),
              signal,
            )
          : undefined
        if (!current() || (this.selected && selectionKey(this.selected) !== selectionKey(selected)))
          return
        this.selected = selected
        this.scope = scope
        this.capacity = effectiveCapacity(raw, selected, preview, scope, config)
        if (!this.capacity) return
        if (this.measurement && sameModel(this.measurement.model, selected)) this.render(true)
        else {
          this.advanceRevision()
          if (this.current?.context.status === 'unavailable')
            this.current = {
              ...this.current,
              context: {
                ...this.current.context,
                revision: this.revision,
                effectiveCapacity: this.capacity,
              },
            }
          else
            this.pending(
              causal,
              'waiting',
              'Waiting for a completed main-session request on the selected model',
            )
        }
        if (this.current) this.input.publish(this.current)
      } catch {
        // Counts/detail survive missing routes, metadata settlement, timeout,
        // invalid limits and unsupported provenance. A hover never retries IO.
      } finally {
        if (this.lookup?.controller === controller) this.lookup = undefined
      }
    })()
  }

  async summary(options: ContextReadOptions) {
    if (options.signal?.aborted || this.input.signal.aborted)
      return {
        status: 'cancelled' as const,
        reason: { code: 'cancelled', message: 'Context read cancelled' },
      }
    return this.current
      ? { status: 'observation' as const, observation: this.current }
      : {
          status: 'refused' as const,
          reason: {
            code: 'waiting',
            message:
              this.generation === 'store'
                ? 'Store context requires a verified explicitly resumed terminal launch and a completed main-session request'
                : 'No bound native context observation yet',
          },
        }
  }

  async detail(request: Parameters<ContextSessionStrategy['detail']>[0]) {
    const base = { version: 1 as const, sample: request.sample }
    if (request.signal?.aborted || this.input.signal.aborted)
      return {
        ...base,
        status: 'cancelled' as const,
        reason: { code: 'cancelled', message: 'Context detail cancelled' },
      }
    const context = this.current?.context
    if (
      !this.measurement ||
      context?.status !== 'available' ||
      !sameContextSample(context.sample, request.sample)
    )
      return {
        ...base,
        status: 'superseded' as const,
        reason: {
          code: 'superseded',
          message: 'The requested OpenCode context sample is no longer current',
        },
      }
    return { ...base, status: 'available' as const, lastRequest: this.measurement.lastRequest }
  }
}

/** Settle even when an obsolete/fake native port ignores its abort signal. */
async function boundedRead(read: () => Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('OpenCode context read cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([read(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function strategy(generation: NativeGeneration): HarnessContextStrategy {
  return {
    capability: { summary: 'passive', detail: 'on-demand' },
    probe: async (options) =>
      options.signal?.aborted
        ? {
            status: 'unavailable',
            reason: { code: 'cancelled', message: 'OpenCode context admission cancelled' },
          }
        : { status: 'available' },
    bind: (input) => new OpenCodeContext(input, generation),
  }
}

const strategies = {
  stable: strategy('stable'),
  preview: strategy('preview'),
  store: strategy('store'),
}

export const opencodeContext: HarnessContextSection = {
  forDriver(driver) {
    if (driver === 'headless')
      return {
        supported: false,
        reason: 'OpenCode headless context has no verified invocation-owned native source',
      }
    const generation =
      driver === 'opencode-server'
        ? 'stable'
        : driver === 'opencode2-server'
          ? 'preview'
          : driver === 'generic-pty'
            ? 'store'
            : undefined
    return generation
      ? { supported: true, value: strategies[generation] }
      : { supported: false, reason: 'OpenCode context observation is unavailable for this driver' }
  },
}
