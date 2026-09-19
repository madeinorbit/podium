import { asIssueId, asSessionId, type SessionMeta } from '@podium/model'
import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import { deriveIssueRollups, issueDisplayRef, type IssueView, type IssueSessionRollups, type SessionViewInput } from '../replica/issue-views'
import { missionRollup, type MissionRollup } from '../viewmodels/mission'
import type { IssueNavigationModel } from '../viewmodels/slices/issues'
import { createComputedGraph } from './computed'
import { relationshipKey, type Relationship } from './relationships'
import type { ReadCell } from './model'

export interface IssueSummary extends IssueView, IssueSessionRollups {
  title: string
}
export interface SummarySource {
  row<K extends ReplicaKind>(kind: K, id: string): Readonly<ReplicaRows[K]> | undefined
  relationship(key: string): readonly string[]
  order(kind: ReplicaKind, id: string): number
}
const key = (...parts: string[]) => JSON.stringify(parts)

/** Pilot only: no clock, subscriptions or consumer are installed here. The
 * presentation owner delivers atomic invalidations and explicitly advances time.
 * ID sets from E2 are restored to replica insertion order before policy calls. */
export function createIssueSummaries(source: SummarySource) {
  const graph = createComputedGraph()
  let now: number | undefined
  const counts = { summaries: 0, phases: 0, unread: 0, readiness: 0, children: 0, membership: 0, mission: 0, sessionVisits: 0, missionSessionVisits: 0 }
  function computed<T>(id: string, part: string, derive: () => T): ReadCell<T> {
    return graph.cell(key('summary', id, part), id, derive)
  }
  function field<K extends ReplicaKind, T>(kind: K, id: string, label: string, select: (row: Readonly<ReplicaRows[K]> | undefined) => T): T {
    return graph.cell(key('field', kind, id, label), kind === 'issues' || kind === 'issueProjections' ? id : key(kind, id),
      () => graph.input(key('row', kind, id), () => select(source.row(kind, id)))).getSnapshot()
  }
  function relation(kind: Relationship, id: string, type?: string): readonly string[] {
    const token = relationshipKey(kind, id, type)
    return graph.input(token, () => source.relationship(token))
  }
  function ordered(kind: ReplicaKind, ids: readonly string[]): string[] {
    const ranks = new Map(ids.map(id => [id, graph.input(key('order', kind, id), () => source.order(kind, id))]))
    return [...ids].sort((a, b) => ranks.get(a)! - ranks.get(b)!)
  }
  const present = (id: string) => field('issueProjections', id, 'present', r => r !== undefined)
  const stage = (id: string) => field('issueProjections', id, 'stage', r => r?.stage)
  function deps(id: string) {
    return computed(id, 'deps', () => ordered('issueDeps', relation('outgoingEdges', id)).flatMap(edgeId => {
      const edge = field('issueDeps', edgeId, 'edge', r => r)
      return edge ? [{ id: edge.toId, type: edge.type }] : []
    })).getSnapshot()
  }
  function dependents(id: string) {
    return computed(id, 'dependents', () => {
      const edges = ordered('issueDeps', relation('incomingEdges', id)).flatMap(edgeId => {
        const edge = field('issueDeps', edgeId, 'edge', r => r)
        return edge && present(edge.fromId) ? [{ id: edge.fromId, type: edge.type }] : []
      })
      // Legacy deriveIssueViews groups edges by the source issue's slice order.
      const ids = ordered('issueProjections', [...new Set(edges.map(e => e.id))])
      return ids.flatMap(id => edges.filter(e => e.id === id))
    }).getSnapshot()
  }
  function members(id: string) {
    return computed(id, 'members', () => {
      counts.membership++
      return ordered('sessions', relation('attachedSessionsByIssue', id)).filter(sid =>
        field('sessions', sid, 'worker', s => !!s && s.agentKind !== 'shell')).map(asSessionId)
    }).getSnapshot()
  }
  function phases(id: string) {
    return computed(id, 'phases', () => {
      counts.phases++
      const byPhase: Record<string, number> = {}
      const ids = members(id)
      for (const sid of ids) {
        counts.sessionVisits++
        const phase = field('sessions', sid, 'phase', s => (s as SessionViewInput | undefined)?.phase ?? 'unknown')
        byPhase[phase] = (byPhase[phase] ?? 0) + 1
      }
      return { total: ids.length, byPhase }
    }).getSnapshot()
  }
  function unread(id: string) {
    return computed(id, 'unread', () => {
      counts.unread++
      const input = field('issueProjections', id, 'unread', p => p && ({ updatedAt: p.updatedAt, deletedAt: p.deletedAt }))
      if (!input) return false
      const readAt = field('issues', id, 'readAt', i => i?.readAt ?? null)
      return deriveIssueRollups({ ...input, readAt }, members(id), sid => {
        counts.sessionVisits++
        return field('sessions', sid, 'activity', s => s && ({ sessionId: s.sessionId, lastActiveAt: s.lastActiveAt }))
      }).unread
    }).getSnapshot()
  }
  function readiness(id: string) {
    return computed(id, 'readiness', () => {
      counts.readiness++
      const blocked = deps(id).some(dep => dep.type === 'blocks' && stage(dep.id) !== undefined && stage(dep.id) !== 'done')
      const deferUntil = field('issueProjections', id, 'deferUntil', p => p?.deferUntil)
      let deferred = false
      if (deferUntil != null && Number.isFinite(Date.parse(deferUntil))) {
        const time = graph.input('summary:time', () => now)
        if (time === undefined) throw new Error('Issue summaries require updateTime(now) before reading a snoozed issue')
        deferred = Date.parse(deferUntil) > time
      }
      return { blocked, deferred, ready: !blocked && !deferred && stage(id) !== 'done' }
    }).getSnapshot()
  }
  function children(id: string) {
    return computed(id, 'children', () => {
      counts.children++
      const childIds = ordered('issueProjections', relation('allChildrenByParent', id)).filter(present).map(asIssueId)
      return { childIds, childCount: childIds.length, childDoneCount: childIds.filter(id => stage(id) === 'done').length }
    }).getSnapshot()
  }
  function summary(id: string): ReadCell<IssueSummary | undefined> {
    return computed(id, 'summary', () => {
      if (!present(id)) return undefined
      counts.summaries++
      const display = field('issueProjections', id, 'display', p => p && ({ title: p.title, seq: p.seq, repoId: p.repoId }))!
      const prefix = display.repoId ? field('repos', display.repoId, 'prefix', r => r?.prefix) : null
      return { id, title: display.title, displayRef: issueDisplayRef({ seq: display.seq, prefix }),
        memberSessionIds: members(id), ...children(id), ...readiness(id), dependents: dependents(id),
        unread: unread(id), sessionSummary: phases(id) }
    })
  }

  function missionIssue(id: string): IssueNavigationModel | undefined {
    return computed(id, 'missionIssue', () => {
      // Use the same normalized-own-fields / retained-supplement boundary as
      // buildIssueViewModel. Only fields read by missionRollup cross this seam.
      const p = field('issueProjections', id, 'mission', p => p && ({ id: p.id, stage: p.stage,
        parentId: p.parentId, archived: p.archived, deletedAt: p.deletedAt, closedReason: p.closedReason,
        startedBySession: p.startedBySession, updatedAt: p.updatedAt }))
      if (!p) return undefined
      return { ...p, deps: deps(id), dependents: dependents(id), blocked: readiness(id).blocked } as IssueNavigationModel
    }).getSnapshot()
  }
  function mission(id: string): ReadCell<MissionRollup | undefined> {
    return computed(id, 'mission', () => {
      if (!present(id)) return undefined
      const seen = new Set<string>(), stack = [id], issues: IssueNavigationModel[] = [], sessions: SessionMeta[] = []
      // Close over formal, starting-session and discovered-from adjacency. No
      // unrelated group/world scan. The original policy still decides membership,
      // including archived provenance candidates and vacated origins.
      while (stack.length) {
        const next = stack.pop()!
        if (seen.has(next)) continue
        seen.add(next)
        const issue = missionIssue(next)
        if (!issue) continue
        issues.push(issue)
        stack.push(...relation('childrenByParent', next))
        for (const edge of dependents(next)) if (edge.type === 'discovered-from') stack.push(edge.id)
        for (const sid of relation('attachedSessionsByIssue', next)) {
          const session = field('sessions', sid, 'mission', s => s && ({ sessionId: s.sessionId, issueId: s.issueId, archived: s.archived, status: s.status, lastActiveAt: s.lastActiveAt })) as SessionMeta | undefined
          if (session) { sessions.push(session); counts.sessionVisits++; counts.missionSessionVisits++ }
          stack.push(...relation('issuesByStartingSession', sid))
        }
      }
      const issueOrder = ordered('issueProjections', issues.map(i => i.id)), sessionOrder = ordered('sessions', sessions.map(s => s.sessionId))
      const byIssue = new Map<string, IssueNavigationModel>(issues.map(i => [i.id, i])), bySession = new Map<string, SessionMeta>(sessions.map(s => [s.sessionId, s]))
      counts.mission++
      return missionRollup(issueOrder.map(id => byIssue.get(id)!), sessionOrder.map(id => bySession.get(id)!), id)
    })
  }
  return {
    summary, mission,
    updateTime(time: number) {
      if (!Number.isFinite(time)) throw new Error('Invalid summary time')
      if (time === now) return
      now = time; graph.invalidate(['summary:time'])
    },
    invalidate: graph.invalidate, evict: graph.evict, destroy: graph.destroy,
    stats: () => ({ ...counts, ...graph.stats() }),
  }
}
