// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { SMALL_CORPUS, startScenarioEngine } from '../../shared/src/scenarios'
import type { SliceLocals } from '../../shared/src/slice-types'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { handArm } from './arm'
import type { HandStore } from './store'

it('debug parity at mount', async () => {
  const ctx = await startScenarioEngine(SMALL_CORPUS)
  try {
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const handle = handArm.create(source.source, locals) as unknown as {
      snapshot(): { rowsById: Record<string, object> }
      store: HandStore
    }
    const mine = handle.snapshot()
    const expected = snapshotFromStore(ctx.engine.getSnapshot(), locals)
    const mineIds = new Set(Object.keys(mine.rowsById))
    const expIds = new Set(Object.keys(expected.rowsById))
    const missing = [...expIds].filter((id) => !mineIds.has(id))
    const extra = [...mineIds].filter((id) => !expIds.has(id))
    console.info(`[debug] missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`)
    for (const id of missing.slice(0, 5)) {
      const issue = handle.store.issues.rows.get(id)
      console.info(
        `[debug] missing ${id}: stage=${issue?.stage} archived=${issue?.archived} ` +
          `members=${JSON.stringify(handle.store.summary.membersOf(id).map((s) => s.sessionId))} ` +
          `flat=${handle.store.visible.flat.has(id)} kept=${handle.store.visible.keptBy.get(id)?.size ?? 0}`,
      )
    }
    // Legacy inputs for the same issue.
    const snap = ctx.engine.getSnapshot()
    const wire = snap.issues.find((i) => i.id === 'i49') as unknown as Record<string, unknown>
    const sess = snap.sessions.filter((s) => s.issueId === 'i49')
    console.info(
      `[debug] legacy i49: stage=${wire?.['stage']} closedAt=${wire?.['closedAt']} updatedAt=${wire?.['updatedAt']} ` +
        `readAt=${wire?.['readAt']} unread=${wire?.['unread']} parentId=${wire?.['parentId']} ` +
        `closedReason=${wire?.['closedReason']} audience=${wire?.['audience']} deps=${JSON.stringify(wire?.['deps'])} ` +
        `sessions=${JSON.stringify(sess.map((s) => ({ id: s.sessionId, archived: s.archived, lastActiveAt: s.lastActiveAt, stoppedAt: s.stoppedAt, readAt: s.readAt, unread: s.unread })))} ` +
        `coarseNow=${snap.coarseNow}`,
    )
    const { allIssueViewModels } = await import('@podium/client-core/replica')
    const models = allIssueViewModels(
      ctx.replica as never,
      snap.issueProjections as never,
      snap.issues as never,
    ) as unknown as Array<Record<string, unknown>>
    const model = models.find((m) => m['id'] === 'i49')
    console.info(
      `[debug] model i49: ${JSON.stringify({ ...model, sessions: undefined }, null, 0).slice(0, 1200)}`,
    )
    expect(missing).toEqual([])
    expect(extra).toEqual([])
  } finally {
    ctx.engine.destroy()
  }
}, 60_000)
