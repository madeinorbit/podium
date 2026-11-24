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

import {
  acceptedLinePipe,
  harnessAccepts,
  harnessHideFromCommands,
  unmetHideFromCommandsPrerequisites,
} from '@podium/harness'
import type { AgentKind, SessionId } from '@podium/model'
import type { PipeSecret } from '@podium/process/durable'
import {
  type AccessField,
  HomeHarness,
  homeIdFor,
  parsePodiumHomeId,
  podiumHomeId,
} from '@podium/protocol'
import { resolveOnPath } from '@podium/runtime/command-environment'

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

/** What the home rule reads of the machine (managed installs §4.2). */
export interface MachineHomeFacts {
  /** Whether the machine has a managed install of `kind` now. */
  managedInstall(kind: import('@podium/model').BuiltinHarnessKind): boolean
  externalInstall?(kind: import('@podium/model').BuiltinHarnessKind): boolean
  /**
   * What the login files say on one side of the machine's own login of
   * `kind`: the person's own folder, or the Podium home (POD-7496,
   * `ownLoginInPodiumHome`). Absent: not read, and with both installs the
   * person's side keeps the machine's own login.
   */
  ownLogin?(
    kind: import('@podium/protocol').HomeHarness,
    side: import('@podium/harness').HarnessHomeSide,
  ): import('@podium/harness').HarnessLogin['state']
}

/** A credential passed in, with a managed install there: the Podium home (§4.3). */
function passedInHome(kind: AgentKind | undefined, machine: MachineHomeFacts | undefined) {
  const harness = HomeHarness.safeParse(kind)
  return harness.success && machine?.managedInstall(harness.data)
    ? podiumHomeId(harness.data)
    : undefined
}

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
   * The Podium home the session runs in (credential management §10, managed
   * installs §4.3), or undefined for the harness's own directory.
   *
   * - A home delivery: the home it names. Its `default` is the person's own
   *   login, which always runs in the person's folder.
   * - An env delivery (a credential Podium passes in): the harness's Podium
   *   home when `machine` has a managed install of it; else the person's
   *   folder, as credential management built it.
   *
   * From the access held in memory; after a restart, before the server's
   * refresh, from the marker: a home delivery's home is the credential's home
   * for the session's harness.
   */
  homeIdOf(sessionId: SessionId, machine?: MachineHomeFacts): string | undefined {
    const held = this.held.get(sessionId)
    if (held) {
      const delivery = held.access.delivery
      if (delivery.kind === 'env') return passedInHome(held.agentKind, machine)
      return delivery.homeId !== DEFAULT_HOME ? delivery.homeId : undefined
    }
    const marker = this.marker(sessionId)
    if (marker?.delivery === 'env') return passedInHome(marker.agentKind, machine)
    if (marker?.delivery !== 'home') return undefined
    // A home that cannot be named from the marker is still a home: an id no
    // home has, so the start is refused rather than run on the default login.
    const unnamed = `${marker.credentialId}:${marker.agentKind ?? 'unknown'}`
    const harness = HomeHarness.safeParse(marker.agentKind)
    if (!harness.success) return unnamed
    try {
      return homeIdFor(marker.credentialId, harness.data)
    } catch {
      return unnamed
    }
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
  /**
   * The harness's hide-from-commands arguments, then the delivering line's
   * `startArgs` (how the harness reads the variable, such as Codex's ChatGPT
   * plan provider), placed right after the executable. Never the secret.
   */
  args: string[]
  /** Variables the inherited-credential strip must leave alone: the delivered one. */
  keep: string[]
  /**
   * Variables the start removes on top of the inherited-credential strip: a
   * piped line's own variable, so no copy inherited from the daemon competes
   * with the pipe (POD-7378).
   */
  strip: string[]
  /**
   * The secret on an inherited pipe instead of in `env` (POD-7378): the
   * process layer fills a pipe, closes its writer and sets the variable to
   * its descriptor before the process starts. One per process start.
   */
  pipe?: PipeSecret
}

const NO_OVERLAY: DeliveryOverlay = { env: {}, args: [], keep: [], strip: [] }

/** A start refused because the credential Podium passes in is empty (POD-7378). */
export class EmptyCredentialError extends Error {
  override readonly name = 'EmptyCredentialError'
}

/** The accepted line that delivers `access`, read off the harness's manifest. */
function deliveringLine(agentKind: AgentKind | undefined, access: AccessField | undefined) {
  if (access?.delivery.kind !== 'env' || !agentKind) return undefined
  const variable = access.delivery.variable
  // A harness never delivers two lines in one variable (pinned in the
  // harness's credential-accepts test).
  return harnessAccepts(agentKind).find(
    (l) => l.deliver.kind === 'env' && l.deliver.variable === variable,
  )
}

/**
 * The pipe `access` goes in on for `agentKind` on `platform`, or undefined
 * when it goes in a variable (or is not a passed-in credential at all).
 */
export function deliveryPipe(
  agentKind: AgentKind | undefined,
  access: AccessField | undefined,
  platform: NodeJS.Platform = process.platform,
): { variable: string } | undefined {
  const line = deliveringLine(agentKind, access)
  return line ? acceptedLinePipe(line, platform) : undefined
}

/**
 * The env and arguments a process start adds for `access`. Only an `env`
 * delivery adds anything (a home delivery is the home's own business, Task 8);
 * in the Podium home also the line's `homeStartArgs`.
 *
 * - Where the line reads its secret from a pipe on this platform (POD-7378),
 *   the secret goes on a pipe and no variable holds it, so the harness's
 *   hide-from-commands switch is not set either. An empty secret is refused:
 *   Claude Code given an empty token falls back to a login stored in its home.
 * - Otherwise the secret goes in the line's variable, with the harness's
 *   documented switches that keep it out of the commands the agent runs
 *   (`hideFromCommands`, spec §14: an accident guard, not a barrier).
 */
export function deliveryOverlay(
  agentKind: AgentKind | undefined,
  access: AccessField | undefined,
  /** The start runs in the Podium home (managed installs §4.3): the line's
   *  `homeStartArgs` apply too. */
  where: { podiumHome?: boolean; platform?: NodeJS.Platform } = {},
): DeliveryOverlay {
  if (access?.delivery.kind !== 'env') return NO_OVERLAY
  const variable = access.delivery.variable
  const line = deliveringLine(agentKind, access)
  const lineArgs = [
    ...(line?.startArgs ?? []),
    ...(where.podiumHome ? (line?.homeStartArgs ?? []) : []),
  ]
  const pipe = line ? acceptedLinePipe(line, where.platform ?? process.platform) : undefined
  if (pipe) {
    if (access.delivery.secret.trim() === '') {
      throw new EmptyCredentialError(
        `The credential Podium passes to this session is empty, so the session was not started: given an empty credential the agent could fall back to a login stored on this machine. Check the credential, then start the session again.`,
      )
    }
    return {
      env: {},
      args: lineArgs,
      keep: [],
      strip: [variable],
      pipe: { variable: pipe.variable, contents: access.delivery.secret },
    }
  }
  const hide = agentKind ? harnessHideFromCommands(agentKind) : undefined
  return {
    env: { [variable]: access.delivery.secret, ...hide?.env },
    args: [...(hide?.args ?? []), ...lineArgs],
    keep: [variable],
    strip: [],
  }
}

/**
 * The variables the session's credential stands for, for DRIVER SELECTION
 * only: the line's own variable, whether the secret goes there or on a pipe.
 * Selection reads which kind of credential a session has; this env never
 * reaches a process.
 */
export function deliveredCredentialEnv(access: AccessField | undefined): Record<string, string> {
  return access?.delivery.kind === 'env'
    ? { [access.delivery.variable]: access.delivery.secret }
    : {}
}

/** A start refused because the harness cannot run its hide-from-commands switch here. */
export class HarnessPrerequisiteMissingError extends Error {
  override readonly name = 'HarnessPrerequisiteMissingError'
}

/**
 * Refuse a start that delivers `access` when the hide-from-commands switch
 * {@link deliveryOverlay} adds needs a program `env`'s PATH does not have
 * (POD-7375). `env` is the environment the process gets. Only an `env`
 * delivery in a variable sets a switch, so any other start passes, and so
 * does one whose secret goes on a pipe (POD-7378).
 */
export function assertDeliveryPrerequisites(
  agentKind: AgentKind | undefined,
  access: AccessField | undefined,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (access?.delivery.kind !== 'env' || !agentKind) return
  if (deliveryPipe(agentKind, access, platform)) return
  const unmet = unmetHideFromCommandsPrerequisites(agentKind, {
    platform,
    resolve: (command) => resolveOnPath(command, env, platform),
  })
  if (unmet.length > 0) {
    throw new HarnessPrerequisiteMissingError(unmet.map((need) => need.missing).join(' '))
  }
}

/** Whether a start bound to a home with this id runs in the Podium home (§4.3). */
export function isPodiumHomeId(homeId: string | undefined): boolean {
  return homeId !== undefined && parsePodiumHomeId(homeId) !== null
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
