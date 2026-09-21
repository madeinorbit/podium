// Temporary debug 10. DELETE.
import { expect, it } from 'vitest'
import { buildCorpus } from '../../harness/src/fixture/index'
import { startEngineFromCorpus } from '../../harness/src/engine-bootstrap'
import { createRowSource } from '../../shared/src/row-source'
import { tanstackArm } from './arm'
import type { TanStackStore } from './store'

it('inspect diff issues', async () => {
  const corpus = buildCorpus(1, 4443)
  const boot = await startEngineFromCorpus(corpus)
  try {
    const source = createRowSource(boot.engine, boot.replica)
    const locals = {
      selectedIssueId: null as string | null,
      coarseNow: boot.engine.getSnapshot().coarseNow,
    }
    const handle = tanstackArm.create(source.source, locals)
    try {
      const store = (handle as unknown as { store: TanStackStore }).store
      const snap = boot.engine.getSnapshot()
      for (const id of ['i112']) {
        const guests = snap.sessions.filter((x) => typeof x.cwd === 'string' && (x.cwd === '/w/31' || x.cwd.startsWith('/w/31/')))
        console.info(`[inspect] w31 guests=${JSON.stringify(guests.map((g) => ({ sid: g.sessionId, issue: (g as { issueId?: string }).issueId, phase: (g.agentState as { phase?: string } | undefined)?.phase, offer: g.offer !== undefined })))}`)
      }
      for (const _id of ['i112']) {
        for (const sid of ['s562', 's1752']) {
          const srow = snap.sessions.find((x) => x.sessionId === sid)
          console.info(`[inspect] ${sid}=${JSON.stringify(srow)}`)
        }
        const narrow = (store.base.narrowQ.toArray as { sid: string }[]).map((r) => r.sid)
        console.info(`[inspect] narrow has s562=${narrow.includes('s562')} s1752=${narrow.includes('s1752')} s212=${narrow.includes('s212')}`)
        const member = (store.base.memberQ.toArray as { sid: string; owner: string | null }[]).filter((r) => ['s562','s1752','s212'].includes(r.sid))
        console.info(`[inspect] member=${JSON.stringify(member)}`)
        const px = store.prefix as unknown as { resolveCwd(cwd: string): string | null }
        console.info(`[inspect] resolve /w/31/src=${px.resolveCwd('/w/31/src')}`)
      }
      for (const _x of ['i112']) {
        const issue = snap.issues.find((i) => i.id === id)
        console.info(`[inspect] ${id} issue=${JSON.stringify(issue)}`)
        const sfull = snap.sessions.filter((x) => (x as { issueId?: string }).issueId === id)
        console.info(`[inspect] ${id} full sessions=${JSON.stringify(sfull)}`)
      }
      for (const id of ['i112', 'i122', 'i329', 'i8']) {
        const sessions = snap.sessions.filter(
          (s) => (s as { issueId?: string }).issueId === id,
        )
        console.info(
          `[inspect] ${id} sessions=${JSON.stringify(sessions.map((s) => ({ sid: s.sessionId, kind: s.agentKind, status: s.status, archived: s.archived, headless: (s as { headless?: boolean }).headless, phase: (s.agentState as { phase?: string } | undefined)?.phase, offer: s.offer !== undefined })))}`,
        )
        const inner = store.rollup as unknown as { childrenByParent: Map<string, Set<string>>; parentOf: Map<string, string>; final: Set<string> }
        const kids: Record<string, string[]> = {}
        for (const [k, v] of inner.childrenByParent) kids[k] = [...v]
        console.info(`[inspect] ${id} parent=${inner.parentOf.get(id)} kids=${JSON.stringify(kids[id] ?? [])} final=${inner.final.has(id)}`)
      }
    } finally {
      handle.dispose()
    }
    source.dispose()
  } finally {
    boot.engine.destroy()
  }
}, 120_000)
