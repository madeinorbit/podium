/** Proof-only immutable keyed store; no dependency tracking or library. */
import { useEffect, useSyncExternalStore } from 'react'
import { GROUP, NOW, counters, summaryJS, type Fixture, type Issue, type Session } from './model'
import { missionRollup } from '../../src/viewmodels/mission'
import { nestStartedByIssues } from '../../src/viewmodels/slices/worklist/rows'
import { sortUnifiedWorkRows } from '../../src/viewmodels/slices/worklist/row-order'
import type { UnifiedIssueRow } from '../../src/viewmodels/slices/worklist/row-types'
type Listener = () => void
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i])
function cell<T>(derive: () => T) {
  const listeners = new Set<Listener>()
  let dirty = true, value: T
  return {
    get: () => { if (dirty) { value = derive(); dirty = false }; return value },
    subscribe: (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    invalidate: () => { dirty = true; for (const fn of listeners) fn() },
    clear: () => { listeners.clear(); dirty = true },
    get size() { return listeners.size },
  }
}
export function createKeyedProof(data: Fixture) {
  const counts = counters(), sessions = new Map<string, Session>(), issues = new Map<string, Issue>()
  const byIssue = new Map<string, string[]>(), byParent = new Map<string, string[]>()
  const rows = new Map<string, ReturnType<typeof cell<Session | undefined>>>()
  const summaries = new Map<string, ReturnType<typeof cell<ReturnType<typeof summaryJS>>>>()
  const families = new Map<string, { inputs: unknown[]; rolls: Map<string, ReturnType<typeof missionRollup>> }>()
  let now = NOW
  const groupIds = Array.from({ length: GROUP }, (_, i) => `i${i}`), groupSet = new Set(groupIds)
  function add(index: Map<string, string[]>, key: string | undefined, id: string) {
    if (key) index.set(key, [...(index.get(key) ?? []), id])
  }
  function move(index: Map<string, string[]>, old: string | undefined, next: string | undefined, id: string) {
    if (old === next) return
    if (old) index.set(old, (index.get(old) ?? []).filter(key => key !== id))
    add(index, next, id)
  }
  const mine = (id: string) => (byIssue.get(id) ?? []).map(key => sessions.get(key)!)
  const group = cell(() => {
    const gi = groupIds.map(id => issues.get(id)!), gs = gi.flatMap(i => mine(i.id))
    // Formal-only families are independent. Any provenance edge takes the safe
    // whole-group fallback; never infer general mission closure from parentId.
    const formalOnly = gi.every(i => !i.startedBySession && !i.deps?.length && !i.dependents?.length)
    const buckets = new Map<string, Issue[]>()
    for (const issue of gi) {
      let root = issue, seen = new Set<string>()
      while (formalOnly && root.parentId && groupSet.has(root.parentId) && !seen.has(root.id)) {
        seen.add(root.id); root = issues.get(root.parentId)!
      }
      const key = formalOnly && !seen.has(root.id) ? root.id : '*'
      const bucket = buckets.get(key) ?? []; bucket.push(issue); buckets.set(key, bucket)
    }
    const rolls = new Map<string, ReturnType<typeof missionRollup>>()
    for (const [key, family] of buckets) {
      const fs = family.flatMap(i => mine(i.id)), inputs = [...family, ...fs]
      let cached = families.get(key)
      if (!cached || !same(cached.inputs, inputs)) {
        cached = { inputs, rolls: new Map() }
        for (const i of family) { counts.mission++; cached.rolls.set(i.id, missionRollup(gi, gs, i.id)) }
        families.set(key, cached)
      }
      for (const [id, roll] of cached.rolls) rolls.set(id, roll)
    }
    for (const key of families.keys()) if (!buckets.has(key)) families.delete(key)
    const materialized: UnifiedIssueRow[] = gi.map(issue => {
      const own = mine(issue.id)
      counts.sessionVisits += own.length
      return { kind: 'issue', issue, sessions: own,
        activityAt: own.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt)), 0), missionRollup: rolls.get(issue.id)! }
    })
    counts.nesting++; counts.sorts++
    return sortUnifiedWorkRows(nestStartedByIssues(materialized, gs, [], gi), now)
  })
  function replace(next: Fixture) {
    sessions.clear(); issues.clear(); byIssue.clear(); byParent.clear(); families.clear()
    for (const i of next.issues) { issues.set(i.id, i); add(byParent, i.parentId, i.id) }
    for (const s of next.sessions) { sessions.set(s.sessionId, s); add(byIssue, s.issueId, s.sessionId) }
    for (const row of rows.values()) row.invalidate()
    for (const summary of summaries.values()) summary.invalidate()
    group.invalidate()
  }
  replace(data)
  function row(id: string) {
    let value = rows.get(id)
    if (!value) { value = cell(() => sessions.get(id)); rows.set(id, value) }
    return value
  }
  function summary(id: string) {
    let value = summaries.get(id)
    if (!value) {
      value = cell(() => summaryJS(issues.get(id)!, mine(id), (byParent.get(id) ?? []).map(key => issues.get(key)!), counts))
      summaries.set(id, value)
    }
    return value
  }
  function update(s: Session) {
    const old = sessions.get(s.sessionId)
    move(byIssue, old?.issueId, s.issueId, s.sessionId); sessions.set(s.sessionId, s)
    // Finish all writes before publishing any notification.
    rows.get(s.sessionId)?.invalidate()
    for (const id of new Set([old?.issueId, s.issueId])) if (id) summaries.get(id)?.invalidate()
    if (groupSet.has(old?.issueId ?? '') || groupSet.has(s.issueId ?? '')) group.invalidate()
  }
  function updateIssue(i: Issue) {
    const old = issues.get(i.id)
    move(byParent, old?.parentId, i.parentId, i.id); issues.set(i.id, i)
    for (const id of new Set([i.id, old?.parentId, i.parentId])) if (id) summaries.get(id)?.invalidate()
    if (groupSet.has(i.id)) { families.clear(); group.invalidate() }
  }
  return { counts, sessions, issues, row, summary, group, update, updateIssue, replace,
    tick: (time: number) => { now = time; group.invalidate() },
    subscriberCount: () => group.size + [...rows.values(), ...summaries.values()].reduce((n, c) => n + c.size, 0),
    dispose: async () => {
      for (const c of [...rows.values(), ...summaries.values(), group]) c.clear()
      rows.clear(); summaries.clear(); families.clear(); sessions.clear(); issues.clear(); byIssue.clear(); byParent.clear()
    } }
}
export type KeyedProof = ReturnType<typeof createKeyedProof>
export function KeyedRow({ proof, id, read, commit }: { proof: KeyedProof; id: string; read: () => void; commit: () => void }) {
  const c = proof.row(id), value = useSyncExternalStore(c.subscribe, c.get, c.get)
  read(); useEffect(commit)
  return <>{value?.lastActiveAt}</>
}
export function KeyedSummary({ proof, read }: { proof: KeyedProof; read: (value: unknown) => void }) {
  const c = proof.summary('i0'), value = useSyncExternalStore(c.subscribe, c.get, c.get); read(value)
  return <>{JSON.stringify(value)}</>
}
export function KeyedGroup({ proof, read }: { proof: KeyedProof; read: (value: unknown) => void }) {
  const c = proof.group, value = useSyncExternalStore(c.subscribe, c.get, c.get); read(value)
  return <>{value.map(row => row.kind === 'issue' ? row.issue.id : '').join(',')}</>
}
