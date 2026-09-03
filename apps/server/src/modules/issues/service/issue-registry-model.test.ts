/**
 * THE ISSUE REGISTRY'S MUTABLE-STATE MODEL [POD-3259, spec §3.6 model (b)].
 *
 * `IssueRegistry.rows` is process-owned mutable state. Until this issue every
 * mutation path took the MAP'S OWN object, assigned onto it, persisted it, and
 * put a backup back by assignment if the commit threw. That is correct exactly
 * while nothing can run between the assignment and the commit — which is the
 * property this epic is about to remove.
 *
 * HOW AN INTERLEAVING IS PRODUCED HERE, and why it is not a barrier. The
 * generic model tests in `store/executor/state-models.test.ts` park an async
 * persistence fake, because `DraftRegistry` is already async. This registry is
 * not: `persist` is synchronous top to bottom, so there is no await to park on
 * and a barrier could only ever be released after the write had finished. What
 * IS available is the ledger's `transact` seam, and re-entering the registry
 * from inside an open write span produces exactly the window an awaited commit
 * will open — the same technique POD-3258's guard tests used for the same
 * reason. Each case says which line of spec §2.5 item 9 it stands for.
 */

import { asSessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import type { LedgerDeps } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../../store'
import { StaleIssueRevisionError } from '../../../store/issue-revision'
import { type IssueDeps, IssueService } from '../service'
import { issueTestPlumbing } from './test-plumbing'

interface Harness {
  store: SessionStore
  svc: IssueService
  /**
   * Run `fn` inside the NEXT write span this registry opens, once.
   *
   * `when: 'before'` puts it between the draft being cut and the row write —
   * the window a second caller's whole update lands in. `when: 'after'` puts it
   * between the row write and the install — the window where the row is durably
   * written and the map has not moved yet, which is where a reader must still
   * see the committed value and where an eagerly installed draft would show.
   */
  duringNextWrite(fn: () => void, when?: 'before' | 'after'): void
  /** Make the next write span throw after its body has run. */
  failNextWrite(): void
}

const open = (): Harness => {
  const store = new SessionStore(':memory:')
  let during: { fn: () => void; when: 'before' | 'after' } | null = null
  let fail = false
  const transact: LedgerDeps['transact'] = (fn) => {
    const hook = during
    during = null
    const shouldFail = fail
    fail = false
    if (hook?.when === 'before') hook.fn()
    const result = fn()
    if (hook?.when === 'after') hook.fn()
    if (shouldFail) throw new Error('commit failed')
    return result
  }
  const deps: IssueDeps = {
    store,
    listSessions: () => [],
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: asSessionId('s1'), machine: 'machine-under-test' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(() => {}, { transact }),
    setSessionArchived: vi.fn(),
  }
  return {
    store,
    svc: IssueService.create(deps),
    duringNextWrite: (fn, when = 'before') => {
      during = { fn, when }
    },
    failNextWrite: () => {
      fail = true
    },
  }
}

let harness: Harness | undefined
afterEach(() => {
  harness?.store.close?.()
  harness = undefined
})

describe('draft-then-install: two updates to the same issue', () => {
  it('refuses the second install when the row moved while its write was open', () => {
    // THE SITE: `crud.ts` update() — two callers read the same row, both mutate
    // it, one commits. Under the old model the loser's rollback-by-assignment
    // wrote the WINNER's row back to a stale value, silently, with both callers
    // told they succeeded.
    harness = open()
    const { svc } = harness
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id

    // The second update runs INSIDE the first one's write span, so it reads the
    // row at the revision the first update was cut from and commits first.
    harness.duringNextWrite(() => {
      svc.update(id, { title: 'from the inner write' })
    })
    expect(() => svc.update(id, { title: 'from the outer write' })).toThrow(StaleIssueRevisionError)

    // The winner's row survives intact: the loser never touched it, and its
    // title is not half-applied over the winner's.
    expect(svc.get(id)?.title).toBe('from the inner write')
  })

  it('leaves the map row untouched while a write is open, and after it fails', () => {
    // The rollback case, with nothing to roll back. Asserted DURING the span as
    // well as after it: a draft installed eagerly would be observable here and
    // restored by the time the throw arrives, which is indistinguishable from
    // correct if you only look at the end state.
    harness = open()
    const { svc } = harness
    const id = svc.create({ repoPath: '/repo', title: 'settled', startNow: false }).id
    const before = svc.get(id)

    let observedDuringWrite: string | undefined
    harness.duringNextWrite(() => {
      observedDuringWrite = svc.get(id)?.title
    }, 'after')
    harness.failNextWrite()
    expect(() => svc.update(id, { title: 'never committed' })).toThrow('commit failed')

    expect(observedDuringWrite, 'no reader sees the uncommitted title').toBe('settled')
    expect(svc.get(id)?.title).toBe('settled')
    expect(svc.get(id)?.revision).toBe(before?.revision)
  })

  it('refuses the map-owned row outright rather than persisting it', () => {
    // The mechanism assertion. Every mutation path was converted to take a
    // draft; this is what makes a path that forgets fail loudly instead of
    // working by accident for as long as the store stays synchronous.
    harness = open()
    const { svc } = harness
    const id = svc.create({ repoPath: '/repo', title: 'shared', startNow: false }).id
    // The facade forwards `rows` and `persistRow` to the registry itself.
    const mapOwned = svc.rows.get(id)
    expect(mapOwned).toBeDefined()
    if (!mapOwned) throw new Error('unreachable')
    mapOwned.title = 'mutated in place'
    expect(() => svc.persistRow(mapOwned)).toThrow(/mutated in place/)
  })
})

describe('draft-then-install: a rollback racing a successful update', () => {
  it('does not let the failing write undo the one that committed', () => {
    // spec §2.5 item 9's exact failure: the loser's restore-by-assignment used
    // to put the pre-write field set back over the winner's committed row.
    harness = open()
    const { svc } = harness
    const id = svc.create({ repoPath: '/repo', title: 'base', startNow: false }).id

    harness.duringNextWrite(() => {
      svc.update(id, { title: 'winner' })
    })
    expect(() => svc.update(id, { title: 'loser' })).toThrow(StaleIssueRevisionError)

    expect(svc.get(id)?.title).toBe('winner')
  })
})

describe('draft-then-install: an in-memory read while a write is open', () => {
  it('serves the committed row, never the draft', () => {
    harness = open()
    const { svc } = harness
    const id = svc.create({ repoPath: '/repo', title: 'committed', startNow: false }).id

    const observed: (string | undefined)[] = []
    harness.duringNextWrite(() => {
      observed.push(svc.get(id)?.title)
      observed.push(svc.list().find((issue) => issue.id === id)?.title)
    }, 'after')
    svc.update(id, { title: 'in flight' })

    expect(observed, 'both read paths see the committed value').toEqual(['committed', 'committed'])
    expect(svc.get(id)?.title).toBe('in flight')
  })
})
