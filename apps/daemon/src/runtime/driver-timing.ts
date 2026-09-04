/**
 * Comparable lifecycle timing for every Agent Runtime family.
 *
 * Each record has the logger's wall-clock `ts` for ordering and a monotonic
 * `durationMs` measured from the start of the operation named by `lane`.
 * Consumers should use the latter for deltas: wall clocks can jump and logs may
 * eventually be compared across machines.
 */

import type {
  AttachEndpoint,
  Refusal,
  RuntimeEvent,
  SessionBinding,
  TurnReceipt,
} from '@podium/agent-runtime'
import { driverFamilyForId } from '@podium/harness'
import { createLogger } from '@podium/logger'
import type { AgentKind, SessionId } from '@podium/model'

export const DRIVER_TIMING_NAMESPACE = 'daemon:agent-runtime-timing'
export const DRIVER_TIMING_MESSAGE = 'agent runtime timing stage'

const log = createLogger(DRIVER_TIMING_NAMESPACE)

export type DriverTimingStage =
  | 'session_requested'
  | 'driver_selected'
  | 'session_ready'
  | 'session_failed'
  | 'prompt_requested'
  | 'prompt_accepted'
  | 'prompt_queued'
  | 'prompt_unverified'
  | 'prompt_refused'
  | 'turn_started'
  | 'turn_first_response'
  | 'turn_completed'
  | 'turn_failed'
  | 'attach_requested'
  | 'attach_refused'
  | 'attach_endpoint_ready'
  | 'native_cli_spawn_requested'
  | 'native_cli_process_started'
  | 'native_cli_first_output'
  | 'native_cli_input_ready'

export interface DriverTimingRecord {
  stage: DriverTimingStage
  lane: 'launch' | 'turn' | 'attach'
  sessionId: SessionId
  harness: string
  driverId?: string
  family?: SessionBinding['family']
  runtimeMode?: 'headed' | 'headless'
  durationMs: number
  turnId?: string
  turnEpoch?: number
  attempt?: number
  [field: string]: unknown
}

interface PromptClock {
  turnId?: string
  startedAt: number
  source: 'runtime-send' | 'initial-prompt' | 'native-input'
  firstResponse: boolean
}

interface AttachClock {
  startedAt: number
  attempt: number
  firstOutput: boolean
}

interface SessionClock {
  requestedAt?: number
  harness: string
  requestedDriverId?: string
  binding?: SessionBinding
  pendingPrompts: PromptClock[]
  turns: Map<number, PromptClock>
  attach?: AttachClock
  attachAttempts: number
  headedProcessStarted?: boolean
  headedFirstOutput?: boolean
}

export interface DriverTimingRecorderOptions {
  now?: () => number
  write?: (record: DriverTimingRecord) => void
}

const roundedMs = (value: number): number => Math.round(value * 1_000) / 1_000
const runtimeMode = (
  family: SessionBinding['family'] | undefined,
): 'headed' | 'headless' | undefined =>
  family === 'terminal'
    ? 'headed'
    : family === 'server' || family === 'embedded'
      ? 'headless'
      : undefined

/** Stateful only so an event can be measured from the request that caused it. */
export class DriverTimingRecorder {
  readonly #now: () => number
  readonly #write: (record: DriverTimingRecord) => void
  readonly #sessions = new Map<SessionId, SessionClock>()

  constructor(options: DriverTimingRecorderOptions = {}) {
    this.#now = options.now ?? (() => performance.now())
    this.#write = options.write ?? ((record) => log.info(DRIVER_TIMING_MESSAGE, record))
  }

  #emit(
    sessionId: SessionId,
    stage: DriverTimingStage,
    lane: DriverTimingRecord['lane'],
    startedAt: number,
    fields: Record<string, unknown> = {},
  ): void {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    const family =
      session.binding?.family ??
      (session.requestedDriverId ? driverFamilyForId(session.requestedDriverId) : undefined)
    this.#write({
      stage,
      lane,
      sessionId,
      harness: session.binding?.harness ?? session.harness,
      ...(session.binding?.driver || session.requestedDriverId
        ? { driverId: session.binding?.driver ?? session.requestedDriverId }
        : {}),
      ...(family ? { family, runtimeMode: runtimeMode(family) } : {}),
      durationMs: roundedMs(Math.max(0, this.#now() - startedAt)),
      ...fields,
    })
  }

  #forBinding(binding: SessionBinding): SessionClock {
    let session = this.#sessions.get(binding.sessionId)
    if (!session) {
      session = {
        harness: binding.harness,
        binding,
        pendingPrompts: [],
        turns: new Map(),
        attachAttempts: 0,
      }
      this.#sessions.set(binding.sessionId, session)
    } else {
      session.binding = binding
      session.harness = binding.harness
    }
    return session
  }

  sessionRequested(input: {
    sessionId: SessionId
    harness: AgentKind
    requestedDriverId?: string
    initialPrompt?: boolean
  }): void {
    const at = this.#now()
    const pendingPrompts: PromptClock[] = input.initialPrompt
      ? [{ startedAt: at, source: 'initial-prompt', firstResponse: false }]
      : []
    this.#sessions.set(input.sessionId, {
      requestedAt: at,
      harness: input.harness,
      ...(input.requestedDriverId ? { requestedDriverId: input.requestedDriverId } : {}),
      pendingPrompts,
      turns: new Map(),
      attachAttempts: 0,
    })
    this.#emit(input.sessionId, 'session_requested', 'launch', at, {
      ...(input.initialPrompt ? { initialPrompt: true } : {}),
    })
    if (input.initialPrompt) {
      this.#emit(input.sessionId, 'prompt_requested', 'turn', at, {
        source: 'initial-prompt',
      })
    }
  }

  driverSelected(sessionId: SessionId, driverId: string): void {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    session.requestedDriverId = driverId
    this.#emit(sessionId, 'driver_selected', 'launch', session.requestedAt ?? this.#now())
    if (driverFamilyForId(driverId) === 'terminal') {
      this.#emit(
        sessionId,
        'native_cli_spawn_requested',
        'launch',
        session.requestedAt ?? this.#now(),
      )
    }
  }

  headedCliStage(
    sessionId: SessionId,
    harness: string,
    stage: 'native_cli_process_started' | 'native_cli_first_output',
    fields: Record<string, unknown> = {},
  ): void {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    session.harness = harness
    if (stage === 'native_cli_process_started') {
      if (session.headedProcessStarted) return
      session.headedProcessStarted = true
    } else {
      if (session.headedFirstOutput) return
      session.headedFirstOutput = true
    }
    this.#emit(sessionId, stage, 'launch', session.requestedAt ?? this.#now(), fields)
  }

  sessionReady(binding: SessionBinding): void {
    const session = this.#forBinding(binding)
    this.#emit(binding.sessionId, 'session_ready', 'launch', session.requestedAt ?? this.#now())
  }

  sessionFailed(sessionId: SessionId, detail: string): void {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    this.#emit(sessionId, 'session_failed', 'launch', session.requestedAt ?? this.#now(), {
      detail,
    })
  }

  promptRequested(binding: SessionBinding, turnId?: string): void {
    const session = this.#forBinding(binding)
    const startedAt = this.#now()
    session.pendingPrompts = session.pendingPrompts.filter(
      (prompt) => prompt.source !== 'native-input',
    )
    session.pendingPrompts.push({
      ...(turnId ? { turnId } : {}),
      startedAt,
      source: 'runtime-send',
      firstResponse: false,
    })
    this.#emit(binding.sessionId, 'prompt_requested', 'turn', startedAt, {
      source: 'runtime-send',
      ...(turnId ? { turnId } : {}),
    })
  }

  nativePromptSubmitted(sessionId: SessionId): void {
    const session = this.#sessions.get(sessionId)
    if (!session || session.binding?.family !== 'terminal') return
    const startedAt = this.#now()
    session.pendingPrompts = session.pendingPrompts.filter(
      (prompt) => prompt.source !== 'native-input',
    )
    session.pendingPrompts.push({
      startedAt,
      source: 'native-input',
      firstResponse: false,
    })
    this.#emit(sessionId, 'prompt_requested', 'turn', startedAt, { source: 'native-input' })
  }

  promptReceipt(binding: SessionBinding, turnId: string | undefined, receipt: TurnReceipt): void {
    const session = this.#forBinding(binding)
    let prompt = session.pendingPrompts.find((candidate) => candidate.turnId === turnId)
    if (!prompt && receipt.outcome === 'accepted') {
      prompt = [...session.turns.values()].find((candidate) => candidate.turnId === turnId)
    }
    if (!prompt) return
    const fields = {
      source: prompt.source,
      ...(turnId ? { turnId } : {}),
      ...(receipt.outcome === 'accepted' ? { turnEpoch: receipt.turnEpoch } : {}),
      outcome: receipt.outcome,
    }
    const stage =
      receipt.outcome === 'accepted'
        ? 'prompt_accepted'
        : receipt.outcome === 'queued'
          ? 'prompt_queued'
          : receipt.outcome === 'unverified'
            ? 'prompt_unverified'
            : 'prompt_refused'
    this.#emit(binding.sessionId, stage, 'turn', prompt.startedAt, fields)
    session.pendingPrompts = session.pendingPrompts.filter((candidate) => candidate !== prompt)
    if (receipt.outcome === 'accepted') session.turns.set(receipt.turnEpoch, prompt)
  }

  runtimeEvent(binding: SessionBinding, event: RuntimeEvent): void {
    if (event.provenance !== 'live') return
    const session = this.#forBinding(binding)
    let prompt = session.turns.get(event.turnEpoch)
    const claimPending = (): PromptClock | undefined => {
      const claimed = session.pendingPrompts.shift()
      if (claimed) session.turns.set(event.turnEpoch, claimed)
      return claimed
    }

    if (event.t === 'turn' && event.ev.ev === 'started') {
      prompt ??= claimPending()
      if (prompt) {
        this.#emit(binding.sessionId, 'turn_started', 'turn', prompt.startedAt, {
          source: prompt.source,
          ...(prompt.turnId ? { turnId: prompt.turnId } : {}),
          turnEpoch: event.turnEpoch,
          eventAt: event.at,
        })
      }
      return
    }

    if (event.t === 'item') {
      const response = event.item.kind === 'delta' || event.item.item.role === 'assistant'
      if (!response) return
      prompt ??= claimPending()
      if (!prompt || prompt.firstResponse) return
      prompt.firstResponse = true
      this.#emit(binding.sessionId, 'turn_first_response', 'turn', prompt.startedAt, {
        source: prompt.source,
        ...(prompt.turnId ? { turnId: prompt.turnId } : {}),
        turnEpoch: event.turnEpoch,
        responseKind: event.item.kind,
        eventAt: event.at,
      })
      return
    }

    if (event.t === 'turn' && (event.ev.ev === 'completed' || event.ev.ev === 'failed')) {
      prompt ??= claimPending()
      if (prompt) {
        this.#emit(
          binding.sessionId,
          event.ev.ev === 'completed' ? 'turn_completed' : 'turn_failed',
          'turn',
          prompt.startedAt,
          {
            source: prompt.source,
            ...(prompt.turnId ? { turnId: prompt.turnId } : {}),
            turnEpoch: event.turnEpoch,
            eventAt: event.at,
            ...(event.ev.ev === 'completed'
              ? { verdict: event.ev.verdict }
              : { reason: event.ev.reason }),
          },
        )
      }
      session.turns.delete(event.turnEpoch)
      return
    }

    if (event.t === 'process' && event.ev.ev === 'exited') this.#sessions.delete(binding.sessionId)
  }

  attachRequested(binding: SessionBinding): void {
    const session = this.#forBinding(binding)
    session.attachAttempts += 1
    session.attach = {
      startedAt: this.#now(),
      attempt: session.attachAttempts,
      firstOutput: false,
    }
    this.#emit(binding.sessionId, 'attach_requested', 'attach', session.attach.startedAt, {
      attempt: session.attach.attempt,
    })
  }

  attachResult(binding: SessionBinding, result: AttachEndpoint | Refusal): void {
    const session = this.#forBinding(binding)
    const attach = session.attach
    if (!attach) return
    const refused = 'reason' in result
    this.#emit(
      binding.sessionId,
      refused ? 'attach_refused' : 'attach_endpoint_ready',
      'attach',
      attach.startedAt,
      {
        attempt: attach.attempt,
        ...(refused
          ? { reason: result.reason, detail: result.detail }
          : { endpointKind: result.kind }),
      },
    )
  }

  nativeCliStage(
    sessionId: SessionId,
    harness: string,
    stage:
      | 'native_cli_spawn_requested'
      | 'native_cli_process_started'
      | 'native_cli_first_output'
      | 'native_cli_input_ready',
    fields: Record<string, unknown> = {},
  ): void {
    let session = this.#sessions.get(sessionId)
    if (!session) {
      session = { harness, pendingPrompts: [], turns: new Map(), attachAttempts: 0 }
      this.#sessions.set(sessionId, session)
    }
    const attach = session.attach
    if (!attach) return
    if (stage === 'native_cli_first_output') {
      if (attach.firstOutput) return
      attach.firstOutput = true
    }
    this.#emit(sessionId, stage, 'attach', attach.startedAt, {
      attempt: attach.attempt,
      ...fields,
    })
  }
}

export const driverTiming = new DriverTimingRecorder()
