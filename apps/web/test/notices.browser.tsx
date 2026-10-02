import type { ClientRuntime } from '@podium/client-core/engine'
import { Outbox, type OutboxEntry } from '@podium/client-core/outbox'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { asClientPrincipal } from '@podium/client-core/principal'
import { storeStats } from '@podium/client-core/perf'
import { noticeFixture } from '@podium/client-graph/diagnostics/notice-fixture'
import { checkNotices } from '@podium/client-graph/diagnostics/notice-check'
import { asUserId } from '@podium/model/browser'
import { Profiler, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { MessageNoticeIndicator } from '../src/features/chat/MessageNotices'
import { PendingInteractionBar } from '../src/features/chat/PendingInteractionBar'
import { OutboxRecoveryIndicator } from '../src/features/machines/OutboxRecovery'
import { noticeReadStats, noticesDataLayer } from '../src/features/chat/notice-data-layer'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'

const fixture = createHeaderFixture(5600, 5014), data = noticeFixture()
function put(entity: string, id: string, value: object) {
  fixture.records.set(`${entity}:${id}`, { entity, entityId: id, value, provenance: { seq: 1 } })
}
for (const row of data.messages) put('message', row.id, row)
for (const row of data.interactions) put('pendingInteraction', row.id, row)
for (const row of data.sessions) {
  const previous = fixture.records.get(`session:${row.sessionId}`)?.value ?? {}
  put('session', row.sessionId, { ...previous as object, ...row })
}
const actions = { dismissed: 0, answered: 0 }, failures: string[] = []
Object.assign(fixture.api, {
  messages: { dismissNotice: { mutate: async ({ id }: { id: string }) => {
    actions.dismissed++
    const record = fixture.records.get(`message:${id}`)!
    fixture.records.delete(`message:${id}`)
    fixture.replica.onKernelEvent({ type: 'evicted', entity: record.entity, entityId: id } as never)
    return { ok: true }
  } } },
  interactions: { answer: { mutate: async ({ id }: { id: string }) => {
    actions.answered++
    const record = fixture.records.get(`pendingInteraction:${id}`)!
    fixture.records.delete(`pendingInteraction:${id}`)
    fixture.replica.onKernelEvent({ type: 'evicted', entity: record.entity, entityId: id } as never)
    return { ok: true }
  } } },
})
let queued: OutboxEntry[] = [], parked: OutboxEntry[] = data.deadLetters.map(row => ({
  ...row.entry, state: 'dead-letter', deadLetter: { reason: row.reason, parkedFrom: row.parkedFrom, deadLetteredAt: row.deadLetteredAt, attempts: row.attempts },
}))
let owner: ClientRuntime, pool: ReturnType<typeof useWorklistPool> = null, ready = false, commits = 0, commitMs = 0
storeStats.enable(); noticeReadStats.enable()
function Surface() {
  owner = useStoreHandle() as ClientRuntime
  pool = useWorklistPool()
  useEffect(() => {
    ready = noticesDataLayer() === 'legacy' || pool !== null
    return () => { ready = false }
  }, [pool])
  return <main className="mx-auto max-w-2xl p-8">
    <h1 className="mb-3 text-xl font-semibold">Messages, questions and recovery</h1>
    <p className="mb-6 text-sm text-muted-foreground">5,600 synthetic tasks · 5,014 sessions · {noticesDataLayer()} readers</p>
    <Profiler id="notices" onRender={(_id, _phase, ms) => { commits++; commitMs += ms }}>
      <header className="mb-6 flex gap-5"><MessageNoticeIndicator /><OutboxRecoveryIndicator /></header>
      <PendingInteractionBar sessionId={'synthetic-session-0' as never} />
    </Profiler>
  </main>
}
const root = createRoot(document.getElementById('root')!)
root.render(<StoreProvider principal={asClientPrincipal(asUserId('notice-synthetic'))}
  config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
  createReplicaFn={() => fixture.newReplica()} networkEnabled={false} onFatalError={error => failures.push(error)}
  createOutboxFn={callbacks => new Outbox({
    executors: { issueUpdate: async () => ({ ok: true }) },
    storage: { load: () => queued, save: value => { queued = value } },
    deadLetterStorage: { load: () => parked, save: value => { parked = value } },
    isOnline: () => false, onApplied: callbacks.onApplied, onSettled: callbacks.onSettled,
    onDeadLetter: callbacks.onDeadLetter,
  }) as never}
  attachRuntime={runtime => { fixture.bindHub(runtime.hub); return attachWorklistPool(runtime, error => failures.push(error.message)) }}
><Surface /></StoreProvider>)
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const driver = {
  ready: () => ready && !!document.querySelector('[data-testid="message-notice-chip"]') && !!document.querySelector('[data-testid="pending-interaction"]'),
  reset() { storeStats.reset(); noticeReadStats.reset(); commits = 0; commitMs = 0 },
  async activity(count: number) { for (let step = 1; step <= count; step++) { fixture.activity(step); await frame() } },
  async updates(count: number) {
    for (let step = 0; step < count; step++) {
      fixture.patch('message', 'notice-message-0', { status: step % 2 ? 'failed' : 'unknown' })
      fixture.patch('pendingInteraction', 'notice-ask-8', { payload: { v: 1, provider: `Synthetic ${step}`, reason: 're-auth' } })
      await frame()
    }
  },
  stats() {
    const rows = storeStats.snapshot().runtimes
    const legacySliceNames: Record<string, number> = {}
    for (const row of rows) for (const [name, count] of Object.entries(row.slices)) {
      legacySliceNames[name] = (legacySliceNames[name] ?? 0) + count
    }
    return { selectors: rows.reduce((sum, row) => sum + row.selectorRuns, 0),
      legacySlices: Object.values(legacySliceNames).reduce((sum, count) => sum + count, 0), legacySliceNames,
      legacy: noticeReadStats.read(owner), commits, commitMs, failures: failures.length, actions,
      parked: owner.outbox.deadLetters().length, opened: owner.getSnapshot().paneA }
  },
  check() { return pool ? checkNotices(pool, owner.getSnapshot(), ['synthetic-session-0']) : null },
  close: () => root.unmount(),
}
Object.assign(window, { __notices: driver })
declare global { interface Window { __notices: typeof driver } }
