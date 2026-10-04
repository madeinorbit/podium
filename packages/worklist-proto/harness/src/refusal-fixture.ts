/** Focused recovery proof over the production kernel queue and pool writer. */
import { NoticeSource } from '@podium/client-graph/notice-source'
import { NOTICE_ENTITIES } from '@podium/client-graph/notice-schema'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { autorun } from 'mobx'
import { startScenarioEngine } from '../../shared/src/scenarios'

export async function refusalFixture(scale: 1 | 4 = 1) {
  let online = false
  let refuses = true
  const onlineListeners = new Set<() => void>()
  const ctx = await startScenarioEngine(scale, {
    outbox: 'kernel',
    settleMs: 10,
    network: {
      isOnline: () => online,
      onlineEvents: {
        add: (listener) => onlineListeners.add(listener),
        remove: (listener) => onlineListeners.delete(listener),
      },
    },
    server: {
      issueUpdate: async () => {
        if (refuses) throw Object.assign(new Error('Synthetic refusal'), {
          data: { code: 'CONFLICT', httpStatus: 409 },
        })
        return {}
      },
    },
  })
  ctx.engine.enablePoolRuntimeWork()
  const handle = createRuntimeWorklistPool(ctx.engine, { owns: ['issue', 'session'] })
  const { pool } = handle
  pool.sources.register(NOTICE_ENTITIES, new NoticeSource(ctx.engine))
  const id = ctx.targets.visibleRootId
  const stop = autorun(() => {
    pool.row('issue', id)
    pool.sidebar.row(id)
    pool.mobileWork.row({ kind: 'issue', id })
  })
  for (let round = 0; round < 20 && pool.hydrate(); round++) {}
  stop()
  const original = ctx.replica.row!('issueProjections', id)!.title
  return {
    ctx, handle, pool, id, original,
    get outbox() { return ctx.engine.outbox },
    setOnline(next: boolean) {
      online = next
      if (next) for (const listener of onlineListeners) listener()
    },
    accept() { refuses = false },
    dispose() { handle.dispose(); ctx.engine.destroy() },
  }
}
