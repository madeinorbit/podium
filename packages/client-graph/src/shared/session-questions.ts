import { attentionGroup } from '@podium/client-core/focus'
import type { SessionView } from '@podium/client-core/session-values'
import { type IssueCloseMemberCounts, isSessionWorking } from '@podium/client-core/values'
import { machinePathAncestors, machinePathKey, machinePathSeparator } from '@podium/model/browser'
import { createKeyedAnswer, createKeyedAnswerBuilder, type KeyedAnswer } from '../query-result'
import type { SessionActivityQuestion } from './session-activity'
import { sessionReferenceKey } from './session-reference'

type Row = Readonly<Record<string, unknown>>
type Excluded = Pick<ReadonlySet<string>, 'has'>
export interface TriageSession { id: string; rank: number; at: string; createdAt: string }
export interface MachineSession { id: string; machineId: string; createdAt: string; order: string }
interface TimedTriageSession extends TriageSession { deadline: number }
interface RecentSession { id: string; at: string }
interface SetupAgent { id: string; at: string; setupOrder: number; agentKind: string }
interface Activity { id: string; at: number }
interface CloseMember extends IssueCloseMemberCounts { issueId: string }
interface ReferenceSession { id: string; order: string }
const NO_CLOSE_MEMBERS: IssueCloseMemberCounts = Object.freeze({ offers: 0, working: 0 })
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
  issueId?: string
  closeOffers: boolean
  closeWorking: boolean
  referenceKey?: string
  agentKind: string
  headless: boolean
  setupOrder: number
}
interface Bucket<T> { id: string; answer: KeyedAnswer<T> }
interface FiledSessionFacts extends SessionQuestionFacts {
  activityPaths: readonly string[]
}
interface Seed {
  facts: KeyedAnswer<FiledSessionFacts>
  triage: KeyedAnswer<TriageSession>
  recent: KeyedAnswer<RecentSession>
  machines: KeyedAnswer<Bucket<MachineSession>>
  activities: KeyedAnswer<Bucket<Activity>>
  revisions: KeyedAnswer<number>
  future: KeyedAnswer<TimedTriageSession>
  expired: KeyedAnswer<TimedTriageSession>
  closeMembers: KeyedAnswer<CloseMember>
  closeCounts: KeyedAnswer<IssueCloseMemberCounts>
  references: KeyedAnswer<Bucket<ReferenceSession>>
  setupAgents: KeyedAnswer<SetupAgent>
  setupMembers: KeyedAnswer<boolean>
  setupCount: number
  version: number
  replacement: number
}
export interface SessionQuestions {
  readonly updates: Readonly<Record<'close' | 'setupCount' | 'setupAgent' | 'reference' | 'triage' | 'recent' | 'machine' | 'activity', number>>
  readonly visits: number
  readonly activityVisits: number
  readonly activityPathsBuilt: number
  clear(): void
  /** Replace unpublished bootstrap facts, then expose ordinary persistent answers. */
  replace(rows: Iterable<readonly [string, Row | undefined]>): void
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
  issueCloseCounts(issueId: string): IssueCloseMemberCounts
  referenceId(ref: string): string | undefined
  hasWithin(path: string): boolean
  present(id: string): boolean
  setupAgent(): string | undefined
  setupCount(): number
  setupRevision(kind: 'agent' | 'count'): number
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
const compareReference = (a: ReferenceSession, b: ReferenceSession) =>
  a.order < b.order ? -1 : a.order > b.order ? 1 : a.id.localeCompare(b.id)
const compareSetupAgent = (a: SetupAgent, b: SetupAgent) =>
  a.at > b.at ? -1 : a.at < b.at ? 1 : a.setupOrder - b.setupOrder || a.id.localeCompare(b.id)
function paths(cwd: string): string[] {
  if (machinePathSeparator(cwd) === '\\') return [`exact:${machinePathKey(cwd)}`, ...machinePathAncestors(machinePathKey(cwd)).map(path => `within:${path}`)]
  const out = new Set([`exact:${cwd}`, `within:${cwd}`])
  for (let at = cwd.indexOf('/'); at >= 0; at = cwd.indexOf('/', at + 1)) out.add(`within:${cwd.slice(0, at)}`)
  return [...out]
}
function same(a: SessionQuestionFacts | undefined, b: SessionQuestionFacts | undefined): boolean {
  return a === b || (!!a && !!b && a.rank === b.rank && a.at === b.at &&
    a.activity === b.activity && a.createdAt === b.createdAt && a.machineId === b.machineId &&
    a.cwd === b.cwd && a.snooze === b.snooze && a.archived === b.archived && a.order === b.order &&
    a.issueId === b.issueId && a.closeOffers === b.closeOffers && a.closeWorking === b.closeWorking && a.referenceKey === b.referenceKey &&
    a.agentKind === b.agentKind && a.headless === b.headless && a.setupOrder === b.setupOrder)
}

/** Persistent declared scalar questions. Source and pool share immutable
 * branches; resident edits replace addressed contributions without excluding
 * entire histories during a lookup. */
export function createSessionQuestions(
  collapsed: (id: string) => boolean,
  order: (id: string) => string = id => id,
  seed?: Seed,
  setupOrder: (id: string) => number = () => 0,
): SessionQuestions {
  let facts = seed?.facts.fork() ?? createKeyedAnswer<FiledSessionFacts>()
  let triage = seed?.triage.fork() ?? createKeyedAnswer<TriageSession>(compareTriageSessions)
  let recent = seed?.recent.fork() ?? createKeyedAnswer<RecentSession>(compareRecent)
  let machines = seed?.machines.fork() ?? createKeyedAnswer<Bucket<MachineSession>>()
  let activities = seed?.activities.fork() ?? createKeyedAnswer<Bucket<Activity>>()
  let revisions = seed?.revisions.fork() ?? createKeyedAnswer<number>()
  let future = seed?.future.fork() ?? createKeyedAnswer<TimedTriageSession>(compareTriageSessions, value => value.deadline)
  let expired = seed?.expired.fork() ?? createKeyedAnswer<TimedTriageSession>(compareTriageSessions, value => value.deadline)
  let closeMembers = seed?.closeMembers.fork() ?? createKeyedAnswer<CloseMember>()
  let closeCounts = seed?.closeCounts.fork() ?? createKeyedAnswer<IssueCloseMemberCounts>()
  let references = seed?.references.fork() ?? createKeyedAnswer<Bucket<ReferenceSession>>()
  let setupAgents = seed?.setupAgents.fork() ?? createKeyedAnswer<SetupAgent>(compareSetupAgent)
  let setupMembers = seed?.setupMembers.fork() ?? createKeyedAnswer<boolean>()
  let setupCount = seed?.setupCount ?? 0
  let version = seed?.version ?? 0, replacement = seed?.replacement ?? 0
  let visits = 0, activityVisits = 0, activityPathsBuilt = 0
  const updates = { close: 0, setupCount: 0, setupAgent: 0, reference: 0, triage: 0, recent: 0, machine: 0, activity: 0 }
  let building = false
  let builders: (() => unknown)[] = []
  function newAnswer<T>(compare?: (a: T, b: T) => number, point?: (value: T) => number): KeyedAnswer<T> {
    if (!building) return createKeyedAnswer(compare, point)
    const builder = createKeyedAnswerBuilder(compare, point)
    builders.push(builder.finish)
    return builder.answer
  }
  const touch = (key: string) => revisions.set(key, key, ++version)
  function fileSetupCount(id: string, visible: boolean) {
    updates.setupCount++
    if (setupMembers.has(id) !== visible) {
      if (visible) { setupMembers.set(id, id, true); setupCount++ }
      else { setupMembers.delete(id); setupCount-- }
      touch('setup:count')
    }
  }
  function fileSetupAgent(id: string, value: SessionQuestionFacts | undefined, visible: boolean) {
    updates.setupAgent++
    const next = visible && value && value.agentKind !== 'shell' && !value.headless
      ? { id, at: value.activity, setupOrder: value.setupOrder, agentKind: value.agentKind } : undefined
    const before = setupAgents.get(id)
    if (before && next && compareSetupAgent(before, next) === 0 && before.agentKind === next.agentKind) return
    if (before === next) return
    const winner = setupAgents.first()
    if (next) setupAgents.set(id, '', next)
    else setupAgents.delete(id)
    const after = setupAgents.first()
    if (winner?.agentKind !== after?.agentKind) touch('setup:agent')
  }
  function activityPaths(value: SessionQuestionFacts): string[] {
    activityPathsBuilt++
    const cwdPaths = paths(value.cwd)
    const keys = cwdPaths.map(path => `activity:${path}`)
    return value.agentKind === 'shell' ? keys : [...keys, ...cwdPaths.map(path => `agentActivity:${path}`)]
  }
  function fileClose(id: string, value: SessionQuestionFacts | undefined) {
    updates.close++
    const previous = closeMembers.get(id)
    const next = value?.issueId && !collapsed(id) && (value.closeOffers || value.closeWorking)
      ? { issueId: value.issueId, offers: Number(value.closeOffers), working: Number(value.closeWorking) }
      : undefined
    if (previous?.issueId === next?.issueId && previous?.offers === next?.offers && previous?.working === next?.working) return
    const change = (member: CloseMember, sign: 1 | -1) => {
      const before = closeCounts.get(member.issueId) ?? NO_CLOSE_MEMBERS
      const after = { offers: before.offers + sign * member.offers, working: before.working + sign * member.working }
      if (after.offers || after.working) closeCounts.set(member.issueId, member.issueId, after)
      else closeCounts.delete(member.issueId)
    }
    if (previous) change(previous, -1)
    if (next) { change(next, 1); closeMembers.set(id, id, next) }
    else closeMembers.delete(id)
  }
  function bucket<T>(collection: KeyedAnswer<Bucket<T>>, key: string, id: string,
    next: T | undefined, compare: (a: T, b: T) => number) {
    const before = collection.get(key), previous = before?.answer.get(id)
    if (previous && next && compare(previous, next) === 0) return
    if (previous === next) return
    const answer = (building ? before?.answer : before?.answer.fork()) ?? newAnswer<T>(compare)
    if (next) answer.set(id, '', next)
    else answer.delete(id)
    if (next || answer.first()) collection.set(key, key, { id: key, answer })
    else collection.delete(key)
    touch(key)
  }
  /** Each declared answer reads only these scalar inputs. Presence and source
   * visibility changes re-file their contributions; payload edits do not. */
  function file(id: string, value: FiledSessionFacts | undefined, before?: FiledSessionFacts, visibilityChanged = false) {
    const presence = !before || !value
    const membership = presence || visibilityChanged
    const visible = value !== undefined && !collapsed(id)
    if (membership || before.issueId !== value.issueId ||
      before.closeOffers !== value.closeOffers || before.closeWorking !== value.closeWorking)
      fileClose(id, value)
    if (membership) fileSetupCount(id, visible)
    if (membership || before.activity !== value.activity || before.agentKind !== value.agentKind ||
      before.headless !== value.headless || before.setupOrder !== value.setupOrder)
      fileSetupAgent(id, value, visible)
    if (membership || before.referenceKey !== value.referenceKey || before.order !== value.order) {
      updates.reference++
      if (before?.referenceKey && before.referenceKey !== value?.referenceKey)
        bucket(references, `ref:${before.referenceKey}`, id, undefined, compareReference)
      if (value?.referenceKey) bucket(references, `ref:${value.referenceKey}`, id,
        visible ? { id, order: value.order } : undefined, compareReference)
    }
    if (membership || before.rank !== value.rank || before.at !== value.at ||
      before.createdAt !== value.createdAt || before.snooze !== value.snooze ||
      !Object.is(before.deadline, value.deadline)) {
      updates.triage++
      const next = !value || value.rank === null || !visible ? undefined : {
        id, rank: value.rank, createdAt: value.createdAt, at: value.at,
      }
      const timed = value && value.snooze > value.at && Number.isFinite(value.deadline)
      if (next && timed) {
        triage.delete(id)
        future.set(id, '', { ...next, deadline: value.deadline })
        expired.set(id, '', { ...next, at: value.snooze, deadline: value.deadline })
      } else {
        future.delete(id)
        expired.delete(id)
        if (next) triage.set(id, '', next)
        else triage.delete(id)
      }
    }
    if (presence || before.archived !== value.archived || before.activity !== value.activity) {
      updates.recent++
      const recency = !value || value.archived ? undefined : { id, at: value.activity }
      const beforeRecent = recent.get(id)
      if (beforeRecent !== recency && !(beforeRecent && recency && compareRecent(beforeRecent, recency) === 0)) {
        if (recency) recent.set(id, '', recency)
        else recent.delete(id)
        touch('recent')
      }
    }
    if (membership || before.machineId !== value.machineId ||
      before.createdAt !== value.createdAt || before.order !== value.order) {
      updates.machine++
      if (before?.machineId && before.machineId !== value?.machineId)
        bucket(machines, `machine:${before.machineId}`, id, undefined, compareMachineSessions)
      if (value?.machineId) bucket(machines, `machine:${value.machineId}`, id,
        visible ? { id, machineId: value.machineId, createdAt: value.createdAt, order: value.order } : undefined,
        compareMachineSessions)
    }
    if (membership || before.activity !== value.activity || before.activityPaths !== value.activityPaths) {
      updates.activity++
      if (before && before.activityPaths !== value?.activityPaths) {
        const remaining = new Set(value?.activityPaths)
        for (const path of before.activityPaths)
          if (!remaining.has(path)) bucket(activities, path, id, undefined, compareActivity)
      }
      const at = Date.parse(value?.activity ?? '') || 0
      for (const path of value?.activityPaths ?? []) bucket(activities, path, id,
        visible ? { id, at } : undefined, compareActivity)
    }
  }
  function setFacts(id: string, next: SessionQuestionFacts | undefined) {
    const before = facts.get(id)
    if (same(before, next)) return
    const samePaths = before && next && before.cwd === next.cwd &&
      (before.agentKind === 'shell') === (next.agentKind === 'shell')
    const nextPaths = next ? samePaths ? before.activityPaths : activityPaths(next) : []
    if (!next) {
      facts.delete(id)
      file(id, undefined, before)
      return
    }
    const filed = { ...next, activityPaths: nextPaths }
    facts.set(id, id, filed)
    file(id, filed, before)
  }
  const api: SessionQuestions = {
    updates,
    hasWithin: path => activities.get(`activity:within:${machinePathKey(path)}`)?.answer.first() !== undefined,
    present(id) {
      return setupMembers.has(id)
    },
    setupAgent() { visits++; return setupAgents.first()?.agentKind },
    setupCount() { visits++; return setupCount },
    setupRevision: kind => Math.max(replacement, revisions.get(`setup:${kind}`) ?? 0),
    get visits() { return visits },
    get activityVisits() { return activityVisits },
    get activityPathsBuilt() { return activityPathsBuilt },
    fork: (isCollapsed, orderKey) => createSessionQuestions(isCollapsed, orderKey,
      { facts, triage, recent, machines, activities, revisions, future, expired, closeMembers, closeCounts, references,
        setupAgents, setupMembers, setupCount, version, replacement }, setupOrder),
    clear() {
      facts = newAnswer<FiledSessionFacts>()
      triage = newAnswer<TriageSession>(compareTriageSessions)
      recent = newAnswer<RecentSession>(compareRecent)
      machines = newAnswer<Bucket<MachineSession>>()
      activities = newAnswer<Bucket<Activity>>()
      revisions = newAnswer<number>()
      future = newAnswer<TimedTriageSession>(compareTriageSessions, value => value.deadline)
      expired = newAnswer<TimedTriageSession>(compareTriageSessions, value => value.deadline)
      closeMembers = newAnswer<CloseMember>()
      closeCounts = newAnswer<IssueCloseMemberCounts>()
      references = newAnswer<Bucket<ReferenceSession>>()
      setupAgents = newAnswer<SetupAgent>(compareSetupAgent)
      setupMembers = newAnswer<boolean>()
      setupCount = 0
      replacement = ++version
    },
    replace(rows) {
      building = true
      try {
        api.clear()
        for (const [id, row] of rows) api.set(id, row)
      } finally {
        building = false
        for (const finish of builders) finish()
        builders = []
        // No bootstrap writer survives publication, including nested buckets.
        for (const bucket of machines.snapshot()) bucket.answer = bucket.answer.fork()
        for (const bucket of activities.snapshot()) bucket.answer = bucket.answer.fork()
        for (const bucket of references.snapshot()) bucket.answer = bucket.answer.fork()
        facts = facts.fork(); triage = triage.fork(); recent = recent.fork()
        machines = machines.fork(); activities = activities.fork(); revisions = revisions.fork()
        future = future.fork(); expired = expired.fork()
        closeMembers = closeMembers.fork(); closeCounts = closeCounts.fork(); references = references.fork()
        setupAgents = setupAgents.fork(); setupMembers = setupMembers.fork()
      }
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
        issueId: typeof row.issueId === 'string' ? row.issueId : undefined,
        closeOffers: !row.archived && row.agentKind !== 'shell' && !!row.offer,
        closeWorking: !row.archived && row.agentKind !== 'shell' && isSessionWorking(row as unknown as SessionView),
        referenceKey: sessionReferenceKey(row),
        agentKind: String(row.agentKind ?? ''), headless: !!row.headless,
        setupOrder: setupOrder(id),
      })
    },
    setFacts,
    fact: id => facts.get(id),
    issueCloseCounts: id => closeCounts.get(id) ?? NO_CLOSE_MEMBERS,
    referenceId(ref) { visits++; return references.get(`ref:${ref}`)?.answer.first()?.id },
    visibilityChanged(id) {
      const value = facts.get(id)
      if (!value) return
      const next = { ...value, order: order(id), setupOrder: setupOrder(id) }
      facts.set(id, id, next)
      file(id, next, value, true)
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
        const answer = activities.get(`${question.agentsOnly ? 'agentActivity' : 'activity'}:${question.match ?? 'within'}:${machinePathKey(root)}`)?.answer
        let value = answer?.first()
        while (value && excluded.has(value.id)) { activityVisits++; value = answer?.after(value, value.id) }
        if (value) { activityVisits++; maximum = Math.max(maximum, value.at) }
      }
      return maximum
    },
    activityRevision: question => Math.max(replacement,
      ...question.roots.map(root => revisions.get(`${question.agentsOnly ? 'agentActivity' : 'activity'}:${question.match ?? 'within'}:${machinePathKey(root)}`) ?? 0)),
  }
  return api
}
