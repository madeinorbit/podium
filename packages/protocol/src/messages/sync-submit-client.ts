/**
 * SEND ONE COMMAND NOW, ON THE SYNC WRITE ENTRY POINT (ADR 12 D2 and D6, POD-6412).
 *
 * The `immediate` half of D6: a write the caller sends at once and waits on,
 * rather than queues in the outbox. The app's settings screen, the CLI and the
 * read-position tick all write this way. It goes through the same entry point as
 * a queued write, so it is checked, deduplicated and confirmed by a receipt the
 * same way; only the delivery differs.
 *
 * Here rather than in client-core because the CLI sends these too, and both
 * depend on this package. It needs nothing but the transport's `sync.submit`.
 *
 * A REFUSAL IS THROWN, shaped like the tRPC error the old per-command route
 * threw (`data.code`, the message), so a caller's existing error handling keeps
 * working when it moves off that route. The refusal itself rides along for a
 * caller that wants its kind.
 */

import { asMutationId, mintDeviceId } from '@podium/model'
import type { SyncSubmitInput, SyncSubmitRefusal } from './sync-submit'
import { SyncSubmitReply } from './sync-submit'

/** The one procedure this needs, as a tRPC client exposes it. */
export interface SyncSubmitTransport {
  readonly sync?: {
    readonly submit?: { mutate(input: SyncSubmitInput): Promise<unknown> }
  }
}

/** The tRPC error code an old route answered with, per refusal. */
export const SYNC_REFUSAL_CODES: Readonly<Record<SyncSubmitRefusal['kind'], string>> = {
  unauthorized: 'FORBIDDEN',
  'target-not-found': 'NOT_FOUND',
  conflict: 'CONFLICT',
  invalid: 'BAD_REQUEST',
  'confirmation-required': 'PRECONDITION_FAILED',
}

/**
 * A refusal as a plain sentence, for a refusal the handler gave no words of its
 * own (the permission checks never do). `action` is what the person tried, as a
 * verb phrase ("edit agent profiles"); without one the sentence says "do this".
 * The kind stays the machine-readable part: this is display text only.
 */
export function refusalSentence(refusal: SyncSubmitRefusal, action?: string): string {
  if (refusal.message !== undefined) return refusal.message
  const what = action ?? 'do this'
  switch (refusal.kind) {
    case 'unauthorized':
      return `You do not have permission to ${what}.`
    case 'target-not-found':
      return `Could not ${what}: it no longer exists, or you cannot see it.`
    case 'conflict':
      return 'Someone changed this first; try again.'
    case 'invalid':
      return refusal.details !== undefined && refusal.details.length > 0
        ? `Could not ${what}: these values are not valid: ${refusal.details.join(', ')}.`
        : `Could not ${what}: the request was not valid.`
    case 'confirmation-required':
      return `This is outside your scope; confirm to ${what}.`
  }
}

/** A definitive refusal from the entry point. Nothing was written. */
export class SyncSubmitRefusedError extends Error {
  /** The tRPC-shaped code, read by callers that classify errors (`data.code`). */
  readonly data: { readonly code: string }

  constructor(
    readonly command: string,
    readonly refusal: SyncSubmitRefusal,
    action?: string,
  ) {
    super(refusalSentence(refusal, action))
    this.name = 'SyncSubmitRefusedError'
    this.data = { code: SYNC_REFUSAL_CODES[refusal.kind] }
  }
}

/**
 * Whether a call failed because the server has no `sync.submit` at all: an older
 * server, from before the entry point. tRPC answers an unknown procedure with
 * NOT_FOUND and a message naming the path.
 */
export function isMissingSyncSubmit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  // An agent's relay to an older server: the gate does not know the router.
  if (RELAY_WITHOUT_SUBMIT.test(message)) return true
  const data = (error as { data?: { code?: unknown; httpStatus?: unknown } } | null)?.data
  if (data?.code !== 'NOT_FOUND' && data?.httpStatus !== 404) return false
  return /no procedure found/i.test(message) && message.includes('sync.submit')
}

/** The relay's answers for a router or procedure it does not serve. */
const RELAY_WITHOUT_SUBMIT =
  /^(?:no such procedure: sync\.submit|sync\.submit is not permitted via relay)$/

/** A server with the entry point that does not take this command on it yet: the
 *  entry point answers an unknown command as invalid input naming `command`. */
const isUnregistered = (refusal: SyncSubmitRefusal): boolean =>
  refusal.kind === 'invalid' &&
  refusal.message === undefined &&
  refusal.details?.length === 1 &&
  refusal.details[0] === 'command'

export interface SubmitNowOptions<T> {
  /** The contract version. Every command is at 1 today. */
  readonly version?: number
  /** The write's id. Minted per call when absent: a call with no id of its own is
   *  deduplicated against nothing, which is what such a call always meant. */
  readonly mutationId?: string
  readonly expectedRevision?: number
  /** The user's out-of-scope confirmation (ADR 3 D8 outcome 3). */
  readonly confirmed?: boolean
  /** What the person is doing, as a verb phrase ("edit agent profiles"), for the
   *  sentence a refusal without the handler's own words is shown as. */
  readonly action?: string
  /**
   * LEGACY(remove-after: 2027-03): the command's old per-command route, for a
   * server without `sync.submit`, or without this command on it yet. Removing it
   * leaves a client newer than its server unable to send this command.
   */
  readonly legacy?: () => Promise<T>
}

const mintMutationId = (): string => mintDeviceId('mut_')

/**
 * Send `command` with `input` through `sync.submit` and return its result.
 * Throws {@link SyncSubmitRefusedError} on a refusal; a transport failure
 * propagates as it is.
 */
export async function submitNow<T = unknown>(
  transport: SyncSubmitTransport,
  command: string,
  input: unknown,
  options: SubmitNowOptions<T> = {},
): Promise<T> {
  const submit = transport.sync?.submit
  const unserved = async (): Promise<T> => {
    if (options.legacy !== undefined) return await options.legacy()
    throw new SyncSubmitRefusedError(command, {
      kind: 'invalid',
      message: 'This server is too old for this; update it and try again.',
    })
  }
  if (submit === undefined) return await unserved()
  let raw: unknown
  try {
    raw = await submit.mutate({
      mutationId: asMutationId(options.mutationId ?? mintMutationId()),
      command,
      version: options.version ?? 1,
      input,
      ...(options.expectedRevision !== undefined
        ? { expectedRevision: options.expectedRevision }
        : {}),
      ...(options.confirmed === true ? { confirmed: true as const } : {}),
    })
  } catch (error) {
    if (isMissingSyncSubmit(error)) return await unserved()
    throw error
  }
  // A reply that cannot be read is a transport failure, never a guess.
  const reply = SyncSubmitReply.parse(raw)
  if (reply.outcome === 'rejected') {
    // LEGACY(remove-after: 2027-03): a server that has the entry point but not
    // this command on it yet still serves the command's own route.
    if (options.legacy !== undefined && isUnregistered(reply.refusal)) return await options.legacy()
    throw new SyncSubmitRefusedError(command, reply.refusal, options.action)
  }
  return reply.result as T
}

/** One procedure as a tRPC or relay client exposes it. */
interface MutatingProc {
  mutate(input?: unknown, ...rest: unknown[]): Promise<unknown>
}

/**
 * `procs` (a client's `issues`, say) with the writes `sends` names sent on
 * `sync.submit` as `<router>.<proc>`, and everything else, reads included, as it
 * was. LEGACY(remove-after: 2027-03): each write falls back to its own route on a
 * server without the entry point or without the command on it yet. Same shape and
 * types as `procs`, so a call site changes by one word.
 */
export function writesThroughSubmit<P extends object>(
  transport: SyncSubmitTransport,
  procs: P,
  router: string,
  sends: (proc: string, input: unknown) => boolean,
  options: { readonly refused?: (command: string, error: SyncSubmitRefusedError) => Error } = {},
): P {
  // A client without these procedures (a partial test fake) is handed back as
  // it is: the old call sites only read them when a command ran.
  if (procs === null || (typeof procs !== 'object' && typeof procs !== 'function')) return procs
  return new Proxy(procs, {
    get: (target, name, receiver) => {
      const proc: unknown = Reflect.get(target, name, receiver)
      if (typeof name !== 'string' || proc === undefined || proc === null) return proc
      const original = proc as MutatingProc
      const command = `${router}.${name}`
      return new Proxy(original, {
        get: (procTarget, key, procReceiver) => {
          const member: unknown = Reflect.get(procTarget, key, procReceiver)
          if (key !== 'mutate') return member
          return async (input?: unknown, ...rest: unknown[]): Promise<unknown> => {
            if (!sends(name, input)) return await original.mutate(input, ...rest)
            try {
              return await submitNow(transport, command, input, {
                legacy: async () => await original.mutate(input, ...rest),
              })
            } catch (error) {
              if (error instanceof SyncSubmitRefusedError && options.refused !== undefined) {
                throw options.refused(command, error)
              }
              throw error
            }
          }
        },
      })
    },
  })
}
