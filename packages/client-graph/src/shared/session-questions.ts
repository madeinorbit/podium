import { attentionGroup } from '@podium/client-core/focus'
import type { SessionView } from '@podium/client-core/session-values'
import { createKeyedAnswer, type KeyedAnswer } from '../query-result'
import type { SessionActivityQuestion } from './session-activity'

type Row = Readonly<Record<string, unknown>>
type Excluded = Pick<ReadonlySet<string>, 'has'>
export interface TriageSession { id: string; rank: number; at: string; createdAt: string }
export interface MachineSession { id: string; machineId: string; createdAt: string; order: string }
interface TimedTriageSession extends TriageSession { deadline: number }
interface RecentSession { id: string; at: string }
interface Activity { id: string; at: number }
export interface SessionQuestionFacts {
  id: string
  rank: number | null
  at: string
  activity: string
  createdAt: string
  machineId?: string
  cwd: string
  snooze: string
  deadline: number
  archived: boolean
  order: string
}
interface Bucket<T> { id: string; answer: KeyedAnswer<T> }
interface Seed {
  facts: KeyedAnswer<SessionQuestionFacts>
  triage: KeyedAnswer<TriageSession>
  recent: KeyedAnswer<RecentSession>
  machines: KeyedAnswer<Bucket<MachineSession>>
  activities: KeyedAnswer<Bucket<Activity>>
  revisions: KeyedAnswer<number>
  future: KeyedAnswer<TimedTriageSession>
  expired: KeyedAnswer<TimedTriageSession>
  version: number
  replacement: number
}
export interface SessionQuestions {
  readonly visits: number
  readonly activityVisits: number
  clear(): void
  fork(collapsed: (id: string) => boolean, order: (id: string) => string): SessionQuestions
  set(id: string, row: Row | undefined): void
  setFacts(id: string, value: SessionQuestionFacts | undefined): void
  fact(id: string): SessionQuestionFacts | undefined
  visibilityChanged(id: string): void
  triageFact(id: string, now: number): TriageSession | undefined
  machineFact(id: string): MachineSession | undefined
  machineRevision(ids: readonly string[]): number
  recent(excluded?: Excluded): RecentSession | undefined
  recentRevision(): number
  next(after: TriageSession | undefined, now: number, excluded?: Excluded): TriageSession | undefined
  latest(machineIds: readonly string[], excluded?: Excluded): MachineSession | undefined
  activity(question: SessionActivityQuestion): number
  activityRevision(question: SessionActivityQuestion): number
}
export const compareTriageSessions = (a: TriageSession, b: TriageSession) =>
  a.rank - b.rank || b.at.localeCompare(a.at) ||
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
export const compareMachineSessions = (a: MachineSession, b: MachineSession) =>
  a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 :
    a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const compareRecent = (a: RecentSession, b: RecentSession) =>
  a.at > b.at ? -1 : a.at < b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const compareActivity = (a: Activity, b: Activity) => b.at - a.at
function paths(cwd: string): string[] {
  const out = new Set([`exact:${cwd}`, `within:${cwd}`])
  for (let at = cwd.indexOf('/'); at >= 0; at = cwd.indexOf('/', at + 1)) out.add(`within:${cwd.slice(0, at)}`)
  return [...out]
}
function same(a: SessionQuestionFacts | undefined, b: SessionQuestionFacts | undefined): boolean {
  return a === b || (!!a && !!b && a.rank === b.rank && a.at === b.at &&
    a.activity === b.activity && a.createdAt === b.createdAt && a.machineId === b.machineId &&
    a.cwd === b.cwd && a.snooze === b.snooze && a.archived === b.archived && a.order === b.order)
}

/** Persistent declared scalar questions. Source and pool share immutable
 * branches; resident edits replace addressed contributions without excluding
 * entire histories during a lookup. */
export function createSessionQuestions(
  collapsed: (id: string) => boolean,
  order: (id: string) => string = id => id,
  seed?: Seed,
): SessionQuestions {
  let facts = seed?.facts.fork() ?? createKeyedAnswer<SessionQuestionFacts>()
  let triage = seed?.triage.fork() ?? createKeyedAnswer<TriageSession>(compareTriageSessions)
  let recent = seed?.recent.fork() ?? createKeyedAnswer<RecentSession>(compareRecent)
  let machines = seed?.machines.fork() ?? createKeyedAnswer<Bucket<MachineSession>>()
  let activities = seed?.activities.fork() ?? createKeyedAnswer<Bucket<Activity>>()
  let revisions = seed?.revisions.fork() ?? createKeyedAnswer<number>()
  let future = seed?.future.fork() ?? createKeyedAnswer<TimedTriageSession>(compareTriageSessions, value => value.deadline)
  let expired = seed?.expired.fork() ?? createKeyedAnswer<TimedTriageSession>(compareTriageSessions, value => value.deadline)
  let version = seed?.version ?? 0, replacement = seed?.replacement ?? 0
  let visits = 0, activityVisits = 0
  const touch = (key: string) => revisions.set(key, key, ++version)
  function bucket<T>(collection: KeyedAnswer<Bucket<T>>, key: string, id: string,
    next: T | undefined, compare: (a: T, b: T) => number) {
    const before = collection.get(key), previous = before?.answer.get(id)
    if (previous && next && compare(previous, next) === 0) return
    if (previous === next) return
    const answer = before?.answer.fork() ?? createKeyedAnswer<T>(compare)
    if (next) answer.set(id, '', next)
    else answer.delete(id)
    if (answer.first()) collection.set(key, key, { id: key, answer })
    else collection.delete(key)
    touch(key)
  }
  function file(value: SessionQuestionFacts) {
    const visible = !collapsed(value.id)
    const next = value.rank === null || !visible ? undefined : {
      id: value.id, rank: value.rank, createdAt: value.createdAt, at: value.at,
    }
    const timed = value.snooze > value.at && Number.isFinite(value.deadline)
    if (next && timed) {
      triage.delete(value.id)
      future.set(value.id, '', { ...next, deadline: value.deadline })
      expired.set(value.id, '', { ...next, at: value.snooze, deadline: value.deadline })
    } else {
      future.delete(value.id)
      expired.delete(value.id)
      if (next) triage.set(value.id, '', next)
      else triage.delete(value.id)
    }
    const recency = value.archived ? undefined : { id: value.id, at: value.activity }
    const beforeRecent = recent.get(value.id)
    if (beforeRecent !== recency && !(beforeRecent && recency && compareRecent(beforeRecent, recency) === 0)) {
      if (recency) recent.set(value.id, '', recency)
      else recent.delete(value.id)
      touch('recent')
    }
    if (value.machineId) bucket(machines, `machine:${value.machineId}`, value.id,
      visible ? { id: value.id, machineId: value.machineId, createdAt: value.createdAt, order: value.order } : undefined,
      compareMachineSessions)
    for (const path of paths(value.cwd)) bucket(activities, `activity:${path}`, value.id,
      visible ? { id: value.id, at: Date.parse(value.activity) || 0 } : undefined, compareActivity)
  }
  function setFacts(id: string, next: SessionQuestionFacts | undefined) {
    const before = facts.get(id)
    if (same(before, next)) return
    if (before?.machineId && before.machineId !== next?.machineId)
      bucket(machines, `machine:${before.machineId}`, id, undefined, compareMachineSessions)
    const nextPaths = next ? new Set(paths(next.cwd)) : undefined
    if (before) for (const path of paths(before.cwd))
      if (!nextPaths?.has(path)) bucket(activities, `activity:${path}`, id, undefined, compareActivity)
    future.delete(id)
    expired.delete(id)
    if (!next) {
      facts.delete(id)
      triage.delete(id)
      if (recent.has(id)) { recent.delete(id); touch('recent') }
      return
    }
    facts.set(id, id, next)
    file(next)
  }
  return {
    get visits() { return visits },
    get activityVisits() { return activityVisits },
    fork: (isCollapsed, orderKey) => createSessionQuestions(isCollapsed, orderKey,
      { facts, triage, recent, machines, activities, revisions, future, expired, version, replacement }),
    clear() {
      facts = createKeyedAnswer<SessionQuestionFacts>()
      triage = createKeyedAnswer<TriageSession>(compareTriageSessions)
      recent = createKeyedAnswer<RecentSession>(compareRecent)
      machines = createKeyedAnswer<Bucket<MachineSession>>()
      activities = createKeyedAnswer<Bucket<Activity>>()
      revisions = createKeyedAnswer<number>()
      future = createKeyedAnswer<TimedTriageSession>(compareTriageSessions, value => value.deadline)
      expired = createKeyedAnswer<TimedTriageSession>(compareTriageSessions, value => value.deadline)
      replacement = ++version
    },
    set(id, row) {
      if (!row) { setFacts(id, undefined); return }
      const group = attentionGroup(row as unknown as SessionView)
      const activity = String(row.lastActiveAt ?? ''), draft = String(row.draftUpdatedAt ?? '')
      setFacts(id, {
        id, rank: row.archived || row.headless || row.agentKind === 'shell' ? null : group === 'needsYou' ? 0 : group === 'idle' ? 1 : 2,
        at: draft > activity ? draft : activity, activity, createdAt: String(row.createdAt ?? ''),
        machineId: typeof row.machineId === 'string' ? row.machineId : undefined,
        cwd: String(row.cwd ?? ''), archived: !!row.archived,
        snooze: typeof row.snoozedUntil === 'string' ? row.snoozedUntil : '',
        deadline: Date.parse(String(row.snoozedUntil ?? '')), order: order(id),
      })
    },
    setFacts,
    fact: id => facts.get(id),
    visibilityChanged(id) {
      const value = facts.get(id)
      if (!value) return
      const next = { ...value, order: order(id) }
      facts.set(id, id, next)
      file(next)
    },
    triageFact(id, now) {
      const value = facts.get(id)
      return value && value.rank !== null && !collapsed(id) ? {
        id, rank: value.rank, createdAt: value.createdAt,
        at: value.deadline <= now && value.snooze > value.at ? value.snooze : value.at,
      } : undefined
    },
    machineFact(id) {
      const value = facts.get(id)
      return value?.machineId ? machines.get(`machine:${value.machineId}`)?.answer.get(id) : undefined
    },
    machineRevision: ids => Math.max(replacement, ...ids.map(id => revisions.get(`machine:${id}`) ?? 0)),
    recent(excluded) {
      let value = recent.first()
      while (value && excluded?.has(value.id)) { visits++; value = recent.after(value, value.id) }
      if (value) visits++
      return value
    },
    recentRevision: () => Math.max(replacement, revisions.get('recent') ?? 0),
    next(after, now, excluded) {
      const pivot = after && { ...after, deadline: 0 }
      const candidates = [after ? triage.after(after, after.id) : triage.first(),
        future.firstBounded(now, 'above', pivot, after?.id),
        expired.firstBounded(now, 'atMost', pivot, after?.id)]
      // Explicit exclusions are caller demand, never the pool's resident set.
      for (let n = 0; n < candidates.length; n++) {
        let value = candidates[n]
        while (value && excluded?.has(value.id)) {
          visits++
          value = n === 0 ? triage.after(value, value.id) :
            (n === 1 ? future : expired).firstBounded(now, n === 1 ? 'above' : 'atMost',
              { ...value, deadline: 0 }, value.id)
        }
        candidates[n] = value
        if (value) visits++
      }
      let next: TriageSession | undefined
      for (const value of candidates) if (value && (!next || compareTriageSessions(value, next) < 0)) next = value
      return next
    },
    latest(ids, excluded) {
      let newest: MachineSession | undefined
      for (const id of ids) {
        const answer = machines.get(`machine:${id}`)?.answer
        let value = answer?.first()
        while (value && excluded?.has(value.id)) { visits++; value = answer?.after(value, value.id) }
        if (value) {
          visits++
          if (!newest || compareMachineSessions(value, newest) < 0) newest = value
        }
      }
      return newest
    },
    activity(question) {
      const excluded = question.excluded && 'has' in question.excluded ? question.excluded : new Set(question.excluded)
      let maximum = 0
      for (const root of question.roots) {
        const answer = activities.get(`activity:${question.match ?? 'within'}:${root}`)?.answer
        let value = answer?.first()
        while (value && excluded.has(value.id)) { activityVisits++; value = answer?.after(value, value.id) }
        if (value) { activityVisits++; maximum = Math.max(maximum, value.at) }
      }
      return maximum
    },
    activityRevision: question => Math.max(replacement,
      ...question.roots.map(root => revisions.get(`activity:${question.match ?? 'within'}:${root}`) ?? 0)),
  }
}
