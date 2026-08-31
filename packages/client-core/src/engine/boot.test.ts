import { describe, expect, it } from 'vitest'
import { BootFetches } from './boot'
import type { EngineState } from './state'

/**
 * refreshRepos coalescing (perf round): a cold boot fires the refresh from the
 * boot fan-out, the machines listener and worktreesChanged in overlapping
 * fashion, and each used to cost a concurrent server-side enrichment mutation.
 * The contract now: one mutation in flight at a time, mid-flight triggers join
 * ONE trailing follow-up run (never stale relative to their cause, never a
 * dropped trigger), and a settled instance coalesces nothing.
 */

type Deferred = { resolve: () => void; reject: (error: unknown) => void }

function makeFetches() {
  const deferreds: Deferred[] = []
  const patches: Partial<EngineState>[] = []
  let calls = 0
  const api = {
    discovery: {
      refreshRepos: {
        mutate: () =>
          new Promise<{ repositories: unknown[]; diagnostics: unknown[] }>((resolve, reject) => {
            calls += 1
            deferreds.push({
              resolve: () => resolve({ repositories: [], diagnostics: [] }),
              reject,
            })
          }),
      },
    },
  }
  const fetches = new BootFetches({
    // Only the discovery surface is exercised here; the rest of the api and the
    // layout controller are never touched by refreshRepos.
    api: api as never,
    publish: (patch) => patches.push(patch),
    replicatedLayout: {} as never,
  })
  return { fetches, deferreds, patches, calls: () => calls }
}

/** Let queued promise reactions run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('BootFetches.refreshRepos coalescing', () => {
  it('runs overlapping triggers as one in-flight mutation plus one trailing run', async () => {
    const { fetches, deferreds, calls } = makeFetches()
    const first = fetches.refreshRepos()
    // Three triggers land while the first mutation is on the wire.
    const second = fetches.refreshRepos()
    const third = fetches.refreshRepos()
    expect(calls()).toBe(1)
    // The mid-flight joiners share one promise — the single trailing run.
    expect(second).toBe(third)

    deferreds[0]?.resolve()
    await first
    await tick()
    // Exactly one follow-up went on the wire for all mid-flight triggers.
    expect(calls()).toBe(2)
    deferreds[1]?.resolve()
    await Promise.all([second, third])
    expect(calls()).toBe(2)
  })

  it('coalesces nothing once settled: a later trigger is a fresh mutation', async () => {
    const { fetches, deferreds, calls } = makeFetches()
    const first = fetches.refreshRepos()
    deferreds[0]?.resolve()
    await first
    const second = fetches.refreshRepos()
    expect(calls()).toBe(2)
    deferreds[1]?.resolve()
    await second
    expect(calls()).toBe(2)
  })

  it('still runs the trailing refresh when the in-flight one fails', async () => {
    const { fetches, deferreds, calls } = makeFetches()
    const first = fetches.refreshRepos()
    const trailing = fetches.refreshRepos()
    deferreds[0]?.reject(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await tick()
    // The trailing run is owed regardless of the first run's outcome.
    expect(calls()).toBe(2)
    deferreds[1]?.resolve()
    await expect(trailing).resolves.toBeUndefined()
  })

  it('publishes the loading flips per run, ending settled', async () => {
    const { fetches, deferreds, patches } = makeFetches()
    const first = fetches.refreshRepos()
    const trailing = fetches.refreshRepos()
    deferreds[0]?.resolve()
    await first
    await tick()
    deferreds[1]?.resolve()
    await trailing
    const loading = patches
      .filter((patch) => 'reposLoading' in patch)
      .map((patch) => patch.reposLoading)
    expect(loading).toEqual([true, false, true, false])
  })
})
