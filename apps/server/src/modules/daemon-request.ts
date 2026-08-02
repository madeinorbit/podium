/**
 * THE ONE DAEMON-RPC CORRELATOR (POD-318).
 *
 * Every server→daemon round-trip is the same four steps: mint a request id,
 * remember who is waiting, send the control message to a NAMED machine, and
 * settle (or time out) exactly once. Before this, each consumer owned step two:
 * ~28 hand-declared `pending*` maps across `modules/machines/rpc.ts`,
 * `modules/hosts/service.ts` and `modules/conversations/service.ts`, each with
 * its own `on*Result` settle method. The broker below owns REGISTRATION,
 * SETTLEMENT and TIMEOUT, so there is one registry and one place where the
 * rules about answering are written down.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ANSWERING MACHINE IS CHECKED (POD-1175)
 * ---------------------------------------------------------------------------
 * A request id alone is not an authorization. `gateway/daemon-frame-routing.ts`
 * classified every RPC reply as `request-correlated` — "the scope was fixed when
 * the request was sent" — and recorded that the claim was UNENFORCED: the
 * pending maps were keyed by `requestId` alone, so machine B's reply settled a
 * request sent to machine A. With one connected daemon that is invisible; with a
 * fleet it is a cross-machine read (another machine's directory listing, another
 * machine's credential bundle) delivered under the caller's own request.
 *
 * The check could not be written where the maps were, because the settle path
 * never received the answering machine. It receives it now — the mux resolves a
 * `MachinePrincipal` from the AUTHENTICATED TRANSPORT (never from a frame body)
 * and passes `principal.machine` down every reply path — so the rule lives here,
 * once, and every folded consumer inherits it:
 *
 *   a reply from a machine other than the one the request was SENT to is
 *   DROPPED with a loud log, and the request is LEFT PENDING to time out.
 *
 * Left pending, not failed fast: the honest machine may still answer, and a
 * wrong answerer must not be able to force an early (even if failed) resolution.
 *
 * ---------------------------------------------------------------------------
 * WHY REQUEST FAMILIES ARE TYPED TOKENS
 * ---------------------------------------------------------------------------
 * The per-kind maps were ugly but they were type-safe: a `Map<string, (r:
 * ScanResult) => void>` cannot be settled with a `DirListResult`. Collapsing to
 * one registry would normally throw that away. {@link DaemonRequestKind} keeps
 * it: a family is a token carrying an id prefix plus a PHANTOM result type, and
 * both `request` and `settle` take the same token — so the awaited type and the
 * settled value are checked against each other exactly as the map's type
 * parameter used to check them, with one registry underneath.
 *
 * The token is also checked at RUNTIME: settling request `dl3` through the
 * `fileRead` family is a wiring bug, not a mismatch a cast can hide, so it is
 * refused and logged rather than resolving the wrong caller's promise.
 */

import type { ControlMessage } from '@podium/protocol'

/**
 * One request FAMILY: the id prefix its requests are minted under, plus the
 * phantom result type binding its request site to its settle site.
 *
 * `result` is never present at runtime and must never be read — it exists so
 * `DaemonRequestKind<ScanResult>` and `DaemonRequestKind<OpResult>` are distinct
 * types rather than two spellings of `{ prefix: string }`.
 */
export interface DaemonRequestKind<T> {
  readonly prefix: string
  readonly result?: T
}

/** Declare a request family. The prefix namespaces its minted ids. */
export const daemonRequestKind = <T>(prefix: string): DaemonRequestKind<T> => ({ prefix })

/** One round-trip, as its caller describes it. */
export interface DaemonRequestSpec<T> {
  readonly kind: DaemonRequestKind<T>
  readonly timeoutMs: number
  /** The value the caller receives when no VALID answer arrives in time. */
  onTimeout(): T
  build(requestId: string): ControlMessage
  /** The machine the request is sent to — and the only one allowed to answer.
   *  Omitted means the fleet's default machine, resolved at send time. */
  readonly machineId?: string | undefined
}

/**
 * The broker's own port. Modules that make daemon round-trips depend on THIS,
 * not on a re-declared local copy of a `daemonRequest` function type: the two
 * structural copies that used to live in `conversations/service.ts` and
 * `hosts/service.ts` were the same port written twice (inventory §6.5 rule 1),
 * and neither could have grown the machine check on its own.
 */
export interface DaemonRequestPort {
  request<T>(spec: DaemonRequestSpec<T>): Promise<T>
  /**
   * Settle the request `requestId` with `value`, on the authority of the machine
   * that ANSWERED. Returns whether it settled — false means dropped (unknown or
   * already-settled id, wrong family, or wrong machine).
   */
  settle<T>(
    kind: DaemonRequestKind<T>,
    requestId: string,
    answeringMachineId: string,
    value: NoInfer<T>,
  ): boolean
  /** Globally-unique id mint, shared so ids never collide across families. */
  nextRequestId(prefix: string): string
}

export interface DaemonRequestBrokerDeps {
  toMachine(machineId: string, msg: ControlMessage): void
  defaultMachine(): string
}

/** One in-flight request: who may answer it, and what happens when they do. */
interface PendingDaemonRequest {
  readonly prefix: string
  readonly targetMachineId: string
  readonly resolve: (value: unknown) => void
}

/**
 * Shared request-id, correlation and timeout substrate. Constructed BEFORE every
 * daemon-RPC consumer (`relay.ts`), which is what lets `ConversationsService`,
 * `HostsService` and `DaemonRpcService` all take the same instance without a
 * deferred closure over a not-yet-constructed service — the cycle POD-321 broke
 * and the construction-order gate keeps broken.
 */
export class DaemonRequestBroker implements DaemonRequestPort {
  private nextRequestNum = 0
  private readonly pending = new Map<string, PendingDaemonRequest>()

  constructor(private readonly deps: DaemonRequestBrokerDeps) {}

  nextRequestId(prefix: string): string {
    return `${prefix}${this.nextRequestNum++}`
  }

  /** In-flight requests — for tests that assert a dropped answer left one waiting. */
  get inFlight(): number {
    return this.pending.size
  }

  request<T>(spec: DaemonRequestSpec<T>): Promise<T> {
    const requestId = this.nextRequestId(spec.kind.prefix)
    // Resolved HERE, not at settle time: the target is a fact about the request,
    // and `defaultMachine()` can change between send and reply.
    const targetMachineId = spec.machineId ?? this.deps.defaultMachine()
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(spec.onTimeout())
      }, spec.timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, {
        prefix: spec.kind.prefix,
        targetMachineId,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
      })
      this.deps.toMachine(targetMachineId, spec.build(requestId))
    })
  }

  settle<T>(
    kind: DaemonRequestKind<T>,
    requestId: string,
    answeringMachineId: string,
    value: NoInfer<T>,
  ): boolean {
    const entry = this.pending.get(requestId)
    // Ordinary and silent: the request already timed out, or was already
    // settled, or belongs to a correlator this broker does not own.
    if (!entry) return false
    if (entry.prefix !== kind.prefix) {
      console.warn(
        `[podium] dropped daemon reply '${requestId}': settled through request family '${kind.prefix}' but it was sent as '${entry.prefix}'`,
      )
      return false
    }
    if (entry.targetMachineId !== answeringMachineId) {
      // LOUD, and the request stays pending (POD-1175). A machine answering for
      // a request it was never sent is either a routing bug or an attempt to
      // serve another machine's data under this caller's correlation id.
      console.error(
        `[podium] dropped daemon reply '${requestId}': answered by machine '${answeringMachineId}' but sent to '${entry.targetMachineId}'`,
      )
      return false
    }
    this.pending.delete(requestId)
    entry.resolve(value)
    return true
  }
}
