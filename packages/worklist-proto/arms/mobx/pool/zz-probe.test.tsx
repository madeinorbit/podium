// @vitest-environment happy-dom
// SCRATCH (POD-4572, not committed): rescope 1x -> 2x on the pool, as the page does it.
import { describe, it } from 'vitest'
import { openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { oracleSnapshot } from '../../../harness/src/oracle/index'
import { FIXTURE_SEED, seedCacheFromCorpus, startScenarioEngine } from '../../../shared/src/scenarios'
import { mobxPoolArm } from './arm'
import { tracked } from './pool'

function diff(got: any, want: any): string[] {
  const out: string[] = []
  for (const id of Object.keys(want.rowsById)) {
    const a = got.rowsById[id]
    const b = want.rowsById[id]
    if (a === undefined) { out.push(`${id}: missing`); continue }
    const f = Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    if (f.length > 0) out.push(`${id}: ${f.map((k) => `${k} ${JSON.stringify(a[k])}/${JSON.stringify(b[k])}`).join('; ')}`)
  }
  for (const id of Object.keys(got.rowsById)) if (!(id in want.rowsById)) out.push(`${id}: extra`)
  return out
}

describe('probe', () => {
  it('rescope 1x -> 2x', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = mobxPoolArm.create(feeds.rows.source, feeds.locals.source)
    handle.snapshot()
    const grown = seedCacheFromCorpus(buildCorpus(2, FIXTURE_SEED)).records
    const { cache, replica } = ctx
    const keep = new Set(grown.map((row: any) => `${row.entity}:${row.entityId}`))
    replica.batch(() => {
      for (const row of [...cache.records]) if (!keep.has(`${row.entity}:${row.entityId}`)) cache.drop(row.entity as never, row.entityId)
      for (const row of grown) cache.put(row.entity as never, row.entityId, row.value)
    })
    replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'rescope', snapshotSeq: 1, entityCount: cache.records.length, bufferedFramesApplied: 0 } as never)
    await new Promise((r) => setTimeout(r, ctx.settleMs))
    feeds.flush()
    handle.settleLoads()
    const got = handle.snapshot()
    const want = oracleSnapshot(ctx.engine.getSnapshot())
    const d = diff(got, want)
    console.info(`[probe] grown diffs=${d.length}\n${d.slice(0, 20).join('\n')}`)
    const pool = handle.pool
    const show = (p: any, label: string) => {
      for (const sid of ['s4374', 's6288', 's7616']) {
        const info = tracked(() => ({
          cold: p.residency?.isCold('session', sid),
          hot: p.fenced.session.has(sid),
          row: JSON.stringify(p.visibleInputs.sessionRow(sid))?.slice(0, 300),
          retention: JSON.stringify(p.worklist.session(sid).retention),
        }))
        console.info(`[probe] ${label} ${sid} ${JSON.stringify(info)}`)
      }
      console.info(`[probe] ${label} s5122 row=${tracked(() => JSON.stringify(p.visibleInputs.sessionRow('s5122'))?.slice(0, 260))} cold=${p.residency?.isCold('session', 's5122')} issue=${tracked(() => p.relations.one('session', 's5122', 'issue'))} worktree=${tracked(() => p.relations.one('session', 's5122', 'worktree'))} lanes=${tracked(() => JSON.stringify(p.worklist.issue('i6875')?.laneMemberIds))}`)
      console.info(`[probe] ${label} roster=${JSON.stringify(tracked(() => p.worklist.issue('i6875')?.rosterIds))} standing=${JSON.stringify(tracked(() => p.worklist.issue('i6875')?.standing))} now=${p.clock.current}`)
    }
    show(pool, 'rescoped')
    {
      const g: any = pool.graph
      const link = (g.outgoing.get('session') ?? []).find((l: any) => l.spec.kind === 'prefix')
      const L = '/repo-000/.worktrees/w00477'
      console.info(`[probe] link=${link?.name} under(L)=${JSON.stringify([...(link?.under.get(L) ?? [])])} placed(s5122)=${link?.placed.get('s5122')} fwd=${link?.forward.get('s5122')} coldFwd=${link?.coldForward.get('s5122')} probeHas=${g.probe.worktree.has(L)} tableHas=${tracked(() => pool.fenced.worktree.has(L))} feedHas=${feeds.rows.source.snapshot('worktree').some((r: any) => r.id === L)} entities=${JSON.stringify(Object.keys(g.tables))}`)
    }
    const ctx2 = await startScenarioEngine(2)
    const feeds2 = openFenceFeeds(ctx2, 'overlaid')
    const fresh = mobxPoolArm.create(feeds2.rows.source, feeds2.locals.source)
    fresh.snapshot()
    show(fresh.pool, 'fresh2x')
    console.info(`[probe] engine now rescoped=${ctx.engine.getSnapshot().coarseNow} fresh=${ctx2.engine.getSnapshot().coarseNow}`)
    fresh.dispose(); feeds2.dispose(); ctx2.engine.destroy()
    handle.dispose(); feeds.dispose(); ctx.engine.destroy()
  }, 600_000)
})
