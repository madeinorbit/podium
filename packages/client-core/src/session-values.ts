/** Session display joins (POD-4974 S2). The replica keeps only server truth.
 * A present companion wins even when its cell is null, empty or absent. */
import type { SessionMeta, SessionMetaInput } from '@podium/model'
import { formatSessionRef } from '@podium/protocol'
import { activityAfterRead } from './values/unread'

export interface SessionValues {
  readAt: string | null
  unread: boolean
  snoozedUntil?: string | null
  displayRef?: string
  machineName?: string
  condition?: 'logged-out'
  handoffTarget?: string
}
export type SessionView = SessionMeta & SessionValues
export type SessionViewInput = SessionMetaInput & Partial<SessionValues>

/** Structural inputs also admit cold summaries and unparsed offline rows. */
export type SessionValueInput = {
  sessionId?: string
  lastActiveAt?: string
  agentKind?: string | null
  machineId?: string
  refRepoId?: string
  refSeq?: number
  refLetter?: string
  refDraft?: number
  handoffTargetMachineId?: string
}
export interface SessionHomes {
  /** False while the principal-bound cache has not yet caught up with the feed. */
  userStatesLoaded?: boolean
  userState?: { readAt: string | null; snoozedUntil?: string | null }
  repo?: { prefix?: string | null }
  machine?: { name: string; loggedOutHarnesses: readonly string[] }
  handoffMachine?: { name: string }
}

/** Companions are authoritative, including on old, unparsed offline rows. */
export function sessionValues(session: SessionValueInput, homes: SessionHomes = {}): SessionValues {
  if (arguments.length === 1) {
    const joined = session as SessionValueInput & Partial<SessionValues>
    return {
      readAt: joined.readAt ?? null,
      unread: joined.unread ?? activityAfterRead(joined.readAt ?? null, session.lastActiveAt ?? ''),
      snoozedUntil: joined.snoozedUntil,
      displayRef: joined.displayRef,
      machineName: joined.machineName ?? '',
      condition: joined.condition,
      handoffTarget: joined.handoffTarget,
    }
  }
  const { userState, repo, machine, handoffMachine } = homes
  const readAt = userState?.readAt ?? null
  let displayRef: string | undefined
  if (repo?.prefix) {
    if (session.refSeq !== undefined && session.refLetter) {
      displayRef = formatSessionRef({
        prefix: repo.prefix,
        seq: session.refSeq,
        letter: session.refLetter,
      })
    } else if (session.refDraft !== undefined) {
      displayRef = formatSessionRef({ prefix: repo.prefix, draft: session.refDraft })
    }
  }
  return {
    readAt,
    // No personal source row means no read cursor, just as an explicit null does.
    unread: (userState !== undefined || homes.userStatesLoaded !== false)
      && activityAfterRead(readAt, session.lastActiveAt ?? ''),
    snoozedUntil: userState?.snoozedUntil,
    displayRef,
    machineName: machine?.name ?? '',
    condition: machine?.loggedOutHarnesses.includes(session.agentKind ?? '')
      ? 'logged-out'
      : undefined,
    handoffTarget: handoffMachine?.name,
  }
}

interface Memo {
  next: WeakMap<object, Memo>
  value?: object
}
const views: Memo = { next: new WeakMap() }
const MISSING = Object.freeze({})
const LOADING = Object.freeze({})
/** One frozen shallow read view per row and companion identity.
 * Personal companions include the optimistic paint before this join. */
export function sessionView<T extends SessionValueInput>(
  session: T,
  homes: SessionHomes = {},
): T & SessionValues {
  let memo = views
  for (const key of [
    session,
    !homes.userState && homes.userStatesLoaded === false ? LOADING : MISSING,
    homes.userState ?? MISSING,
    homes.repo ?? MISSING,
    homes.machine ?? MISSING,
    homes.handoffMachine ?? MISSING,
  ]) {
    let next = memo.next.get(key)
    if (!next) {
      next = { next: new WeakMap() }
      memo.next.set(key, next)
    }
    memo = next
  }
  if (memo.value) return memo.value as T & SessionValues
  const values = sessionValues(session, homes)
  // Reads stay ordinary data-property reads; unchanged inputs reuse this copy.
  // Spread before restoring the prototype so inherited setters cannot intercept
  // the copied cells. Preserve null prototypes as well as custom prototypes.
  const value = { ...session, ...values }
  Object.setPrototypeOf(value, Object.getPrototypeOf(session))
  memo.value = Object.freeze(value)
  return memo.value as T & SessionValues
}

/** Snapshot adapter: rows stay raw in storage; only the client's read view joins. */
export function sessionViews<T extends SessionValueInput>(
  sessions: readonly T[],
  homes: {
    userId: string
    userStatesLoaded?: boolean
    userStates: readonly {
      userId: string
      sessionId: string
      readAt: string | null
      snoozedUntil?: string | null
    }[]
    repos: readonly { id: string; prefix?: string | null }[]
    machines: readonly { id: string; name: string; loggedOutHarnesses: readonly string[] }[]
  },
): (T & SessionValues)[] {
  const users = new Map(
    homes.userStates
      .filter((row) => row.userId === homes.userId)
      .map((row) => [row.sessionId, row]),
  )
  const repos = new Map(homes.repos.map((row) => [row.id, row]))
  const machines = new Map(homes.machines.map((row) => [row.id, row]))
  return sessions.map((session) =>
    sessionView(session, {
      userStatesLoaded: homes.userStatesLoaded,
      userState: users.get(session.sessionId ?? ''),
      repo: repos.get(session.refRepoId ?? ''),
      machine: machines.get(session.machineId ?? ''),
      handoffMachine: machines.get(session.handoffTargetMachineId ?? ''),
    }),
  )
}
