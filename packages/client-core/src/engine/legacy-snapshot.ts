/**
 * The lazy legacy snapshot (POD-5426 spec §4.10, plan step 10; POD-5434).
 *
 * The legacy engine used to rebuild its replica-derived lists on every replica
 * batch: each changed kind materialised from the replica, the session views
 * over every session, the ledger's paint over the whole session and issue
 * lists. Pool screens read none of it. Once the pool attaches
 * (`enablePoolRuntimeWork`), those lists become STALE MARKS instead: a batch
 * records which lists it changed, and a list is rebuilt on its first read,
 * once per change. With no legacy screen mounted, nothing reads them, and a
 * batch does no whole-array work.
 *
 * Every reader keeps working unchanged, because the lists stay properties of
 * the runtime state: an accessor rebuilds a stale list before returning it.
 * Writes (the ledger's eager repaint while a write is in flight) go through
 * the same accessor and leave the list fresh.
 *
 * A rebuild never publishes. The batch that marked a list stale already
 * announced it as changed, so a rebuild only computes what that announcement
 * promised.
 */

import { dedupeSessionsByResume, isHeadlessSession, type SessionMeta } from '@podium/model'
import type { ReplicaKind } from '../replica/contract'
import type { EngineState } from './state'

/** Replica kinds published as-is: state key → replica kind. */
export const PLAIN_LIST_KINDS = {
  issueDeps: 'issueDeps',
  issueGitStates: 'issueGitStates',
  repoProjections: 'repos',
  issueEvents: 'issueEvents',
  pendingInteractions: 'pendingInteractions',
  messageRecords: 'messageRecords',
  shipOrders: 'shipOrders',
  shipLanes: 'shipLanes',
  conversations: 'conversations',
  automations: 'automations',
  automationRuns: 'automationRuns',
} as const satisfies Partial<Record<keyof EngineState, ReplicaKind>>

export type PlainListKey = keyof typeof PLAIN_LIST_KINDS
/** The lists the ledger paints. */
export type PaintedListKey = 'sessions' | 'issueProjections' | 'issueUserStates'
export type LazyListKey = PlainListKey | PaintedListKey

export const LAZY_LIST_KEYS: readonly LazyListKey[] = [
  'sessions',
  'issueProjections',
  'issueUserStates',
  ...(Object.keys(PLAIN_LIST_KINDS) as PlainListKey[]),
]

/**
 * Stale marks over the runtime state's replica-derived lists.
 *
 * The constructor turns each list into an accessor pair on the state object
 * itself, so a property read, a spread and a reaction's read all see a fresh
 * list. `rebuild(key)` must leave `key` fresh, through {@link LazyLists.fill}.
 *
 * Each list has a version, bumped when a batch changes it. A published
 * snapshot pins the versions it was built at ({@link LazyLists.snapshot}), so a
 * reader holding an older snapshot still gets that snapshot's list: the value
 * last built is kept until the next change. A list that changed again before
 * anyone built it has no value at the older version to give; such a read gets
 * the current list.
 */
export class LazyLists {
  private readonly values = new Map<LazyListKey, unknown>()
  private readonly stale = new Set<LazyListKey>()
  private readonly versions = new Map<LazyListKey, number>()
  /** The value each list had before its last change, if it had been built. */
  private readonly previous = new Map<LazyListKey, { version: number; value: unknown }>()

  constructor(
    state: EngineState,
    private readonly rebuild: (key: LazyListKey) => void,
  ) {
    for (const key of LAZY_LIST_KEYS) {
      this.values.set(key, state[key])
      this.versions.set(key, 0)
      Object.defineProperty(state, key, {
        configurable: true,
        enumerable: true,
        get: () => this.get(key),
        set: (value: unknown) => this.set(key, value),
      })
    }
  }

  get(key: LazyListKey): unknown {
    if (this.stale.has(key)) {
      this.rebuild(key)
      // A rebuild that failed to produce the list must not loop on every read.
      this.stale.delete(key)
    }
    return this.values.get(key)
  }

  /** An eager write (the ledger's repaint while a write is in flight): a
   *  change of its own, so older snapshots keep what they had. */
  set(key: LazyListKey, value: unknown): void {
    if (this.stale.has(key)) this.versions.set(key, this.version(key) + 1)
    else if (!Object.is(this.values.get(key), value)) this.bump(key)
    this.values.set(key, value)
    this.stale.delete(key)
  }

  /** A stale list's rebuild: the value its mark promised, no new version. */
  fill(key: LazyListKey, value: unknown): void {
    this.values.set(key, value)
    this.stale.delete(key)
  }

  markStale(key: LazyListKey): void {
    if (!this.stale.has(key)) this.bump(key)
    else this.versions.set(key, this.version(key) + 1)
    this.stale.add(key)
  }

  isStale(key: LazyListKey): boolean {
    return this.stale.has(key)
  }

  private version(key: LazyListKey): number {
    return this.versions.get(key) ?? 0
  }

  /** Keep the built value of the version that is ending. */
  private bump(key: LazyListKey): void {
    const version = this.version(key)
    this.previous.set(key, { version, value: this.values.get(key) })
    this.versions.set(key, version + 1)
  }

  /**
   * Define the lazy lists on a snapshot `target`, as of now: each reads its
   * list when read, and only that list. Plain keys are the caller's.
   */
  snapshot(target: object): void {
    for (const key of LAZY_LIST_KEYS) {
      const pinned = this.version(key)
      Object.defineProperty(target, key, {
        configurable: false,
        enumerable: true,
        get: () => {
          if (this.version(key) === pinned) return this.get(key)
          const kept = this.previous.get(key)
          return kept?.version === pinned ? kept.value : this.get(key)
        },
      })
    }
  }
}

/** A session row as the replica holds it. */
type RawSession = SessionMeta

/** The resume group a row's dedupe is decided in, if any (`dedupeSessionsByResume`
 *  never groups a headless row or one without a resume ref). */
function resumeGroup(row: RawSession | undefined): string | undefined {
  if (row?.resume === undefined || isHeadlessSession(row)) return undefined
  return JSON.stringify([row.resume.kind, row.resume.value])
}

/**
 * The replica's session rows by id, kept by addressed batches: the "before"
 * the topology check needs, without building the list. One pointer per
 * session, plus the ids of each resume group; each batch costs its own rows.
 *
 * TOPOLOGY is what pool mode's session reactions follow (`runtime.ts`,
 * `sessionTopologyChanged`): the list's membership and order, and each row's
 * `cwd` and `issueId`. Membership is more than presence: `dedupeSessions`
 * shows one row of a parked resume group, chosen by status and activity. So
 * a batch that touches a grouped row re-decides that group, before and after,
 * and compares which rows show. Over-reporting only re-runs idempotent
 * reactions; under-reporting would miss a rehome.
 */
export class SessionTopology {
  private rows = new Map<string, RawSession>()
  private groups = new Map<string, Set<string>>()

  constructor(private readonly read: () => readonly RawSession[]) {
    this.reseed()
  }

  /** A bootstrap or rescope replaced the slice: start over from it. */
  reseed(): void {
    this.rows = new Map()
    this.groups = new Map()
    for (const row of this.read()) this.put(row.sessionId as string, row)
  }

  /** Record the addressed rows' new values; true when one moved the topology. */
  update(ids: Iterable<string>, row: (id: string) => RawSession | undefined): boolean {
    let moved = false
    const touched = new Set<string>()
    const changes: [string, RawSession | undefined][] = []
    for (const id of ids) {
      const prev = this.rows.get(id)
      const next = row(id)
      if (prev === next) continue
      if (
        prev === undefined ||
        next === undefined ||
        prev.cwd !== next.cwd ||
        prev.issueId !== next.issueId
      )
        moved = true
      for (const group of [resumeGroup(prev), resumeGroup(next)])
        if (group !== undefined) touched.add(group)
      changes.push([id, next])
    }
    const before = moved ? [] : [...touched].map((group) => this.shown(group))
    for (const [id, next] of changes) this.put(id, next)
    if (!moved) moved = [...touched].some((group, at) => this.shown(group) !== before[at])
    return moved
  }

  private put(id: string, next: RawSession | undefined): void {
    const prev = this.rows.get(id)
    const from = resumeGroup(prev)
    const to = resumeGroup(next)
    if (from !== to && from !== undefined) {
      const members = this.groups.get(from)
      members?.delete(id)
      if (members?.size === 0) this.groups.delete(from)
    }
    if (to !== undefined) {
      const members = this.groups.get(to) ?? new Set<string>()
      this.groups.set(to, members)
      members.add(id)
    }
    if (next === undefined) this.rows.delete(id)
    else this.rows.set(id, next)
  }

  /** The ids `dedupeSessions` shows of one group, in list order. */
  private shown(group: string): string {
    const rows = [...(this.groups.get(group) ?? [])].sort().map((id) => this.rows.get(id)!)
    return dedupeSessionsByResume(rows)
      .map((session) => session.sessionId)
      .join('\n')
  }
}

/** The issue fields a workspace's membership reads: `workspaceMembership`
 *  (state.ts) and the mission rules it asks (`missionParentId`,
 *  `hasLeftMission`, the started-by-session fallback, viewmodels/mission.ts). */
export const MEMBERSHIP_FIELDS = [
  'parentId',
  'archived',
  'deletedAt',
  'startedBySession',
  'stage',
  'worktreePath',
] as const
type MembershipRow = Partial<Record<(typeof MEMBERSHIP_FIELDS)[number], unknown>>

function membershipSignature(row: MembershipRow | undefined): string {
  return row === undefined
    ? ''
    : JSON.stringify(MEMBERSHIP_FIELDS.map((field) => row[field] ?? null))
}

export interface MembershipPorts {
  /** The open workspaces' keys (`issue:<id>`, `mission:<root>`, …). */
  workspaceKeys(): readonly string[]
  /** A mission's members as the pool knew them before this batch. */
  members(root: string): ReadonlySet<string> | 'loading'
  /** An issue's replica row now. */
  issue(id: string): MembershipRow | undefined
  /** A session's issue now. */
  sessionIssue(sessionId: string): string | undefined
}

/**
 * Could a batch of issue rows move an OPEN workspace's membership? That is
 * what `workspaceMembershipDirty` asks before the next session batch prunes
 * every workspace over every session; the eager path answered yes for any
 * issue change.
 *
 * An issue matters to a workspace if it is the workspace's issue, or a member
 * or the root of its mission, or joins it now (its parent or its starting
 * session is in the mission). For those it compares the membership fields
 * with what it saw before: a title, a note or a marker moves nothing. The
 * "before" is kept only for the issues of open workspaces, seeded from the
 * replica the first time a mission's member set is seen. Any doubt is a yes.
 */
export class IssueMembershipWatch {
  private seen = new Map<string, string>()
  private seededMembers = new WeakSet<ReadonlySet<string>>()
  private keys = ''

  constructor(private readonly ports: MembershipPorts) {}

  /** Did these replica rows move a membership field of an issue that
   *  matters to an open workspace? */
  moved(ids: ReadonlySet<string>): boolean {
    const relevant = this.relevant(ids)
    let moved = relevant === 'loading'
    for (const id of ids) {
      if (relevant !== 'loading' && !relevant.has(id)) {
        this.seen.delete(id)
        continue
      }
      const next = membershipSignature(this.ports.issue(id))
      if (this.seen.get(id) !== next) moved = true
      this.seen.set(id, next)
    }
    return moved
  }

  /** Record the open workspaces' issues now, before any batch changes one:
   *  an issue first seen in the batch that changes it has no "before". */
  prime(): void {
    this.relevant(new Set())
  }

  /** Does any of these issues matter to an open workspace? */
  touches(ids: ReadonlySet<string>): boolean {
    const relevant = this.relevant(ids)
    return relevant === 'loading' || relevant.size > 0
  }

  private relevant(ids: ReadonlySet<string>): Set<string> | 'loading' {
    const keys = this.ports.workspaceKeys()
    const joined = keys.join('\n')
    if (joined !== this.keys) {
      // Another set of workspaces: what was seen belongs to the old one.
      this.keys = joined
      this.seen = new Map()
      this.seededMembers = new WeakSet()
    }
    const relevant = new Set<string>()
    let loading = false
    const remember = (id: string): void => {
      if (!ids.has(id) && !this.seen.has(id))
        this.seen.set(id, membershipSignature(this.ports.issue(id)))
    }
    for (const key of keys) {
      if (key.startsWith('issue:')) {
        const id = key.slice(6)
        remember(id)
        if (ids.has(id)) relevant.add(id)
        continue
      }
      if (!key.startsWith('mission:')) continue
      const root = key.slice(8)
      const members = this.ports.members(root)
      if (members === 'loading') {
        loading = true
        continue
      }
      if (!this.seededMembers.has(members)) {
        this.seededMembers.add(members)
        remember(root)
        for (const id of members) remember(id)
      }
      const inMission = (id: unknown): boolean =>
        typeof id === 'string' && (id === root || members.has(id))
      for (const id of ids) {
        if (inMission(id)) {
          relevant.add(id)
          continue
        }
        const row = this.ports.issue(id)
        const started = row?.startedBySession
        if (
          inMission(row?.parentId) ||
          (typeof started === 'string' && inMission(this.ports.sessionIssue(started)))
        )
          relevant.add(id)
      }
    }
    return loading ? 'loading' : relevant
  }
}
