/**
 * THE NARROW READ RETURNS THE FULL READ'S ANSWER [POD-1639].
 *
 * `listForIssue` moves the membership filter from AFTER the reader-scoped
 * projection to BEFORE it. That is only sound if the pre-filter selects the same
 * sessions the post-filter would, and if narrowing the candidate set does not
 * also narrow the VISIBILITY rule. Both are asserted here against the real
 * `SessionView` — the equality is stated as an oracle (`listForIssue` vs
 * `sessionsForIssue(list())`) so a future change to membership precedence that
 * lands on one path only turns this red.
 */
import { asIssueId, asMachineId, asSessionId, type IssueId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { sessionsForIssue } from '../../issue-util'
import { SessionLifecycle } from './lifecycle'
import { Session } from './session'
import type { SessionOwnerMemo, SessionStatePrincipal } from './session-state/service'
import { SessionView, type SessionViewPorts } from './view'

const MACHINE = asMachineId('m1')
const PRINCIPAL = { userId: 'u1', role: 'admin' } as unknown as SessionStatePrincipal

function session(id: string, cwd: string, issueId?: string, spawnedBy?: string): Session {
  return new Session({
    ...(spawnedBy ? { spawnedBy } : {}),
    sessionId: asSessionId(id),
    durableLabel: `podium-${id}`,
    agentKind: 'claude-code',
    cwd,
    title: id,
    origin: { kind: 'spawn' },
    createdAt: '2026-08-04T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: MACHINE,
    ...(issueId ? { issueId: asIssueId(issueId) } : {}),
    toDaemon: vi.fn(),
  })
}

/** A view over `sessions`, where `hidden` names the session ids the visibility
 *  rule refuses. `canReadSession` counts its calls so the test can show the
 *  narrow read does not visit the sessions it no longer needs. */
function viewOver(sessions: Session[], hidden: Set<string> = new Set()) {
  const canReadCalls: string[] = []
  const ports: SessionViewPorts = {
    sessions: new Map(sessions.map((s) => [s.sessionId, s])),
    store: {
      sync: { queuedMessageCounts: async () => new Map() },
      users: { roleOf: () => 'admin' },
      issues: { getIssue: () => undefined },
      repos: { prefixForPath: () => null, resolveRepoIdForPath: () => undefined },
    } as unknown as SessionViewPorts['store'],
    machines: { machineName: () => 'box' } as unknown as SessionViewPorts['machines'],
    state: {
      canReadSession: (_p: unknown, id: string) => {
        canReadCalls.push(id)
        return !hidden.has(id)
      },
      overlay: () => ({}),
    } as unknown as SessionViewPorts['state'],
  }
  return { view: new SessionView(ports), canReadCalls, ports }
}

const WORKTREE = '/w/issue-7'
const ISSUE = 'iss_7'

/** The corpus every case runs against: explicit attachment (both directions),
 *  cwd containment, a near-miss sibling path, and an unrelated session. */
const CORPUS = () => [
  session('mine-explicit', '/elsewhere', ISSUE),
  session('mine-by-cwd', `${WORKTREE}/pkg`),
  session('mine-is-the-root', WORKTREE),
  session('other-issue-same-path', `${WORKTREE}/pkg`, 'iss_9'),
  session('sibling-prefix', '/w/issue-70'),
  session('unrelated', '/tmp'),
]

describe('SessionView.listForIssue [POD-1639]', () => {
  it('returns exactly what filtering the full list returns', async () => {
    const { view } = viewOver(CORPUS())
    const oracle = sessionsForIssue(WORKTREE, await view.list(PRINCIPAL), asIssueId(ISSUE))
    const narrow = await view.listForIssue(WORKTREE, asIssueId(ISSUE), PRINCIPAL)
    expect(narrow.map((s) => s.sessionId)).toEqual(oracle.map((s) => s.sessionId))
    expect(narrow).toEqual(oracle)
    // Named, so a predicate that silently widened is visible in the diff.
    expect(narrow.map((s) => s.sessionId)).toEqual([
      'mine-explicit',
      'mine-by-cwd',
      'mine-is-the-root',
    ])
  })

  it('still applies the visibility rule to the members it keeps', async () => {
    const { view } = viewOver(CORPUS(), new Set(['mine-by-cwd']))
    const oracle = sessionsForIssue(WORKTREE, await view.list(PRINCIPAL), asIssueId(ISSUE))
    expect(await view.listForIssue(WORKTREE, asIssueId(ISSUE), PRINCIPAL)).toEqual(oracle)
    expect(oracle.map((s) => s.sessionId)).toEqual(['mine-explicit', 'mine-is-the-root'])
  })

  it('visibility-checks the members only — that saving IS the fix', async () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    await view.list(PRINCIPAL)
    expect(canReadCalls.length).toBe(6)
    canReadCalls.length = 0
    await view.listForIssue(WORKTREE, asIssueId(ISSUE), PRINCIPAL)
    expect(canReadCalls).toEqual(['mine-explicit', 'mine-by-cwd', 'mine-is-the-root'])
  })

  it('an issue with no worktree and no attached session costs nothing', async () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    expect(await view.listForIssue(null, asIssueId('iss_none') as IssueId, PRINCIPAL)).toEqual([])
    expect(canReadCalls).toEqual([])
  })
})

/**
 * THE BY-ID READ RETURNS THE FULL READ'S ANSWER [POD-1646].
 *
 * Same oracle discipline as above, against the shape 36 call sites spelled:
 * `list().find((s) => s.sessionId === id)`. The interesting cases are the two
 * that are not "it found it" — an invisible session must still come back
 * `undefined` (narrowing the candidate set must not widen visibility), and an
 * absent id must not throw.
 */
describe('SessionView.byId [POD-1646]', () => {
  const oracleById = async (view: SessionView, id: string) =>
    (await view.list(PRINCIPAL)).find((s) => s.sessionId === id)

  it('returns exactly what finding in the full list returns', async () => {
    const { view } = viewOver(CORPUS())
    for (const id of CORPUS().map((s) => s.sessionId)) {
      expect(await view.byId(asSessionId(id), PRINCIPAL)).toEqual(await oracleById(view, id))
    }
    expect((await view.byId(asSessionId('mine-by-cwd'), PRINCIPAL))?.sessionId).toBe('mine-by-cwd')
  })

  it('still applies the visibility rule to the one session', async () => {
    const { view } = viewOver(CORPUS(), new Set(['mine-by-cwd']))
    expect(await oracleById(view, 'mine-by-cwd')).toBeUndefined()
    expect(await view.byId(asSessionId('mine-by-cwd'), PRINCIPAL)).toBeUndefined()
    // The neighbours are unaffected — the check narrowed, the rule did not.
    expect((await view.byId(asSessionId('unrelated'), PRINCIPAL))?.sessionId).toBe('unrelated')
  })

  it('an id that names nothing is undefined, not a throw', async () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    expect(await view.byId(asSessionId('ghost'), PRINCIPAL)).toBeUndefined()
    expect(canReadCalls).toEqual([])
  })

  it('visibility-checks ONE session — that count IS the fix', async () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    await view.list(PRINCIPAL)
    expect(canReadCalls.length).toBe(6)
    canReadCalls.length = 0
    await view.byId(asSessionId('unrelated'), PRINCIPAL)
    expect(canReadCalls).toEqual(['unrelated'])
  })
})

describe('SessionView.spawnedByOf [POD-1646]', () => {
  const CHILD = () => [
    session('parent', '/w', undefined),
    session('child', '/w', undefined, 'session:parent'),
  ]

  it('returns what the wired lookup put on `spawnedBy`', async () => {
    const { view } = viewOver(CHILD())
    for (const id of ['parent', 'child']) {
      const wired = (await view.list(PRINCIPAL)).find((s) => s.sessionId === id)?.spawnedBy
      expect(await view.spawnedByOf(asSessionId(id), PRINCIPAL)).toBe(wired)
    }
    expect(await view.spawnedByOf(asSessionId('child'), PRINCIPAL)).toBe('session:parent')
    expect(await view.spawnedByOf(asSessionId('parent'), PRINCIPAL)).toBeUndefined()
  })

  it('refuses an invisible session and an absent one alike', async () => {
    const { view } = viewOver(CHILD(), new Set(['child']))
    expect(await view.spawnedByOf(asSessionId('child'), PRINCIPAL)).toBeUndefined()
    expect(await view.spawnedByOf(asSessionId('ghost'), PRINCIPAL)).toBeUndefined()
  })
})

describe('SessionView.byIds [POD-2322]', () => {
  it('equals full-list filtering in source order and deduplicates ids', async () => {
    const { view } = viewOver(CORPUS(), new Set(['mine-by-cwd']))
    const ids = [
      asSessionId('unrelated'),
      asSessionId('mine-explicit'),
      asSessionId('ghost'),
      asSessionId('unrelated'),
      asSessionId('mine-by-cwd'),
    ]
    const wanted = new Set(ids)
    const expected = (await view.list(PRINCIPAL)).filter((row) => wanted.has(row.sessionId))
    expect(await view.byIds(ids, PRINCIPAL)).toEqual(expected)
    expect(expected.map((row) => row.sessionId)).toEqual(['mine-explicit', 'unrelated'])
  })

  it('does no projection work for an empty set and only visits resident requested ids', async () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    expect(await view.byIds([], PRINCIPAL)).toEqual([])
    expect(canReadCalls).toEqual([])
    await view.byIds(
      [asSessionId('unrelated'), asSessionId('ghost'), asSessionId('unrelated')],
      PRINCIPAL,
    )
    expect(canReadCalls).toEqual(['unrelated'])
  })
})

describe('SessionLifecycle.sessionRoutingFacts [POD-2322]', () => {
  it('copies only routing fields from live sessions without invoking the view', () => {
    const sessions = CORPUS().slice(0, 2)
    const wire = vi.fn()
    const lifecycle = { sessions, view: { wire } } as unknown as SessionLifecycle
    const facts = SessionLifecycle.prototype.sessionRoutingFacts.call({
      ...lifecycle,
      sessions: new Map(sessions.map((row) => [row.sessionId, row])),
    })
    expect(facts.map((fact) => fact.sessionId)).toEqual(['mine-explicit', 'mine-by-cwd'])
    expect(Object.keys(facts[0]!).sort()).toEqual(
      ['agentKind', 'archived', 'cwd', 'issueId', 'sessionId', 'status'].sort(),
    )
    expect(facts[0]).toMatchObject({ issueId: asIssueId(ISSUE), cwd: '/elsewhere' })
    expect(wire).not.toHaveBeenCalled()
  })
})

/**
 * THE VISIBILITY VERDICT IS A RESOLVED BOOLEAN [POD-3534].
 *
 * `project()` once read `candidates.filter((s) => canReadSession(...))`. A
 * pending promise is truthy, so that filter kept EVERY element — at this exact
 * site, every session in the fleet projected to every reader. Its two siblings
 * in the same cascade fail the same way and just as quietly: `spawnedByOf`'s
 * `if (!canReadSession(...))` can never refuse, because `!promise` is always
 * false; and a floating `primeOwnerMemo` leaves the pass's memo unprimed at the
 * moment the first verdict is asked for.
 *
 * WHY THE FIXTURES ABOVE DO NOT CATCH IT, AND WHAT THESE DO DIFFERENTLY.
 * `viewOver`'s `canReadSession` is SYNCHRONOUS. It returns a real boolean, so
 * `.filter(p)` and `.filter(await p)` are indistinguishable through it — a sync
 * double cannot exercise an await at all. Every double below is async, matching
 * the service.
 *
 * And the assertions are about the SET. The plausible wrong answer here is not
 * "nothing" but "too many": a test asserting a reader sees a session passes on
 * the broken code, because the broken code shows it every session. So each case
 * names the exact ids, and the refusal cases assert against a value the broken
 * code would return — `hidden-child` carries a `spawnedBy` precisely so that
 * `spawnedByOf`'s bypass answers with a plausible string rather than undefined.
 */
describe('SessionView visibility is awaited [POD-3534]', () => {
  const READER = { userId: 'u_reader', role: 'admin' } as unknown as SessionStatePrincipal

  /** The corpus: one session the reader may see, two it may not. Three, so a
   *  bypass that keeps everything is a set of 3 against an expected set of 1 —
   *  a difference no non-emptiness check can express. */
  const FLEET = () => [
    session('theirs-before', '/w/a'),
    session('mine', '/w/b'),
    session('hidden-child', '/w/c', undefined, 'session:mine'),
  ]

  /**
   * An ASYNC view, where `readable` names the ids the rule admits.
   *
   * `canReadSession` answers from the pass memo when it is primed and from a
   * per-session read when it is not — the SAME verdict either way, which is the
   * point: priming is a batching optimisation, so it cannot be pinned by the
   * set. `perSessionGrantReads` records the reads priming exists to remove, so
   * a floating `primeOwnerMemo` is observable as work done rather than as a
   * function called.
   */
  function asyncViewOver(sessions: Session[], readable: Set<string>, primeFails = false) {
    const perSessionGrantReads: string[] = []
    const key = (id: string) => `session:${id}`
    const ports: SessionViewPorts = {
      sessions: new Map(sessions.map((s) => [s.sessionId, s])),
      store: {
        sync: { queuedMessageCounts: async () => new Map() },
        users: { roleOf: async () => 'admin' },
        issues: { getIssue: async () => undefined, getIssues: async () => new Map() },
        repos: { prefixForPath: async () => null, resolveRepoIdForPath: async () => undefined },
      } as unknown as SessionViewPorts['store'],
      machines: { machineName: async () => 'box' } as unknown as SessionViewPorts['machines'],
      state: {
        primeOwnerMemo: async (memo: SessionOwnerMemo, ids: readonly string[]) => {
          // A REAL round trip, not a microtask. The prime reads the store twice;
          // a double that settles in one microtask settles before the verdicts
          // resume even when nobody awaited it, so it cannot tell a floating
          // prime from an awaited one — the same blindness a synchronous double
          // has about the filter, one layer down.
          await new Promise((resolve) => setTimeout(resolve, 0))
          if (primeFails) throw new Error('prime failed')
          for (const id of ids) {
            memo.grants.set(key(id), readable.has(id) ? [READER.userId] : [])
          }
        },
        canReadSession: async (_p: unknown, id: string, memo?: SessionOwnerMemo) => {
          await Promise.resolve()
          const primed = memo?.grants.get(key(id))
          if (primed === undefined) {
            perSessionGrantReads.push(id)
            return readable.has(id)
          }
          return primed.includes(READER.userId)
        },
        overlay: async () => ({}),
      } as unknown as SessionViewPorts['state'],
    }
    return { view: new SessionView(ports), perSessionGrantReads }
  }

  it('projects EXACTLY the sessions the rule admits, not every candidate', async () => {
    const { view } = asyncViewOver(FLEET(), new Set(['mine']))
    // The whole assertion is the set. `toContain('mine')` passes on the bypass,
    // because the bypass returns 'mine' AND both sessions it must not.
    expect((await view.list(READER)).map((s) => s.sessionId)).toEqual(['mine'])
  })

  it('shows a reader who may see NOTHING nothing at all', async () => {
    const { view } = asyncViewOver(FLEET(), new Set())
    expect(await view.list(READER)).toEqual([])
    expect(await view.listForIssue('/w/c', undefined, READER)).toEqual([])
    expect(await view.byIds([asSessionId('mine'), asSessionId('hidden-child')], READER)).toEqual([])
  })

  it('refuses one invisible session on every narrowed read', async () => {
    const { view } = asyncViewOver(FLEET(), new Set(['mine']))
    expect(await view.byId(asSessionId('hidden-child'), READER)).toBeUndefined()
    expect((await view.byId(asSessionId('mine'), READER))?.sessionId).toBe('mine')
    const all = await view.byIds(FLEET().map((s) => s.sessionId), READER)
    expect(all.map((s) => s.sessionId)).toEqual(['mine'])
  })

  it('spawnedByOf REFUSES an invisible session rather than answering it', async () => {
    const { view } = asyncViewOver(FLEET(), new Set(['mine']))
    // `hidden-child` has a spawnedBy, so the bypass — where `!promise` is always
    // false and the guard falls through — returns this plausible string. An
    // assertion that merely tolerated a defined result would pass on it.
    expect(await view.spawnedByOf(asSessionId('hidden-child'), READER)).toBeUndefined()
    expect(await view.spawnedByOf(asSessionId('mine'), READER)).toBeUndefined()
    const { view: open } = asyncViewOver(FLEET(), new Set(['hidden-child']))
    expect(await open.spawnedByOf(asSessionId('hidden-child'), READER)).toBe('session:mine')
  })

  it('primes the pass memo BEFORE the first verdict is asked for', async () => {
    const { view, perSessionGrantReads } = asyncViewOver(FLEET(), new Set(['mine']))
    expect((await view.list(READER)).map((s) => s.sessionId)).toEqual(['mine'])
    // A floating prime leaves the memo empty at verdict time, so every session
    // pays the per-resource read the priming exists to remove — the same set,
    // three reads instead of none. The count is the only witness.
    expect(perSessionGrantReads).toEqual([])
  })

  it('a failing prime fails the pass instead of being lost as a floating promise', async () => {
    const { view } = asyncViewOver(FLEET(), new Set(['mine']), true)
    // Rule 56a's discrimination check, stated the other way round: a prime that
    // REJECTS proves the caller is joined to it. Floating, the rejection is lost
    // and the pass answers as though the memo had been filled.
    await expect(view.list(READER)).rejects.toThrow('prime failed')
  })
})


describe('SessionView durable queue display', () => {
  it('reads stored rows despite drift in both live and draft session counts', async () => {
    const store = await openTestStore(':memory:')
    const current = session('queue-display', '/w')
    const other = session('other-queue', '/w')
    const { view, ports } = viewOver([current, other])
    ports.store = store
    const countReads = vi.spyOn(store.sync, 'queuedMessageCounts')
    try {
      for (const [id, owner] of [['first', current], ['second', current], ['other', other]] as const) {
        await store.sync.enqueueMessage({ id, sessionId: owner.sessionId, text: id, queuedAt: 1 })
      }
      current.queuedMessageCount = 0
      other.queuedMessageCount = 99
      expect((await view.list(PRINCIPAL)).map((meta) => meta.queuedMessageCount)).toEqual([2, 1])
      expect(countReads).toHaveBeenCalledTimes(1)
      expect((await view.byId(current.sessionId, PRINCIPAL))?.queuedMessageCount).toBe(2)
      const draft = current.captureDurableState()
      draft.queuedMessageCount = 45
      expect((await view.wire(current, PRINCIPAL, undefined, draft)).queuedMessageCount).toBe(2)
      await store.sync.deleteQueuedMessage('first')
      expect((await view.wire(current, PRINCIPAL, undefined, draft)).queuedMessageCount).toBe(1)
      await store.sync.deleteQueuedMessage('second')
      current.queuedMessageCount = 99
      expect(await view.wire(current, PRINCIPAL, undefined, draft)).not.toHaveProperty('queuedMessageCount')
      expect((await view.list(PRINCIPAL))[0]).not.toHaveProperty('queuedMessageCount')
    } finally {
      await store.close()
    }
  })
})
