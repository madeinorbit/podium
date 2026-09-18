import { computed, observable, runInAction, type IComputedValue } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'
import { GROUP, NOW, counters, summaryJS, worklistJS, type Fixture, type Issue, type Session } from './model'
const sameRows = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((row, i) => row === b[i])
export function createMobxProof(data: Fixture) {
  const counts = counters()
  // Effective rows are immutable references; the proof never owns optimism.
  const sessions = observable.map<string, Session>([], { deep: false })
  const issues = observable.map<string, Issue>([], { deep: false })
  const byIssue = observable.map<string, readonly string[]>([], { deep: false })
  const byParent = observable.map<string, readonly string[]>([], { deep: false })
  const now = observable.box(NOW)
  const summaries = new Map<string, IComputedValue<ReturnType<typeof summaryJS>>>()
  const groupIssues = computed(() => Array.from({ length: GROUP }, (_, i) => issues.get(`i${i}`)!), { equals: sameRows })
  const groupSessions = computed(() => groupIssues.get().flatMap(i => (byIssue.get(i.id) ?? []).map(id => sessions.get(id)!)), { equals: sameRows })
  const group = computed(() => worklistJS(groupIssues.get(), groupSessions.get(), now.get(), counts))
  function add(map: typeof byIssue, key: string | undefined, id: string) {
    if (key) map.set(key, [...(map.get(key) ?? []), id])
  }
  function replace(next: Fixture) {
    runInAction(() => {
      sessions.clear(); issues.clear(); byIssue.clear(); byParent.clear()
      for (const i of next.issues) { issues.set(i.id, i); add(byParent, i.parentId, i.id) }
      for (const s of next.sessions) { sessions.set(s.sessionId, s); add(byIssue, s.issueId, s.sessionId) }
    })
  }
  replace(data)
  function summary(id: string) {
    let value = summaries.get(id)
    if (!value) {
      value = computed(() => summaryJS(issues.get(id)!,
        (byIssue.get(id) ?? []).map(key => sessions.get(key)!),
        (byParent.get(id) ?? []).map(key => issues.get(key)!), counts))
      summaries.set(id, value)
    }
    return value
  }
  function update(s: Session) {
    runInAction(() => {
      const old = sessions.get(s.sessionId)
      if (old?.issueId !== s.issueId) {
        if (old?.issueId) byIssue.set(old.issueId, (byIssue.get(old.issueId) ?? []).filter(id => id !== s.sessionId))
        add(byIssue, s.issueId, s.sessionId)
      }
      sessions.set(s.sessionId, s)
    })
  }
  function updateIssue(issue: Issue) {
    runInAction(() => {
      const old = issues.get(issue.id)
      if (old?.parentId !== issue.parentId) {
        if (old?.parentId) byParent.set(old.parentId, (byParent.get(old.parentId) ?? []).filter(id => id !== issue.id))
        add(byParent, issue.parentId, issue.id)
      }
      issues.set(issue.id, issue)
    })
  }
  return { counts, sessions, issues, byIssue, byParent, group, summary, update, updateIssue, replace,
    tick: (time: number) => runInAction(() => now.set(time)),
    dispose: async () => { summaries.clear(); runInAction(() => { sessions.clear(); issues.clear(); byIssue.clear(); byParent.clear() }) } }
}
export type MobxProof = ReturnType<typeof createMobxProof>
export const MobxRow = observer(function MobxRow({ proof, id, read, commit }: { proof: MobxProof; id: string; read: () => void; commit: () => void }) {
  const value = proof.sessions.get(id)?.lastActiveAt
  read(); useEffect(commit)
  return <>{value}</>
})
export const MobxSummary = observer(function MobxSummary({ proof, read }: { proof: MobxProof; read: (value: unknown) => void }) {
  const value = proof.summary('i0').get(); read(value)
  return <>{JSON.stringify(value)}</>
})
export const MobxGroup = observer(function MobxGroup({ proof, read }: { proof: MobxProof; read: (value: unknown) => void }) {
  const value = proof.group.get(); read(value)
  return <>{value.map(row => row.kind === 'issue' ? row.issue.id : '').join(',')}</>
})
