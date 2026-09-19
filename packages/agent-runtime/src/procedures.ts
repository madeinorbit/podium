// Part of the Agent Runtime contract (POD-1761, POD-4303). See ./index.ts for
// the surface's five governing rules and ./driver.ts for the procedures layer.

import type { TranscriptItem } from '@podium/model'
import { supported } from '@podium/harness'
import type { RuntimeHistoryRange } from '@podium/protocol/daemon'
import type {
  AgentSessionHandle,
  DriverProcedureOverrides,
  RuntimeDriver,
} from './driver.js'
import { DriverRefusalError, type TurnEvent } from './errors.js'
import type { RuntimeEvent } from './events.js'
import type { SessionSpec } from './session-spec.js'
import type { ActingPrincipal, InputOrigin, TurnDelivery, TurnInput } from './turns.js'

/**
 * Options for the generic procedure compositions.
 *
 * `origin`/`delivery`/`principal` are the write path's own options: who is
 * acting and how the turn should reach the agent. Defaults are the headless
 * executor's: an agent-role caller delivering `when-ready`.
 */
export interface ProcedureOptions {
  origin?: InputOrigin
  delivery?: TurnDelivery
  principal?: ActingPrincipal
  /** Abort the wait (and best-effort interrupt the turn) when fired. */
  signal?: AbortSignal
  /** Convenience over `signal`: interrupt and throw after this many ms. */
  timeoutMs?: number
}

/** Options for {@link genericOneShot}, in addition to {@link ProcedureOptions}. */
export interface OneShotOptions extends ProcedureOptions {
  /** Transcript page size for the final read. Defaults to 1000. */
  historyLimit?: number
}

const DEFAULT_ORIGIN: InputOrigin = 'agent'
const DEFAULT_DELIVERY: TurnDelivery = 'when-ready'

class ProcedureTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`procedure timed out after ${timeoutMs}ms`)
    this.name = 'ProcedureTimeoutError'
  }
}

class ProcedureAbortedError extends Error {
  constructor() {
    super('procedure aborted')
    this.name = 'ProcedureAbortedError'
  }
}

/**
 * Is this TurnEvent terminal for the epoch it belongs to? `started` never is;
 * `completed` and `failed` always are.
 */
export function isTerminalTurnEvent(event: TurnEvent): boolean {
  return event.ev !== 'started'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProcedureAbortedError()
}

/**
 * send + await the matching turn-completed.
 *
 * THE GENERIC COMPOSITION the driver surface promises: a driver MAY override
 * this when the harness has a native or atomic form, and absent that override
 * this function IS the implementation. Pure composition over `send` + `events`:
 * it needs no driver-private access and varies per harness only in mechanism
 * (how long a turn takes) and timing, never in semantics.
 *
 * Correlation: an `accepted` receipt names its `turnEpoch` and the wait ends at
 * the first terminal event (`completed`/`failed`) for exactly that epoch.
 * `queued`/`unverified` receipts name no epoch, so the wait ends at the first
 * terminal event for the first epoch that STARTED after the send resolved. A
 * `refused` receipt throws {@link DriverRefusalError} — a refusal is expected
 * and branchable, never a turn outcome.
 *
 * The subscription starts from `'bootstrap'` BEFORE the send resolves, so a
 * turn that completes synchronously behind the send cannot slip between the
 * receipt and the first read. Streaming callers that also want live items
 * subscribe to `handle.events()` themselves; this procedure consumes its own
 * subscription and returns only the terminal event.
 */
export async function genericAskAndAwait(
  handle: AgentSessionHandle,
  input: TurnInput,
  options?: ProcedureOptions,
): Promise<TurnEvent> {
  const origin = options?.origin ?? DEFAULT_ORIGIN
  const delivery = options?.delivery ?? DEFAULT_DELIVERY
  const signal = options?.signal
  const timeoutMs = options?.timeoutMs
  throwIfAborted(signal)

  const release = await handle.watch('fine').catch(() => undefined)
  try {
    const iterator = handle.events('bootstrap')[Symbol.asyncIterator]()
    try {
      const receipt = await handle.send(input, {
        ...(options?.principal ? { principal: options.principal } : {}),
        ...(signal ? { signal } : {}),
        origin,
        delivery,
      })
      if (receipt.outcome === 'refused') {
        throw new DriverRefusalError(receipt.refusal, 'askAndAwait send refused')
      }

      let timeout: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const timer =
        timeoutMs !== undefined
          ? new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                reject(new ProcedureTimeoutError(timeoutMs))
              }, timeoutMs)
              timeout.unref?.()
            })
          : undefined
      const abort =
        signal !== undefined
          ? new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(new ProcedureAbortedError())
                return
              }
              onAbort = () => reject(new ProcedureAbortedError())
              signal.addEventListener('abort', onAbort, { once: true })
            })
          : undefined

      try {
        // `accepted` names its epoch; anything else waits for the first epoch
        // that starts after the send.
        let wantedEpoch = receipt.outcome === 'accepted' ? receipt.turnEpoch : undefined
        const waiter = (async (): Promise<TurnEvent> => {
          for (;;) {
            throwIfAborted(signal)
            const result = await iterator.next()
            if (result.done) {
              throw new Error('askAndAwait event stream ended before the turn completed')
            }
            const event: RuntimeEvent = result.value
            if (event.t !== 'turn') continue
            const turn = event.ev
            if (turn.ev === 'started') {
              if (wantedEpoch === undefined) wantedEpoch = turn.turnEpoch
              continue
            }
            if (wantedEpoch === undefined) {
              // No epoch claimed yet and no start seen: a terminal event with
              // no observed start belongs to a turn that predates this send.
              continue
            }
            if (turn.turnEpoch !== wantedEpoch) continue
            return turn
          }
        })()
        const raced =
          timer !== undefined || abort !== undefined
            ? Promise.race([
                waiter,
                ...(timer !== undefined ? [timer] : []),
                ...(abort !== undefined ? [abort] : []),
              ])
            : waiter
        return await raced
      } catch (error) {
        if (error instanceof ProcedureTimeoutError || error instanceof ProcedureAbortedError) {
          // Best-effort: a timed-out or aborted wait must not leave the turn
          // running behind the caller's back. The fence still arrives on the
          // event stream for whoever is watching.
          await handle.interrupt().catch(() => undefined)
        }
        throw error
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
        if (signal !== undefined && onAbort !== undefined) {
          signal.removeEventListener('abort', onAbort)
        }
      }
    } finally {
      try {
        await iterator.return?.()
      } catch {
        // Closing a satisfied subscription is best-effort; it must not mask
        // the terminal event the wait already resolved.
      }
    }
  } finally {
    try {
      release?.()
    } catch {
      // Releasing the fine watch is best-effort; it must not mask the turn.
    }
  }
}

/**
 * Read the whole live transcript, oldest page first.
 *
 * Paging follows `hasMore` through the `head` cursor: without an anchor,
 * `before` reads the newest window, and each earlier window excludes its
 * anchor, so prepending yields chronological order without duplicates.
 */
export async function readFullTranscript(
  handle: AgentSessionHandle,
  limit = 1000,
): Promise<readonly TranscriptItem[]> {
  const pages: TranscriptItem[][] = []
  let from: RuntimeHistoryRange['from'] = undefined
  for (;;) {
    const page = await handle.transcript.history({
      ...(from !== undefined ? { from } : {}),
      limit,
    })
    pages.unshift([...page.items])
    if (!page.hasMore || page.head === undefined) break
    from = page.head
  }
  return pages.flat()
}

/**
 * ephemeral create → send → await → kill.
 *
 * THE GENERIC COMPOSITION for one-shot turns: drivers with a native one-shot
 * form (`claude -p`, `codex exec --ephemeral`) override this rather than paying
 * for a full session — see {@link resolveProcedures}, which prefers the
 * override. This function itself is pure composition with no override check,
 * so calling it directly always pays for the full session.
 *
 * The session carries `spec` (workdir, sticky model, MCP, instructions, env);
 * the prompt travels as the one turn's text with per-turn model/effort
 * overrides when the spec pins them. Returns the turn's transcript items on
 * `completed` (any verdict, including `interrupted`: the interrupt mark is part
 * of the items). Throws on `failed` (the failure reason is the message) and on
 * refused sends ({@link DriverRefusalError}). The handle is killed in every
 * path — a one-shot that survives its turn is a leak wearing a procedure's
 * name.
 */
export async function genericOneShot(
  driver: RuntimeDriver,
  spec: SessionSpec,
  prompt: string,
  options?: OneShotOptions,
): Promise<readonly TranscriptItem[]> {
  const handle = await driver.create(spec)
  try {
    const overrides =
      spec.model.model !== undefined || spec.model.effort !== undefined
        ? {
            overrides: supported({
              ...(spec.model.model !== undefined ? { model: spec.model.model } : {}),
              ...(spec.model.effort !== undefined ? { effort: spec.model.effort } : {}),
            }),
          }
        : {}
    const terminal = await genericAskAndAwait(handle, { text: prompt, ...overrides }, options)
    if (terminal.ev === 'failed') {
      throw new Error(
        `one-shot turn failed (${terminal.reason})${terminal.detail ? `: ${terminal.detail}` : ''}`,
      )
    }
    return await readFullTranscript(handle, options?.historyLimit ?? 1000)
  } finally {
    await handle.kill().catch(() => undefined)
  }
}

/**
 * Resolve the procedure implementations for a driver: the driver's declared
 * override when present, the generic composition otherwise.
 *
 * THE HOUSE PATTERN from the driver surface: peculiarities stay inside the
 * driver that owns them, and everything else shares one implementation. Call
 * sites resolve once per call rather than caching, so a driver whose override
 * appears late (a test double, a lazy import) is honoured on the next turn.
 */
export function resolveProcedures(driver: RuntimeDriver): DriverProcedureOverrides {
  return {
    askAndAwait: driver.procedures?.askAndAwait ?? genericAskAndAwait,
    oneShot: driver.procedures?.oneShot ?? ((spec, prompt) => genericOneShot(driver, spec, prompt)),
  }
}
