import { companion, keyedComputed, lazy } from '@podium/mobx-helpers'
import type { IssueModel, SessionModel } from './models'
import { missions } from './mission'
import { isFinished } from './shared/predicates'
/** Mobile screen reads on the app-owned pool. No feed, replica, mutation owner,
 * world enumeration, peek reader, or independently maintained relationships. */
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type FlightDeckMode,
  issueAbandoned,
} from '@podium/client-core/values'
import {
  compareShallow, computed, type IComputedValue,
} from 'mobx'
import { ISSUE_BOARD_ENTITIES, ISSUE_BOARD_SOURCE_KEY } from './issue-board-schema'
import { createIssueBoardSource } from './issue-board-source'
import { MissionViewReader, type MissionViewValues, readMissionView } from './mission-view'
import {
  EMPTY_MOBILE_MISSION,
  MOBILE_SCREEN_ENTITIES,
  MOBILE_SCREEN_SOURCE_KEY,
  type MobileMissionData,
} from './mobile-screens-schema'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** Mobile selects structural roots, including an archived task or an empty
 * draft explicitly opened by its id. Web's sidebar visibility is separate. */
class MobileMissionReader extends MissionViewReader {
  override selectedRoot(id: string | null) {
    const rootId = this.rootFor(id)
    if (rootId === LOADING) return LOADING
    if (rootId) return this.issue(rootId)
    // A known cold row spends the shared load window. An unknown ID is
    // outside today's complete principal replica (POD-4286's contract).
    if (id && this.pool.row('issue', id) === LOADING) return LOADING
    return undefined
  }
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const requireRow = <T>(row: Loaded<T>): T | undefined => {
  if (row === LOADING) throw LOADING
  return row
}

function settled<T>(read: () => T): T | typeof LOADING {
  try { return read() } catch (error) {
    if (error === LOADING) return LOADING
    throw error
  }
}

/** Stabilize a fixed screen shape one field at a time. Collections compare
 * borrowed row identities, and scalar records (such as progress) one level.
 * Nested model values are never recursively compared on publication. */
function screenSnapshot<T extends object>(
  data: IComputedValue<T | typeof LOADING>,
  keys: readonly (keyof T)[],
  overrides: Partial<{ [K in keyof T]: IComputedValue<T[K] | typeof LOADING> }> = {},
  identities: readonly (keyof T)[] = [],
): IComputedValue<T | typeof LOADING> {
  const fields = keys.map(key => [key, overrides[key] ?? computed(() => {
    const value = data.get()
    return value === LOADING ? LOADING : value[key]
  }, { equals: identities.includes(key) ? Object.is : compareShallow })] as const)
  return computed(() => {
    const entries = fields.map(([key, field]) => [key, field.get()] as const)
    if (entries.some(([, value]) => value === LOADING)) return LOADING
    return Object.fromEntries(entries) as T
  }, { equals: compareShallow })
}

export function createMobileScreenReader(pool: MobxPool) {
  const mission = new MobileMissionReader(pool)
  // Factories live only while their screen is observed. Each field computed
  // borrows row identities or compares scalar values; publication never walks
  // into an issue, session, deck row or document.
  const cache = keyedComputed((key: string) => `MobileScreen@${key}`,
    (_key: string, create: () => IComputedValue<unknown>) => create())
  const stats = { mission: 0, deck: 0 }
  let disposed = false
  function memo<T>(key: string, create: () => IComputedValue<T | typeof LOADING>): T | typeof LOADING {
    return disposed ? LOADING : cache(key, create).get() as T | typeof LOADING
  }
  /** Phone-only roster and sheet references are independent lazy questions.
   * A displayed phase/label change cannot rewalk all mission attachments. */
  class PhoneMission {
    constructor(readonly issue: IssueModel) {}
    @lazy get members() { return requireRow(missions(pool).members(this.issue.id))! }
    @lazy get attached(): readonly SessionModel[] {
      const seats = new Map<string, SessionModel>()
      for (const member of this.members) {
        const attached = mission.attached(member)
        if (attached === LOADING) throw LOADING
        for (const seat of attached) seats.set(seat.sessionId, pool.sessionObject(seat.sessionId))
      }
      return [...seats.values()].sort(mission.sessionOrder)
    }
    @lazy get authors(): readonly SessionModel[] {
      const authors = new Map<string, SessionModel>()
      for (const member of this.members) {
        const id = pool.graph.one('issue', member, 'startedBy')
        if (!id || pool.graph.isCollapsed('session', id)) continue
        const session = requireRow(mission.session(id))
        if (session) authors.set(id, pool.sessionObject(id))
      }
      return [...authors.values()]
    }
    @lazy get sessions(): SessionModel[] {
      return [...new Map([...this.attached, ...this.authors].map(session => [session.sessionId, session])).values()].sort(mission.sessionOrder)
    }
    @lazy get crew(): SessionModel[] { return this.attached.filter(session => !session.archived) }
    @lazy get headerIssueIds(): ReadonlySet<string> {
      const ids = new Set<string>([this.issue.id])
      // The phone can pin any current crew session as its header, including
      // one on an archived member. Other hidden members stay on summaries.
      for (const session of this.crew) if (session.issueId) ids.add(session.issueId)
      return ids
    }
    @lazy get issues(): IssueViewModel[] {
      const issues = new Map<string, IssueViewModel>()
      for (const member of this.members) {
        const row = this.headerIssueIds.has(member) || mission.facts(member).visible
          ? requireRow(mission.issue(member))
          : requireRow(pool.row('issueBoardRow', member))
        if (row) issues.set(member, row)
      }
      // Authorship and sheet notes can refer outside the drawn mission.
      for (const row of [...issues.values()]) for (const dep of row.deps ?? []) {
        if (!issues.has(dep.id)) {
          const target = requireRow(pool.row('issueBoardRow', dep.id))
          if (target) issues.set(dep.id, target)
        }
      }
      return [...issues.values()].sort((a, b) => byId(a.id, b.id))
    }
  }
  const phoneMission = companion((issue: IssueModel) => new PhoneMission(issue))
  function deck(id: string | null, mode: FlightDeckMode): MissionViewValues | typeof LOADING {
    return memo(`deck:${id}:${mode}`, () => screenSnapshot(
      computed(() => settled(() => readDeck(id, mode))),
      ['root', 'rows', 'members', 'issueIds', 'deck', 'sessions', 'archivedCount', 'titles',
        'progress', 'departures', 'continuation', 'note', 'presence', 'rowPresentation'],
      {}, ['root', 'deck'],
    ))
  }
  function readDeck(id: string | null, mode: FlightDeckMode): MissionViewValues {
    stats.deck++
    const values = readMissionView(mission, id, mode)
    if (values === LOADING) throw LOADING
    let progress = values.progress
    if (values.root && (!mission.facts(values.root.id).visible)) {
      // Mobile can explicitly open a hidden root. The shared visible-root
      // meter's fallback must not resurrect it as a unit; accepted formal
      // children still count. Walk only this root's declared relation.
      const stack = [...pool.graph.many('issue', values.root.id, 'children')]
      const seen = new Set<string>([values.root.id])
      let accepted = false
      while (stack.length) {
        const childId = stack.pop()!
        if (seen.has(childId)) continue
        seen.add(childId)
        const child = requireRow(pool.row('issueBoardRow', childId))
        if (!child || !mission.facts(child.id).visible) continue
        if (child.stage !== 'proposed' && !issueAbandoned(child)) {
          accepted = true
          break
        }
        stack.push(...pool.graph.many('issue', childId, 'children'))
      }
      if (!accepted) progress = EMPTY_MOBILE_MISSION.progress
    }
    const presence = values.rows.some((row) => row.issue.id === values.root?.id)
      ? values.presence
      : null
    // The phone deck draws the mission's whole crew, archived included. The
    // shared pane carries seated senders only (its heartbeats never walk
    // history), so the phone adds every attached sender of the pane's issues,
    // as the pane once did itself.
    const sessions = values.deck ? [...values.deck.allSessions] : []
    return { ...values, progress, presence, sessions }
  }
  function readMission(id: string | null): MobileMissionData | typeof LOADING {
    return memo(`mission:${id}`, () => screenSnapshot(
      computed(() => settled(() => readMissionData(id))),
      ['root', 'issues', 'sessions', 'missionSessions', 'progress'],
      {}, ['root'],
    ))
  }
  function readMissionData(id: string | null): MobileMissionData {
    stats.mission++
    const values = deck(id, 'full')
    if (values === LOADING) throw LOADING
    if (!values.root) return EMPTY_MOBILE_MISSION
    const card = phoneMission(mission.facts(values.root.id))
    return {
      root: values.root,
      issues: card.issues,
      sessions: card.sessions as SessionView[],
      missionSessions: card.crew as SessionView[],
      progress: values.progress,
    }
  }
  return {
    stats,
    mission: readMission,
    deck,
    dispose() {
      disposed = true
      cache.clear()
      mission.dispose()
    },
  }
}

export async function attachMobileScreens(
  pool: MobxPool,
  owner?: Parameters<typeof createIssueBoardSource>[1],
) {
  await pool.sources.ensure(ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_ENTITIES, () =>
    createIssueBoardSource(pool, owner),
  )
  return pool.sources.ensure(MOBILE_SCREEN_SOURCE_KEY, MOBILE_SCREEN_ENTITIES, () => {
    const reader = createMobileScreenReader(pool)
    return {
      read: (entity: string) => (entity === 'mobileScreenReader' ? reader : undefined),
      dispose: () => reader.dispose(),
    }
  })
}
