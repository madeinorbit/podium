import { createCollection, createLiveQueryCollection, BasicIndex, eq, count, max, sum, caseWhen, coalesce, gt, type SyncConfig, type Collection, type SingleResult, type NonSingleResult } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useMemo } from 'react'
import { GROUP, NOW, counters, band, worklistJS, type Fixture, type Issue, type Session } from './model'
// Erase private query utilities while preserving the exact inferred row and
// single-result marker. No casts and no dependency on TanStack internal types.
function publicQuery<T extends object, K extends string | number>(query: Collection<T, K, {}> & SingleResult): Collection<T, K, {}> & SingleResult
function publicQuery<T extends object, K extends string | number>(query: Collection<T, K, {}> & NonSingleResult): Collection<T, K, {}> & NonSingleResult
function publicQuery<T extends object, K extends string | number>(query: Collection<T, K, {}>): Collection<T, K, {}> { return query }
function source<T extends object>(rows: T[], getKey: (row: T) => string) {
  let sync!: Parameters<SyncConfig<T, string>['sync']>[0]
  const collection = createCollection<T, string>({ getKey, startSync: true, gcTime: 0, autoIndex: 'eager', defaultIndexType: BasicIndex,
    sync: { rowUpdateMode: 'full', sync(params) {
      sync = params; params.begin(); for (const value of rows) params.write({ type: 'insert', value })
      params.commit(); params.markReady()
    } } })
  return { collection,
    update(value: T) { sync.begin(); sync.write({ type: 'update', value }); sync.commit() },
    replace(values: T[]) { sync.begin(); sync.truncate(); for (const value of values) sync.write({ type: 'insert', value }); sync.commit() } }
}
export function createTanstackProof(data: Fixture) {
  const counts = counters()
  const sessions = source(data.sessions, s => s.sessionId)
  const issues = source(data.issues, i => i.id)
  sessions.collection.createIndex(s => s.issueId)
  issues.collection.createIndex(i => i.parentId)
  const clock = source([{ id: 'clock', now: NOW }], c => c.id)
  const phases = publicQuery(createLiveQueryCollection({ gcTime: 1, query: q => q.from({ s: sessions.collection })
    .groupBy(({ s }) => [s.issueId, coalesce(s.agentState?.phase, 'unknown')])
    .select(({ s }) => ({ issueId: s.issueId, phase: coalesce(s.agentState?.phase, 'unknown'), count: count(s.sessionId) })) }))
  const latest = publicQuery(createLiveQueryCollection({ gcTime: 1, query: q => q.from({ s: sessions.collection })
    .groupBy(({ s }) => s.issueId).select(({ s }) => ({ issueId: s.issueId, latest: max(s.lastActiveAt) })) }))
  const children = publicQuery(createLiveQueryCollection({ gcTime: 1, query: q => q.from({ i: issues.collection })
    .groupBy(({ i }) => i.parentId).select(({ i }) => ({ parentId: i.parentId,
      childDone: sum(caseWhen(eq(i.stage, 'done'), 1, 0)) })) }))
  const summary = publicQuery(createLiveQueryCollection({ gcTime: 1, query: q => q.from({ i: issues.collection })
    .where(({ i }) => eq(i.id, 'i0'))
    .leftJoin({ latest }, ({ i, latest: l }) => eq(i.id, l.issueId))
    .leftJoin({ children }, ({ i, children: c }) => eq(i.id, c.parentId))
    .select(({ i, latest: l, children: c }) => ({ id: i.id, latest: l.latest,
      unread: gt(coalesce(l.latest, ''), coalesce(i.readAt, '')), childDone: coalesce(c.childDone, 0) })).findOne() }))
  const summaryPhases = publicQuery(createLiveQueryCollection({ gcTime: 1, query: q => q.from({ phases })
    .where(({ phases: p }) => eq(p.issueId, 'i0')).select(({ phases: p }) => p) }))
  const groupIssues = publicQuery(createLiveQueryCollection({ gcTime: 1, query: q => q.from({ i: issues.collection })
    .fn.where(({ i }) => i.seq <= GROUP).select(({ i }) => i) }))
  const groupSessions = publicQuery(createLiveQueryCollection({ gcTime: 1, query: q => q.from({ s: sessions.collection })
    .innerJoin({ i: groupIssues }, ({ s, i }) => eq(s.issueId, i.id)).select(({ s }) => s) }))
  const ranked = publicQuery(createLiveQueryCollection({ gcTime: 1, query: q => q.from({ i: groupIssues })
    .innerJoin({ clock: clock.collection }, ({ clock: c }) => eq(c.id, 'clock'))
    .fn.select(({ i, clock: c }) => ({ id: i.id, band: band(i, c.now, counts), seq: i.seq, key: i.sortKey || '\uffff', created: Date.parse(i.createdAt) || 0 }))
    .orderBy(({ $selected }) => $selected.band, 'asc').orderBy(({ $selected }) => $selected.key, 'asc')
    .orderBy(({ $selected }) => $selected.created, 'desc').orderBy(({ $selected }) => $selected.seq, 'desc')
    .orderBy(({ $selected }) => $selected.id, 'asc') }))
  const group = publicQuery(createLiveQueryCollection({ gcTime: 1, query: q => q.from({ clock: clock.collection })
    .select(({ clock: c }) => ({ id: c.id, now: c.now })) }))
  function rowQuery(id: string) { return publicQuery(createLiveQueryCollection({ gcTime: 1,
    query: q => q.from({ s: sessions.collection }).where(({ s }) => eq(s.sessionId, id)).select(({ s }) => s).findOne() })) }
  const rowQueries = new Map<number, ReturnType<typeof rowQuery>>()
  const queries = [phases, latest, children, summary, summaryPhases, groupIssues, groupSessions, ranked, group]
  return { counts, sessions: sessions.collection, issues: issues.collection, phases, children, summary, summaryPhases,
    groupIssues, groupSessions, ranked, group,
    observeNative() {
      const stops = queries.map(q => q.subscribeChanges(changes => { counts.nativeOutputChanges += changes.length }))
      return () => { for (const stop of stops) stop.unsubscribe() }
    },
    row(id: string, reader: number) { let query = rowQueries.get(reader); if (!query) { query = rowQuery(id); rowQueries.set(reader, query) }; return query },
    updateIssue: (i: Issue) => issues.update(i),
    update: (s: Session) => sessions.update(s), tick: (now: number) => clock.update({ id: 'clock', now }),
    replace(next: Fixture) { issues.replace(next.issues); sessions.replace(next.sessions) },
    async dispose() { await Promise.all([...rowQueries.values(), ...queries].map(q => q.cleanup())); rowQueries.clear(); await Promise.all([sessions.collection.cleanup(), issues.collection.cleanup(), clock.collection.cleanup()]) } }
}
export type TanstackProof = ReturnType<typeof createTanstackProof>
export function TanstackRow({ proof, id, reader, read, commit }: { proof: TanstackProof; id: string; reader: number; read: () => void; commit: () => void }) {
  const { data } = useLiveQuery(proof.row(id, reader)); read(); useEffect(commit)
  return <>{data?.lastActiveAt}</>
}
export function TanstackSummary({ proof, read }: { proof: TanstackProof; read: (value: unknown) => void }) {
  const { data } = useLiveQuery(proof.summary)
  const { data: phases } = useLiveQuery(proof.summaryPhases)
  const value = { latest: data?.latest ?? '', unread: data?.unread ?? false, childDone: data?.childDone ?? 0,
    phases: Object.fromEntries(phases.map(p => [p.phase, p.count])) }; read(value)
  return <>{JSON.stringify(value)}</>
}
export function TanstackGroup({ proof, read }: { proof: TanstackProof; read: (value: unknown) => void }) {
  const { data: issues } = useLiveQuery(proof.groupIssues)
  const { data: sessions } = useLiveQuery(proof.groupSessions)
  const { data: ranks } = useLiveQuery(proof.ranked)
  const { data: clock } = useLiveQuery(proof.group)
  // Exact shared arbitrary-JS tail, not credited to native IVM.
  const nested = useMemo(() => worklistJS(issues, sessions, clock[0]?.now ?? NOW, proof.counts, false), [issues, sessions, clock, proof])
  const byId = new Map(nested.flatMap(row => row.kind === 'issue' ? [[row.issue.id, row] as const] : []))
  const value = ranks.flatMap(rank => { const row = byId.get(rank.id); return row ? [row] : [] }); read(value)
  return <>{ranks.length}:{value.map(row => row.kind === 'issue' ? row.issue.id : '').join(',')}</>
}
