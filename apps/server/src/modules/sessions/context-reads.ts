import { type MachineId, type SessionId, sameContextSample } from '@podium/model'
import {
  admitContextReadResult,
  type ContextObservation,
  type ContextReadResult,
  contextReadFailure,
  SessionContextReadInput as Input,
  type SessionContextReadInput,
} from '@podium/protocol/daemon'

interface BoundContextSession {
  machineId: MachineId
  driverId?: string | undefined
  status: string
  contextObservation?: ContextObservation | undefined
}
interface Flight {
  sessionId: SessionId
  intent: SessionContextReadInput['read']['intent']
  abort: AbortController
  waiters: number
  result: Promise<ContextReadResult>
}

/** Transport work only, scoped to one workspace lifecycle. No completed-answer
 * cache and no copied session facts: every admission reads the live session.
 * The first observer's bounds govern shared native work; a smaller observer
 * has its own deadline and validates the answer against its own row budget. */
export class SessionContextReads {
  private readonly flights = new Map<string, Flight>()
  private disposed = false
  constructor(
    private readonly ports: {
      session(id: SessionId): BoundContextSession | undefined
      connected(id: MachineId): boolean
      supported(id: MachineId): boolean
      read(
        input: SessionContextReadInput,
        machineId: MachineId,
        signal: AbortSignal,
      ): Promise<ContextReadResult>
    },
  ) {}

  async read(input: SessionContextReadInput, signal?: AbortSignal): Promise<ContextReadResult> {
    const fail = (
      status: Parameters<typeof contextReadFailure>[1],
      code: string,
      message: string,
    ) => contextReadFailure(input.read, status, code, message)
    if (signal?.aborted || this.disposed)
      return fail('cancelled', 'cancelled', 'Context read cancelled')
    const parsed = Input.safeParse(input)
    if (!parsed.success)
      return fail('refused', 'request-bounds', 'Context read exceeds its request bounds')
    input = parsed.data
    const session = this.ports.session(input.sessionId)
    if (!session?.driverId || session.status !== 'live')
      return fail('unavailable', 'not-running', 'No live context session is bound')
    const machineId = session.machineId
    const driverId = session.driverId
    if (!this.ports.connected(machineId))
      return fail('unavailable', 'disconnected', 'The session daemon is disconnected')
    if (!this.ports.supported(machineId))
      return fail(
        'unsupported',
        'unsupported-peer',
        'The session daemon does not support context reads',
      )
    const read = input.read
    const summary = session.contextObservation?.context
    if (
      read.intent === 'breakdown' &&
      (summary?.status !== 'available' || !sameContextSample(summary.sample, read.sample))
    )
      return fail('superseded', 'superseded', 'The requested context sample is no longer current')
    const key = JSON.stringify([
      input.sessionId,
      machineId,
      driverId,
      read.intent,
      read.intent === 'breakdown' ? read.sample : null,
    ])
    // A newly requested measurement cannot join (or prolong) its predecessor.
    for (const [priorKey, flight] of this.flights) {
      if (
        flight.sessionId === input.sessionId &&
        flight.intent === read.intent &&
        priorKey !== key
      ) {
        this.flights.delete(priorKey)
        flight.abort.abort()
      }
    }
    let flight = this.flights.get(key)
    if (flight && flight.waiters >= 64)
      return fail('refused', 'request-bounds', 'Too many observers are reading this sample')
    if (!flight) {
      if (this.flights.size >= 64)
        return fail('refused', 'request-bounds', 'Too many context reads are active')
      const abort = new AbortController()
      const current = (): ContextReadResult | undefined => {
        if (abort.signal.aborted || this.disposed)
          return fail('cancelled', 'cancelled', 'Context read cancelled')
        const bound = this.ports.session(input.sessionId)
        if (!this.ports.connected(machineId))
          return fail('unavailable', 'disconnected', 'The session daemon is disconnected')
        if (!this.ports.supported(machineId))
          return fail(
            'unsupported',
            'unsupported-peer',
            'The session daemon no longer supports context reads',
          )
        if (
          bound !== session ||
          bound.machineId !== machineId ||
          bound.driverId !== driverId ||
          bound.status !== 'live'
        )
          return fail('superseded', 'binding-changed', 'The context binding changed')
        if (read.intent === 'breakdown') {
          const next = bound.contextObservation?.context
          if (
            next?.status !== 'available' ||
            !sameContextSample(next.sample, read.sample) ||
            (summary?.status === 'available' &&
              (next.model?.modelId !== summary.model?.modelId ||
                next.model?.providerId !== summary.model?.providerId))
          )
            return fail('superseded', 'superseded', 'The requested context sample changed')
        }
      }
      const started: Flight = {
        sessionId: input.sessionId,
        intent: read.intent,
        abort,
        waiters: 0,
        result: Promise.resolve()
          .then(async () => {
            const refused = current()
            if (refused) return refused
            try {
              const answer = await this.ports.read(input, machineId, abort.signal)
              return current() ?? admitContextReadResult(read, answer)
            } catch {
              return (
                current() ?? fail('unavailable', 'read-failed', 'Context read did not complete')
              )
            }
          })
          .finally(() => {
            if (this.flights.get(key) === started) this.flights.delete(key)
          }),
      }
      flight = started
      this.flights.set(key, flight)
    }
    flight.waiters++
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => {}
    try {
      return await Promise.race([
        flight.result.then((answer) => admitContextReadResult(read, answer)),
        new Promise<ContextReadResult>((resolve) => {
          onAbort = () => resolve(fail('cancelled', 'cancelled', 'Context read cancelled'))
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) onAbort()
          timer = setTimeout(
            () => resolve(fail('unavailable', 'timed-out', 'Context read timed out')),
            read.timeoutMs,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (--flight.waiters === 0) {
        if (this.flights.get(key) === flight) this.flights.delete(key)
        flight.abort.abort()
      }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const flight of this.flights.values()) flight.abort.abort()
    this.flights.clear()
  }
}
