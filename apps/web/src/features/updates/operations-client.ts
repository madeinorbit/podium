/**
 * THE CALLS THE PANEL MAKES, AND THE TOLERANCE THEY NEED (POD-2102).
 *
 * The panel renders `operations.active` — bytes the server stores and serves
 * verbatim — but it also has to ACT, and the acting half of the contract is the
 * one place where a bundle and its server are routinely different builds. A web
 * bundle is swapped *during* the update it is driving (P8), and a shell can be
 * pointed at a server older than itself for weeks.
 *
 * So every mutation here is written twice: the operation verb the spec defines
 * (`updates.start`, `updates.retry`), and the pre-operation verb that server
 * still has (`updates.converge`). A server that has never heard of the first
 * answers NOT_FOUND, and the panel silently takes the second rather than
 * telling the user their update is impossible. This is the same law the read
 * side obeys — absent is never an error — applied to the write side.
 */
import type { Operation } from '@podium/protocol'
import { parseOperation } from '@podium/protocol'
import type { makeTrpc } from '@/app/trpc'

export type Trpc = ReturnType<typeof makeTrpc>

/**
 * A procedure this server does not have. tRPC answers an unknown path with
 * NOT_FOUND, and the message names the path — both are checked, because the
 * code travels in `data` on the HTTP link and older servers phrase the message
 * differently.
 */
export function isMissingProcedure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { message?: unknown; data?: { code?: unknown } }
  if (value.data?.code === 'NOT_FOUND') return true
  return typeof value.message === 'string' && /no procedure found|not_found/i.test(value.message)
}

/** The server's error sentence, without the transport vocabulary around it. */
export function errorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { message?: unknown; data?: { message?: unknown } }
  if (typeof value.data?.message === 'string') return value.data.message
  if (typeof value.message === 'string' && value.message.length > 0) return value.message
  return undefined
}

/**
 * A typed code, when the failure carries one. Both halves of the system speak
 * the same open kebab-case vocabulary (spec §7 for the server, POD-2135 for the
 * shell), so the panel can present either without knowing which spoke.
 */
export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { code?: unknown; data?: { podiumCode?: unknown } }
  if (typeof value.code === 'string') return value.code
  if (typeof value.data?.podiumCode === 'string') return value.data.podiumCode
  return undefined
}

/** The active operation, parsed through the ONE parser. `null` is ordinary. */
export async function readActiveOperation(trpc: Trpc): Promise<Operation | null> {
  const raw = await trpc.operations.active.query({ group: 'lifecycle' })
  return parseOperation(raw)
}

/**
 * THE MOST RECENT OPERATION, TERMINAL INCLUDED — and why the panel needs it.
 *
 * `operations.active` deliberately excludes terminal states (the store filters
 * on `isTerminalOperationState`), because "active" is what single-flight and
 * adoption are keyed on. But two of the panel's states are terminal: §6.2.4's
 * "Podium is on 0.4.3 everywhere" and §6.2.5's failure, which the spec says is
 * "never a dead end and never a toast that evaporates". Read only `active` and
 * both would blink out of existence at the exact moment they became true — a
 * failed update would leave the user with an empty corner, which is the old
 * behaviour this whole issue exists to end.
 *
 * So the outcome comes from `history`, which serves the same stored bytes. The
 * caller decides whether a given terminal operation is still worth showing
 * (`use-update-state.ts`); this function only fetches it.
 */
export async function readLatestOperation(trpc: Trpc): Promise<Operation | null> {
  const rows = await trpc.operations.history.query({ kind: 'update', limit: 1 })
  return parseOperation(rows[0])
}

/**
 * Start the one update operation. Single-flight lives on the SERVER (P6): a
 * second tab pressing this gets the running operation back (`alreadyRunning`),
 * not a second one, and both tabs then render the same object — which is why
 * this answers nothing and lets the poll do the rendering.
 *
 * `surface` travels with the click because the plan depends on it: an
 * all-in-one server plans a desktop-install ask, a browser plans a reload.
 */
export async function startUpdate(trpc: Trpc, surface?: string): Promise<void> {
  try {
    await trpc.updates.start.mutate(surface ? { surface } : undefined)
  } catch (error) {
    if (!isMissingProcedure(error)) throw error
    await trpc.updates.converge.mutate()
  }
}

/** Retry is a NEW operation over the remainder (§3.2); an old server just re-converges. */
export async function retryUpdate(trpc: Trpc, operationId?: string): Promise<void> {
  // Nothing to retry the remainder OF: start a fresh operation instead of
  // asking the server about an id we do not have.
  if (!operationId) return startUpdate(trpc)
  try {
    await trpc.updates.retry.mutate({ id: operationId })
  } catch (error) {
    if (!isMissingProcedure(error)) throw error
    await startUpdate(trpc)
  }
}

export interface CancelOutcome {
  canceled: boolean
  refused?: string
  step?: string
}

/** A refusal is a RETURNED VALUE, not an exception — see operations/trpc.ts. */
export async function cancelOperation(trpc: Trpc, id: string): Promise<CancelOutcome> {
  const result = (await trpc.operations.cancel.mutate({ id })) as CancelOutcome
  return result
}
