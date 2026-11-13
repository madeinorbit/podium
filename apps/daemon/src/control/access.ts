/**
 * A SESSION'S CREDENTIAL ON THIS DAEMON (credential management §8, "What
 * crosses the wire" and "Memory only"; epic plan Task 5).
 *
 * The server sends a session's credential in the `access` field of the frame
 * that starts it (a spawn, a headless turn) and again after a reconnect
 * (`sessionAccessRefresh`). This store keeps it IN MEMORY for the session's
 * life, because some drivers start a process for every turn, and every place
 * that starts a process for the session applies it from here: the terminal
 * launch, `SessionEngineScope.startEngine`, the headless turn's child env.
 *
 * NOTHING SECRET IS WRITTEN DOWN. What reaches the state dir is a marker per
 * session: the credential's id and the kind of delivery. It exists so that a
 * daemon that restarted, and so lost the secret, knows the session needs one:
 * a process start then waits for the server's refresh and fails with a
 * readable error after a bounded wait. It never starts on the machine's own
 * login instead.
 */

import { harnessHideFromCommands } from '@podium/harness'
import type { AgentKind, SessionId } from '@podium/model'
import type { AccessField } from '@podium/protocol'

/** What survives a restart: that a session needs a credential, never the secret. */
export interface AccessMarker {
  sessionId: SessionId
  credentialId: string
  delivery: 'env' | 'home'
  agentKind?: AgentKind
}

/** The durable marker store, one file per session under the state dir. */
export interface MarkerJournal {
  read(sessionId: SessionId): AccessMarker | undefined
  write(entry: AccessMarker): void
  clear(sessionId: SessionId): void
}

/** How long a process start waits for the server's refresh after a restart. */
export const ACCESS_WAIT_MS = 30_000

/** A process start for a session whose credential has not arrived. */
export class AccessNotArrivedError extends Error {
  override readonly name = 'AccessNotArrivedError'
}

/** The harness's own directory: nothing to apply and nothing to remember. */
const DEFAULT_HOME = 'default'

const needsMarker = (access: AccessField): boolean =>
  access.delivery.kind === 'env' || access.delivery.homeId !== DEFAULT_HOME

export class SessionAccessStore {
  private readonly held = new Map<SessionId, { access: AccessField; agentKind?: AgentKind }>()
  private readonly waiters = new Map<
    SessionId,
    Set<{ resolve: (access: AccessField) => void; reject: (error: Error) => void }>
  >()
  private readonly waitMs: number

  constructor(private readonly options: { markers: MarkerJournal; waitMs?: number }) {
    this.waitMs = options.waitMs ?? ACCESS_WAIT_MS
  }

  /** Hold `access` for the session (memory) and mark that it needs one (disk). */
  remember(sessionId: SessionId, access: AccessField, agentKind?: AgentKind): void {
    const kind =
      agentKind ?? this.held.get(sessionId)?.agentKind ?? this.marker(sessionId)?.agentKind
    this.held.set(sessionId, { access, ...(kind ? { agentKind: kind } : {}) })
    if (needsMarker(access)) {
      const previous = this.marker(sessionId)
      if (
        previous?.credentialId !== access.credentialId ||
        previous.delivery !== access.delivery.kind ||
        previous.agentKind !== kind
      ) {
        this.options.markers.write({
          sessionId,
          credentialId: access.credentialId,
          delivery: access.delivery.kind,
          ...(kind ? { agentKind: kind } : {}),
        })
      }
    }
    for (const waiter of this.waiters.get(sessionId) ?? []) waiter.resolve(access)
    this.waiters.delete(sessionId)
  }

  /** The access held in memory now, if any. */
  current(sessionId: SessionId): AccessField | undefined {
    return this.held.get(sessionId)?.access
  }

  /** The harness the session runs, as its spawn or its marker named it. */
  agentKindOf(sessionId: SessionId): AgentKind | undefined {
    return this.held.get(sessionId)?.agentKind ?? this.marker(sessionId)?.agentKind
  }

  /**
   * The access a process start for this session must apply. Undefined when the
   * session needs none. When it needs one this daemon does not hold (a restart
   * lost it), waits for the server's refresh, then rejects with
   * {@link AccessNotArrivedError}.
   */
  async awaitAccess(sessionId: SessionId): Promise<AccessField | undefined> {
    const held = this.current(sessionId)
    if (held) return held
    if (!this.marker(sessionId)) return undefined
    return await new Promise<AccessField>((resolve, reject) => {
      const waiter = {
        resolve: (access: AccessField) => {
          clearTimeout(timer)
          resolve(access)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      const timer = setTimeout(() => {
        this.waiters.get(sessionId)?.delete(waiter)
        reject(
          new AccessNotArrivedError(
            `The credential for session ${sessionId} has not arrived from the server since this machine's Podium restarted, so the session was not started without it. Check that the machine is connected and its credential can still be used, then try again.`,
          ),
        )
      }, this.waitMs)
      timer.unref?.()
      const set = this.waiters.get(sessionId) ?? new Set()
      set.add(waiter)
      this.waiters.set(sessionId, set)
    })
  }

  /** The session ended: drop the secret and the marker; a waiting start fails. */
  forget(sessionId: SessionId): void {
    this.held.delete(sessionId)
    this.options.markers.clear(sessionId)
    for (const waiter of this.waiters.get(sessionId) ?? []) {
      waiter.reject(
        new AccessNotArrivedError(`Session ${sessionId} ended before its credential arrived.`),
      )
    }
    this.waiters.delete(sessionId)
  }

  /** The daemon is shutting down: drop every secret, keep the markers. */
  clearMemory(): void {
    this.held.clear()
  }

  private marker(sessionId: SessionId): AccessMarker | undefined {
    return this.options.markers.read(sessionId)
  }
}

/** What a process start adds for a session's access. */
export interface DeliveryOverlay {
  /** The delivered variable and the harness's hide-from-commands switches. */
  env: Record<string, string>
  /** The harness's hide-from-commands arguments, placed right after the executable. */
  args: string[]
  /** Variables the inherited-credential strip must leave alone: the delivered one. */
  keep: string[]
}

/**
 * The env and arguments a process start adds for `access`. Only an `env`
 * delivery adds anything (a home delivery is the home's own business, Task 8);
 * with it come the harness's documented switches that keep the credential out
 * of the commands the agent runs (`hideFromCommands`, spec §14: an accident
 * guard, not a barrier).
 */
export function deliveryOverlay(
  agentKind: AgentKind | undefined,
  access: AccessField | undefined,
): DeliveryOverlay {
  if (access?.delivery.kind !== 'env') return { env: {}, args: [], keep: [] }
  const hide = agentKind ? harnessHideFromCommands(agentKind) : undefined
  return {
    env: { [access.delivery.variable]: access.delivery.secret, ...hide?.env },
    args: [...(hide?.args ?? [])],
    keep: [access.delivery.variable],
  }
}

/** The same command with `extra` right after the executable, before its own arguments. */
export function withLeadingArgs<C extends { args: readonly string[] }>(
  command: C,
  extra: readonly string[],
): C {
  if (extra.length === 0) return command
  return { ...command, args: [...extra, ...command.args] }
}

/** A marker journal held in memory: tests, and contexts built without a state dir. */
export function memoryMarkers(): MarkerJournal {
  const entries = new Map<SessionId, AccessMarker>()
  return {
    read: (sessionId) => entries.get(sessionId),
    write: (entry) => void entries.set(entry.sessionId, entry),
    clear: (sessionId) => void entries.delete(sessionId),
  }
}
