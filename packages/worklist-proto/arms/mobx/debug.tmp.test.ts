import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { SMALL_CORPUS, startScenarioEngine } from '../../shared/src/scenarios'
import { snapshotFromStore } from '../../harness/src/oracle/index'
import { mobxArm } from './arm'
import type { MobXStore } from './store'
it('debug', async () => {
  const ctx = await startScenarioEngine(SMALL_CORPUS)
  const source = createRowSource(ctx.engine, ctx.replica)
  const locals = { selectedIssueId: null as string | null, coarseNow: ctx.engine.getSnapshot().coarseNow }
  const handle = mobxArm.create(source.source, locals) as unknown as { snapshot(): any; store: MobXStore }
  const store = handle.store
  const out: string[] = []
  for (const id of ['i7', 'i8', 'i9']) {
    const m = store.issues.get(id)
    const wire = ctx.engine.getSnapshot().issues.find((i: any) => i.id === id) as any
    out.push(`=== ${id} wire parentId=${wire.parentId} stage=${wire.stage} audience=${wire.audience}`)
    out.push(`  my parentOf=${store.parentOf.get(id) ?? null} children=${JSON.stringify(store.childrenByParent.get(id) ?? [])}`)
    out.push(`  my members=${JSON.stringify(store.membersOf(id).map((s) => s.sessionId))}`)
    out.push(`  my explicit=${JSON.stringify(store.explicitByIssue.get(id) ?? [])} home-sids-for-issue: sessions with issueId=${id}: ${JSON.stringify([...store.sessions.values()].filter((s) => (s.value as any).issueId === id).map((s) => s.value.sessionId))}`)
    out.push(`  my formal=${JSON.stringify(store.formalMembers(id))}`)
    out.push(`  my progress=${JSON.stringify(store.progressOf(id))} agg=${JSON.stringify(m?.aggregate)} flat=${m?.flat} visible=${m?.visible}`)
    const sids = store.membersOf(id).map((s) => s.sessionId)
    for (const sid of sids) {
      const s = store.sessions.get(sid)?.value as any
      out.push(`    sess ${sid}: phase=${s?.agentState?.phase} status=${s?.status} lastActive=${s?.lastActiveAt} stoppedAt=${s?.stoppedAt} readAt=${s?.readAt} unread=${s?.unread} archived=${s?.archived} kind=${s?.agentKind}`)
    }
  }
  const row = (await import('../../harness/src/oracle/index')).snapshotFromStore(ctx.engine.getSnapshot(), locals)
  out.push('oracle i7=' + JSON.stringify((row as any).rowsById['i7']))
  out.push('oracle i8=' + JSON.stringify((row as any).rowsById['i8']))
  out.push('oracle i9=' + JSON.stringify((row as any).rowsById['i9']))
  writeFileSync('/tmp/opencode/dbg.txt', out.join('\n'))
  handle.dispose(); source.dispose(); ctx.engine.destroy()
  expect(true).toBe(true)
}, 60_000)
