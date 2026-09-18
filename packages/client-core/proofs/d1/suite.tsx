import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type * as TestingLibrary from '@testing-library/react'
import { useEffect, useSyncExternalStore } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { autorun, onBecomeUnobserved } from 'mobx'
import { createKeyedProof, KeyedRow, KeyedSummary, KeyedGroup } from './keyed'
import { createMobxProof, MobxRow, MobxSummary, MobxGroup } from './mobx'
import { createTanstackProof, TanstackRow, TanstackSummary, TanstackGroup } from './tanstack'
import { fixture, NOW, counters, summaryJS, worklistJS, GROUP, type Counts } from './model'

// Compare wire/domain semantics; TanStack adds these four documented virtual
// properties to query rows. Keep every application field and array order exact.
const virtualKeys = new Set(['$synced', '$origin', '$key', '$collectionId'])
const domainValue = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => virtualKeys.has(key) ? undefined : item))
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const gc = () => {
  const runtime = globalThis as typeof globalThis & { Bun?: { gc: (sync: boolean) => void }; gc?: () => void }
  if (runtime.Bun) { runtime.Bun.gc(true); return 'Bun.gc(true)' }
  if (runtime.gc) { runtime.gc(); return 'gc()' }
  return 'unforced heap (GC unavailable)'
}
const diff = (a: Counts, b: Counts) => Object.fromEntries(Object.keys(a).map(k => [k, a[k as keyof Counts] - b[k as keyof Counts]]))
const distribution = (xs: number[]) => ({ n: xs.length, p50: [...xs].sort((a,b) => a-b)[Math.floor(xs.length * .5)], p95: [...xs].sort((a,b) => a-b)[Math.min(xs.length-1, Math.floor(xs.length * .95))] })

/** Test harness only: deliberately no production adapter or multi-library API. */
export function registerProofSuite(platform: string, { act, cleanup, render }: Pick<typeof TestingLibrary, 'act' | 'cleanup' | 'render'>) {
  const results: unknown[] = []
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
  afterAll(() => {
    if (process.env.PODIUM_D1_PROOF !== '1') return
    let root = process.cwd()
    while (!existsSync(join(root, 'packages/client-core/package.json')) && dirname(root) !== root) root = dirname(root)
    if (!existsSync(join(root, 'packages/client-core/package.json'))) throw new Error('D1 repository root not found')
    const directory = join(root, 'packages/client-core/proofs/d1/results')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${platform}.json`), JSON.stringify({ platform, node: process.version,
      baseline: 'POD-4358-post-b-baseline.md', measurements: results }, null, 2) + '\n')
  })
  describe.skipIf(process.env.PODIUM_D1_PROOF !== '1')(`D1 ${platform}: identical real-shape proof`, () => {
    for (const candidate of (process.env.PODIUM_D7_PROOF === '1' ? ['mobx', 'keyed'] as const : ['mobx', 'tanstack', 'keyed'] as const))
      for (const readers of [200, 1000])
        for (const addressing of ['same', 'distinct'] as const)
          it(`${candidate}: ${readers} ${addressing} row readers`, async () => {
            const data = fixture()
            const gcMethod = gc(), heapBefore = process.memoryUsage().heapUsed
            const start = performance.now()
            const mobx = candidate === 'mobx' ? createMobxProof(data) : undefined
            const tanstack = candidate === 'tanstack' ? createTanstackProof(data) : undefined
            const keyed = candidate === 'keyed' ? createKeyedProof(data) : undefined
            const proof = mobx ?? tanstack ?? keyed!
            let reads = 0, commits = 0, summaryReads = 0, groupReads = 0
            let summaryValue: unknown, groupValue: unknown
            const read = () => { reads++ }, commit = () => { commits++ }
            const summaryRead = (value: unknown) => { summaryReads++; summaryValue = value }
            const groupRead = (value: unknown) => { groupReads++; groupValue = value }
            const elements = <>
              {Array.from({ length: readers }, (_, n) => {
                const id = `s${addressing === 'same' ? 0 : n}`
                return mobx ? <MobxRow key={n} proof={mobx} id={id} read={read} commit={commit} />
                  : keyed ? <KeyedRow key={n} proof={keyed} id={id} read={read} commit={commit} />
                  : <TanstackRow key={n} proof={tanstack!} id={id} reader={n} read={read} commit={commit} />
              })}
              {[0, 1].map(n => mobx ? <MobxSummary key={`summary${n}`} proof={mobx} read={summaryRead} />
                : keyed ? <KeyedSummary key={`summary${n}`} proof={keyed} read={summaryRead} />
                : <TanstackSummary key={`summary${n}`} proof={tanstack!} read={summaryRead} />)}
              {mobx ? <MobxGroup proof={mobx} read={groupRead} /> : keyed ? <KeyedGroup proof={keyed} read={groupRead} /> : <TanstackGroup proof={tanstack!} read={groupRead} />}
            </>
            const view = render(elements)
            await act(settle)
            const stopNative = tanstack?.observeNative()
            const bootstrapMs = performance.now() - start
            gc(); const mountedHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore
            const oracle = () => summaryJS(data.issues[0]!, data.sessions.filter(s => s.issueId === 'i0'), data.issues.filter(i => i.parentId === 'i0'), counters())
            expect(summaryValue).toEqual(oracle())
            expect(domainValue(groupValue)).toEqual(worklistJS(data.issues.slice(0, GROUP), data.sessions.slice(0, GROUP), NOW, counters()))
            const scenarios: Record<string, unknown> = {}
            for (const [name, index] of [['unrelated', 4000], ['relevant', 0]] as const) {
              reads = commits = summaryReads = groupReads = 0
              const before = { ...proof.counts }, times: number[] = [], syncTimes: number[] = []
              for (let n = 0; n < 20; n++) {
                const next = { ...data.sessions[index]!, lastActiveAt: new Date(NOW + (n + 1) * 1000).toISOString() }
                data.sessions[index] = next
                const t = performance.now()
                await act(async () => { const s = performance.now(); proof.update(next); syncTimes.push(performance.now() - s); await settle() })
                times.push(performance.now() - t)
                expect(domainValue(groupValue)).toEqual(worklistJS(data.issues.slice(0, GROUP), data.sessions.slice(0, GROUP), NOW, counters()))
              }
              scenarios[name] = { readers: reads, commits, summaryReaders: summaryReads, groupReaders: groupReads,
                wallMs: distribution(times), syncMs: distribution(syncTimes), operations: diff(proof.counts, before) }
              if (name === 'unrelated') { expect(reads).toBe(0); expect(commits).toBe(0); expect(summaryReads).toBe(0); expect(groupReads).toBe(0) }
              else { expect(reads).toBe(20 * (addressing === 'same' ? readers : 1)); expect(commits).toBe(reads); expect(summaryValue).toEqual(oracle()) }
            }
            // Relational changes must update membership and shared summary, not just timestamps.
            data.sessions[1] = { ...data.sessions[1]!, issueId: data.issues[0]!.id }
            await act(async () => { proof.update(data.sessions[1]!); await settle() })
            expect(summaryValue).toEqual(oracle())
            data.issues[2] = { ...data.issues[2]!, stage: 'done' }
            await act(async () => { proof.updateIssue(data.issues[2]!); await settle() })
            expect(summaryValue).toEqual(oracle())
            data.issues[0] = { ...data.issues[0]!, readAt: new Date(NOW + 60_000).toISOString() }
            await act(async () => { proof.updateIssue(data.issues[0]!); await settle() })
            expect(summaryValue).toEqual(oracle())
            data.issues[4] = { ...data.issues[4]!, parentId: data.issues[5]!.id }
            await act(async () => { proof.updateIssue(data.issues[4]!); await settle() })
            expect(summaryValue).toEqual(oracle())
            // Exercise family caching beyond the timed timestamp-only stream.
            for (const patch of [{ archived: true }, { archived: false, issueId: 'i5' }, { issueId: 'i0' }]) {
              data.sessions[0] = { ...data.sessions[0]!, ...patch } as typeof data.sessions[number]
              await act(async () => { proof.update(data.sessions[0]!); await settle() })
              expect(summaryValue).toEqual(oracle())
              expect(domainValue(groupValue)).toEqual(worklistJS(data.issues.slice(0, GROUP), data.sessions.slice(0, GROUP), NOW, counters()))
            }
            // Provenance takes the conservative whole-group cache fallback.
            data.issues[5] = { ...data.issues[5]!, startedBySession: data.sessions[0]!.sessionId }
            await act(async () => { proof.updateIssue(data.issues[5]!); await settle() })
            expect(domainValue(groupValue)).toEqual(worklistJS(data.issues.slice(0, GROUP), data.sessions.slice(0, GROUP), NOW, counters()))
            const beforeTick = { ...proof.counts }
            await act(async () => { proof.tick(NOW + 120_000); await settle() })
            expect(domainValue(groupValue)).toEqual(worklistJS(data.issues.slice(0, GROUP), data.sessions.slice(0, GROUP), NOW + 120_000, counters()))
            const rescope: number[] = []
            for (let n = 0; n < 3; n++) {
              const next = fixture(n % 2 === 0 ? 'growth' : 'live')
              const t = performance.now()
              await act(async () => { proof.replace(next); await settle() })
              rescope.push(performance.now() - t)
              expect(domainValue(groupValue)).toEqual(worklistJS(next.issues.slice(0, GROUP), next.sessions.slice(0, GROUP), NOW + 120_000, counters()))
            }
            view.unmount(); stopNative?.(); await settle()
            if (keyed) expect(keyed.subscriberCount()).toBe(0)
            const beforeUnmounted = { ...proof.counts }
            proof.update({ ...data.sessions[0]!, lastActiveAt: new Date(NOW + 500_000).toISOString() })
            await new Promise(resolve => setTimeout(resolve, 20))
            const unobserved = diff(proof.counts, beforeUnmounted)
            expect(proof.counts.mission).toBe(beforeUnmounted.mission)
            expect(proof.counts.summary).toBe(beforeUnmounted.summary)
            await proof.dispose()
            gc()
            results.push({ candidate, readers, addressing, corpus: { issues: 4867, sessions: 4304 },
              bootstrapMs, gcMethod, mountedHeapDeltaBytes, scenarios, rescopeMs: distribution(rescope),
              clockAndRescopeOperations: diff(proof.counts, beforeTick), unobserved })
          }, 120_000)

    it('armed coarse-subscription control fails the same isolation assertion', async () => {
      let version = 0, reads = 0, commits = 0
      const listeners = new Set<() => void>()
      const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
      function CoarseRow() { useSyncExternalStore(subscribe, () => version); reads++; useEffect(() => { commits++ }); return null }
      for (const readers of [200, 1000]) {
        const view = render(<>{Array.from({ length: readers }, (_, n) => <CoarseRow key={n} />)}</>)
        reads = commits = 0
        await act(async () => { version++; for (const fn of listeners) fn(); await settle() })
        expect(() => expect(reads).toBe(0)).toThrow()
        expect(reads).toBe(readers); expect(commits).toBe(readers)
        results.push({ candidate: 'armed-coarse-control', readers, reads, commits })
        view.unmount()
      }
    })

    it.skipIf(process.env.PODIUM_D7_PROOF === '1')('dependency-ordered teardown is quiet; the source-first control is armed', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const proof = createTanstackProof(fixture())
      const subscriptions = [proof.summary, proof.summaryPhases, proof.ranked, proof.groupSessions].map(q => q.subscribeChanges(() => {}))
      await settle()
      for (const subscription of subscriptions) subscription.unsubscribe()
      await proof.dispose()
      expect(errors).not.toHaveBeenCalled()
      const control = createTanstackProof(fixture())
      const subscription = control.summaryPhases.subscribeChanges(() => {})
      await settle()
      await control.phases.cleanup()
      expect(errors).toHaveBeenCalled()
      subscription.unsubscribe(); await control.dispose()
      results.push({ teardown: 'reverse dependency order passes; source-first control emits error' })
    })

    it.skipIf(process.env.PODIUM_D7_PROOF === '1')('computed suspension and query GC release their subscriptions', async () => {
      const data = fixture(), mobx = createMobxProof(data), tanstack = createTanstackProof(data)
      let suspended = 0
      const value = mobx.summary('i0')
      const stopWatch = onBecomeUnobserved(value, () => { suspended++ })
      const stop = autorun(() => value.get())
      const query = tanstack.row('s0', 0)
      const subscription = query.subscribeChanges(() => {})
      await settle()
      stop(); subscription.unsubscribe()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(suspended).toBe(1)
      expect(query.status).toBe('cleaned-up')
      const before = mobx.counts.summary
      mobx.update({ ...data.sessions[0]!, lastActiveAt: new Date(NOW).toISOString() })
      expect(mobx.counts.summary).toBe(before)
      value.get(); value.get()
      expect(mobx.counts.summary - before).toBe(2)
      stopWatch(); await mobx.dispose(); await tanstack.dispose()
      results.push({ lifetime: { mobxSuspensions: suspended, unobservedReadsRecompute: 2, tanstackStatus: query.status, gcTimeMs: 1 } })
    })
  })
}
