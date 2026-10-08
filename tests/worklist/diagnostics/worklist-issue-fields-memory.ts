/** Matched 4x retained worklist demand, run on flatblock before/after the
 * shared issue getter change. No production counters or persistent snapshots. */
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import { autorun, computed } from 'mobx'
import { enableDebugNames } from '@podium/mobx-helpers'
import { MobxPool } from '@podium/client-graph/pool'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { buildCorpus } from '../harness/src/fixture/corpus'

if (hostname() !== 'flatblock') throw new Error('Worklist memory measurement runs on flatblock')
const mode = process.argv[2]
if (mode !== 'before' && mode !== 'after') throw new Error('Expected before or after')
enableDebugNames()
const { heapStats } = createRequire(import.meta.url)('bun:jsc') as { heapStats(): { heapSize: number } }
const runtime = globalThis as unknown as { Bun: { gc(force: boolean): void } }
const heap = () => { runtime.Bun.gc(true); runtime.Bun.gc(true); return heapStats().heapSize }
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const corpus = buildCorpus(4)
await settle()
const before = heap()
type Cache = { observers_: Set<unknown> | null; name_: string }
const caches = new Set<Cache>()
const prototype = Object.getPrototypeOf(computed(() => 0)) as { computeValue_(...args: unknown[]): unknown }
const compute = prototype.computeValue_
prototype.computeValue_ = function (...args: unknown[]) {
  caches.add(this as unknown as Cache)
  return compute.apply(this, args)
}
const pool = new MobxPool({ selectedIssueId: null, coarseNow: corpus.fixedNow }, undefined, {
  load: () => undefined, schedule: () => () => {},
})
pool.apply({ type: 'replace', rows: [
  ...corpus.sliceIssues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
  ...corpus.sliceSessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
  ...corpus.sliceWorktrees.map(value => ({ kind: 'worktree' as const, id: value.path, value })),
  ...corpus.repoProjections.map(value => ({ kind: 'repo' as const, id: value.id, value })),
] })
const view = worklistView(pool)
let shown = 0
const stop = autorun(() => {
  const sections = view.sections()
  void view.mobileSections().issueCount
  const ids = new Set(sections.pinnedIds)
  for (const band of sections.bands) for (const id of [...band.rowIds, ...band.closedIds, ...band.snoozedIds]) ids.add(id)
  shown = 0
  for (const id of ids) {
    const row = view.knownRow(id)
    if (!row || row.ready !== 'ready') continue
    shown++
    // The same desktop/phone paint questions in both runs, read directly.
    row.title; row.timing; row.visibleWorking; row.visibleAsking; row.origin
    row.decision; row.mergeCommits; row.progress; row.hasChildProgress; row.showsChildProgress
    row.visibleUnread; row.emphasizeUnread; row.errorClass; row.returnedFromDefer
    row.canTuck; row.canBringBack; row.sessionOnlyDraft; row.firstSessionId; row.continuation
    row.visibleFleet; row.sessions; row.visibleSessionIds; row.awaitingFirstPrompt
    row.waitingCount; row.quietDraft; row.attentionAction; row.navigation; row.visibleActivityAt
    const issue = row.issue
    issue.seq; issue.color; issue.audience; issue.gitState; issue.branch
    issue.stage; issue.closedAt; issue.closedReason; issue.needsHuman; issue.asked
    issue.updatedAt; issue.tuckedAt; issue.deferUntil; issue.pinned; issue.deferred
  }
})
await settle()
await settle()
const watched = [...caches].filter(cache => cache.observers_?.size)
const watchedFields = watched.length
const watchedIssueFields = watched.filter(cache => cache.name_.startsWith('IssueModel.')).length
prototype.computeValue_ = compute
caches.clear()
watched.length = 0
const retained = heap()
console.log(JSON.stringify({ mode, scale: 4, issues: corpus.sliceIssues.length,
  sessions: corpus.sliceSessions.length, shown, watchedFields, watchedIssueFields,
  heapBeforeWorklist: before, heapWithWorklist: retained, worklistHeap: retained - before }))
stop()
pool.dispose()
