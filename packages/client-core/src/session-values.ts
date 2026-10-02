/** Session display joins (POD-4974 S2). The replica keeps only server truth.
 * A present companion wins even when its cell is null, empty or absent. */
import type { SessionMeta } from '@podium/model'
import { formatSessionRef } from '@podium/protocol'
import { activityAfterRead } from './viewmodels/unread'

export interface SessionValues {
  readAt: string | null
  unread: boolean
  snoozedUntil?: string | null
  displayRef?: string
  machineName: string
  condition?: 'logged-out'
  handoffTarget?: string
}
export type SessionView = Omit<SessionMeta, keyof SessionValues> & SessionValues

/** Structural inputs also admit cold summaries and unparsed offline rows. */
export type SessionValueInput = Partial<SessionValues> & {
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
  userState?: { readAt: string | null; snoozedUntil?: string | null }
  repo?: { prefix?: string | null }
  machine?: { name: string; loggedOutHarnesses: readonly string[] }
  handoffMachine?: { name: string }
}

/** The only legacy-field fallback. Never use ?? to choose a companion cell. */
export function sessionValues(session: SessionValueInput, homes: SessionHomes = {}): SessionValues {
  const { userState, repo, machine, handoffMachine } = homes
  const readAt = userState ? userState.readAt : session.readAt ?? null
  let displayRef: string | undefined
  if (!repo) displayRef = session.displayRef
  else if (repo.prefix) {
    if (session.refSeq !== undefined && session.refLetter) {
      displayRef = formatSessionRef({ prefix: repo.prefix, seq: session.refSeq, letter: session.refLetter })
    } else if (session.refDraft !== undefined) {
      displayRef = formatSessionRef({ prefix: repo.prefix, draft: session.refDraft })
    }
  }
  return {
    readAt,
    unread: userState ? activityAfterRead(readAt, session.lastActiveAt ?? '') : session.unread === true,
    snoozedUntil: userState ? userState.snoozedUntil : session.snoozedUntil,
    displayRef,
    machineName: machine ? machine.name : session.machineName ?? '',
    condition: machine
      ? machine.loggedOutHarnesses.includes(session.agentKind ?? '') ? 'logged-out' : undefined
      : session.condition,
    handoffTarget: handoffMachine ? handoffMachine.name : session.handoffTarget,
  }
}

interface Memo { next: WeakMap<object, Memo>; value?: object }
const views: Memo = { next: new WeakMap() }
const MISSING = Object.freeze({})

/** A borrowed row with computed cells, not another copy of the session record.
 * Compose before the optimistic fold: S3 still owns retargeting those edits. */
export function sessionView<T extends SessionValueInput>(session: T, homes: SessionHomes = {}): T & SessionValues {
  if (!homes.userState && !homes.repo && !homes.machine && !homes.handoffMachine) return session as T & SessionValues
  let memo = views
  for (const key of [session, homes.userState ?? MISSING, homes.repo ?? MISSING, homes.machine ?? MISSING, homes.handoffMachine ?? MISSING]) {
    let next = memo.next.get(key)
    if (!next) { next = { next: new WeakMap() }; memo.next.set(key, next) }
    memo = next
  }
  if (memo.value) return memo.value as T & SessionValues
  const values = sessionValues(session, homes)
  memo.value = new Proxy(session, {
    get(target, key, receiver) {
      return Object.hasOwn(values, key) ? Reflect.get(values, key) : Reflect.get(target, key, receiver)
    },
    has(target, key) { return Object.hasOwn(values, key) || Reflect.has(target, key) },
    ownKeys(target) { return [...new Set([...Reflect.ownKeys(target), ...Object.keys(values)])] },
    getOwnPropertyDescriptor(target, key) {
      return Object.hasOwn(values, key)
        ? { configurable: true, enumerable: true, writable: false, value: Reflect.get(values, key) }
        : Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  return memo.value as T & SessionValues
}

/** Snapshot adapter: rows stay raw in storage; only the client's read view joins. */
export function sessionViews<T extends SessionValueInput>(sessions: readonly T[], homes: {
  userId: string
  userStates: readonly { userId: string; sessionId: string; readAt: string | null; snoozedUntil?: string | null }[]
  repos: readonly { id: string; prefix?: string | null }[]
  machines: readonly { id: string; name: string; loggedOutHarnesses: readonly string[] }[]
}): (T & SessionValues)[] {
  const users = new Map(homes.userStates.filter(row => row.userId === homes.userId).map(row => [row.sessionId, row]))
  const repos = new Map(homes.repos.map(row => [row.id, row]))
  const machines = new Map(homes.machines.map(row => [row.id, row]))
  return sessions.map(session => sessionView(session, {
    userState: users.get(session.sessionId ?? ''),
    repo: repos.get(session.refRepoId ?? ''),
    machine: machines.get(session.machineId ?? ''),
    handoffMachine: machines.get(session.handoffTargetMachineId ?? ''),
  }))
}
