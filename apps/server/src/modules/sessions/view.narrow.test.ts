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
import { asIssueId, asMachineId, asSessionId, type IssueId, type SessionMeta } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { sessionsForIssue } from '../../issue-util'
import type { StewardDeps } from '../../steward'
import type { IssueCommandDeps } from '../issues/command-ctx'
import type { IssueDeps } from '../issues/service'
import type { MessageGateDeps } from '../messages/gate'
import type { MessageDeliveryDeps } from '../messages/service'
import { SessionFactsReader } from './facts'
import type { SessionAccessDeps } from './session-access'
import type { SessionReadToolkitDeps } from './read-toolkit'
import { SessionLifecycle } from './lifecycle'
import { Session } from './session'
import type { SessionOwnerMemo, SessionStatePrincipal } from './session-state/service'
import { SessionView, type SessionListCaller, type SessionViewPorts } from './view'

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
    const oracle = sessionsForIssue(WORKTREE, await view.list(PRINCIPAL, 'rpc'), asIssueId(ISSUE))
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
    const oracle = sessionsForIssue(WORKTREE, await view.list(PRINCIPAL, 'rpc'), asIssueId(ISSUE))
    expect(await view.listForIssue(WORKTREE, asIssueId(ISSUE), PRINCIPAL)).toEqual(oracle)
    expect(oracle.map((s) => s.sessionId)).toEqual(['mine-explicit', 'mine-is-the-root'])
  })

  it('visibility-checks the members only — that saving IS the fix', async () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    await view.list(PRINCIPAL, 'rpc')
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
    (await view.list(PRINCIPAL, 'rpc')).find((s) => s.sessionId === id)

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
    await view.list(PRINCIPAL, 'rpc')
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
      const wired = (await view.list(PRINCIPAL, 'rpc')).find((s) => s.sessionId === id)?.spawnedBy
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
    const expected = (await view.list(PRINCIPAL, 'rpc')).filter((row) => wanted.has(row.sessionId))
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

/**
 * THE FACTS READ TOUCHES NOTHING BUT THE REGISTRY [POD-3857].
 *
 * This is the property the whole issue rests on. `SessionFacts` is only
 * cheaper than the projection because it does NO I/O — and "does no I/O" is not
 * something a reader of `sessionFactsOf` can keep true by intention, because
 * the tempting additions (a machine NAME, a display REF, a reader's overlay)
 * each look like one more field, and each one is a query. So the guarantee is
 * stated structurally instead: the reader is CONSTRUCTIBLE from the registry
 * map alone, and there is no second parameter through which a query could
 * arrive.
 *
 * The generalization of POD-2322's `sessionRoutingFacts`, which this replaces:
 * that one asserted an exact six-key shape, which fixed the field set rather
 * than the cost. The field set is meant to grow as callers migrate; what must
 * not grow is what the read reaches for.
 */
/**
 * A `displayRef` NEVER STANDS ALONE [POD-3857].
 *
 * `SessionReadToolkit.resolveFacts` resolves a human-facing birth ref without a
 * fleet pass by narrowing candidates on `refLetter` / `refDraft` first and
 * wiring only those. That is sound because `computeDisplayRef` FORMATS the ref
 * from exactly those parts — but the two live in different modules, and if the
 * projection ever learned to emit a `displayRef` from something else, ref
 * lookup would stop finding sessions and say "unknown session" instead of
 * failing loudly. This is the coupling, asserted where it can break.
 */
describe('displayRef implies the parts it is formatted from [POD-3857]', () => {
  const REPO = '/w'
  const ISSUE_ROW = { repoPath: REPO, seq: 529 }

  const wireWith = async (mutate: (s: Session) => void) => {
    const row = session('ref-bearer', `${REPO}/wt`)
    mutate(row)
    const ports: SessionViewPorts = {
      sessions: new Map([[row.sessionId, row]]),
      store: {
        sync: { queuedMessageCounts: async () => new Map() },
        users: { roleOf: async () => 'admin' },
        issues: { getIssue: async () => ISSUE_ROW, getIssues: async () => new Map() },
        repos: { prefixForPath: async () => 'POD', resolveRepoIdForPath: async () => undefined },
      } as unknown as SessionViewPorts['store'],
      machines: { machineName: async () => 'box' } as unknown as SessionViewPorts['machines'],
      state: {
        canReadSession: async () => true,
        overlay: async () => ({}),
      } as unknown as SessionViewPorts['state'],
    }
    return await new SessionView(ports).wire(row, PRINCIPAL)
  }

  it('an issue-born ref carries refLetter', async () => {
    const meta = await wireWith((s) => {
      s.refIssueId = asIssueId('iss_529')
      s.refLetter = 'A'
    })
    expect(meta.displayRef).toBe('POD-529-A')
    expect(meta.refLetter).toBe('A')
  })

  it('a draft ref carries refDraft', async () => {
    const meta = await wireWith((s) => {
      s.refDraft = 3
    })
    expect(meta.displayRef).toBe('POD-DRAFT-3')
    expect(meta.refDraft).toBe(3)
  })

  it('no ref parts, no displayRef — there is no third way to get one', async () => {
    const meta = await wireWith(() => {})
    expect(meta.displayRef).toBeUndefined()
  })
})

/**
 * THE COMPILE-TIME HALF OF THE GUARD [POD-3857].
 *
 * These cases assert nothing at RUNTIME on purpose — every one of them is a
 * claim about a TYPE, checked by `tsgo` over this file, and `@ts-expect-error`
 * is what makes each one armed: the line fails the build if the error it
 * predicts stops happening. A runtime assertion could not state any of them,
 * because the thing being forbidden is code that no longer compiles.
 *
 * This is the guard that actually holds the issue's acceptance. The source
 * census in `session-projection.audit.test.ts` is a backstop for the cases a
 * type cannot see (a legitimate caller growing a second call site).
 */
describe('the full projection is unreachable from internal code [POD-3857]', () => {
  it('no internal deps type exposes a full-list port', () => {
    // Each of these interfaces used to carry `listSessions`, and each had a
    // fixture-fallback comment explaining why it was safe. The fallbacks are
    // gone; so is the port. If one comes back, its line here stops erroring.
    // @ts-expect-error POD-3857: StewardDeps has no full-list port
    type _Steward = StewardDeps['listSessions']
    // @ts-expect-error POD-3857: IssueDeps has no full-list port
    type _Issue = IssueDeps['listSessions']
    // @ts-expect-error POD-3857: IssueCommandDeps has no full-list port
    type _IssueCmd = IssueCommandDeps['listSessions']
    // @ts-expect-error POD-3857: MessageGateDeps has no full-list port
    type _Gate = MessageGateDeps['listSessions']
    // @ts-expect-error POD-3857: delivery's session port has no full list
    type _Delivery = MessageDeliveryDeps['sessions']['listSessions']
    // @ts-expect-error POD-3857: the session-target resolver has no full list
    type _Access = SessionAccessDeps['listSessions']
    // @ts-expect-error POD-3857: the read toolkit has no full list
    type _Toolkit = SessionReadToolkitDeps['listSessions']
    expect(true).toBe(true)
  })

  it('the caller label is required and has no unlabeled member', () => {
    const { view } = viewOver(CORPUS())
    // A default value here is exactly how ~40 sites became `unlabeled`.
    // @ts-expect-error POD-3857: the caller label is a required argument
    void view.list(PRINCIPAL)
    // @ts-expect-error POD-3857: 'unlabeled' is not a caller
    void view.list(PRINCIPAL, 'unlabeled')
    // The three that remain, spelled out so widening the union without
    // widening the audit allowlist is visible in one diff.
    const callers: SessionListCaller[] = ['bootstrap', 'rpc', 'listAllTool']
    const exhaustive: Record<SessionListCaller, true> = {
      bootstrap: true,
      rpc: true,
      listAllTool: true,
    }
    expect(Object.keys(exhaustive).sort()).toEqual([...callers].sort())
  })

  it('facts are not assignable where a wire projection is required', () => {
    const facts = new SessionFactsReader(
      new Map(CORPUS().map((row) => [row.sessionId, row])),
    ).all()
    // The point of a separate type: trusted server-internal data cannot be
    // handed to something that publishes to a client.
    // @ts-expect-error POD-3857: SessionFacts is not a SessionMeta
    const _wire: SessionMeta[] = facts
    expect(facts.length).toBeGreaterThan(0)
  })
})

describe('SessionFactsReader [POD-3857]', () => {
  const readerOver = (sessions: Session[]) =>
    new SessionFactsReader(new Map(sessions.map((row) => [row.sessionId, row])))

  it('takes the registry map and NOTHING else', () => {
    // The cost guarantee is structural, and this is where it is stated: a
    // reader that cannot be handed a store, a machines service or a session
    // state service cannot read from one. Compare `SessionViewPorts`, which
    // takes all three. Adding a second constructor parameter — which is how
    // this would be given a way to make a query — fails here.
    expect(SessionFactsReader.length).toBe(1)
    expect(new SessionFactsReader(new Map()).all()).toEqual([])
  })

  it('answers every read from the map alone', () => {
    const reader = readerOver(CORPUS())
    expect(reader.all().map((f) => f.sessionId)).toEqual([
      'mine-explicit',
      'mine-by-cwd',
      'mine-is-the-root',
      'other-issue-same-path',
      'sibling-prefix',
      'unrelated',
    ])
    expect(reader.byId(asSessionId('mine-by-cwd'))?.cwd).toBe(`${WORKTREE}/pkg`)
    expect(reader.byId(asSessionId('ghost'))).toBeUndefined()
  })

  it('the service facade never invokes the view', () => {
    const wire = vi.fn()
    const list = vi.fn()
    // `Object.create`, not an object literal: `SessionLifecycle.facts` is a
    // lazy GETTER on the prototype, so a bare literal cast to the type reaches
    // no `facts` at all and the case fails on the fake rather than on the code.
    const lifecycle: SessionLifecycle = Object.assign(
      Object.create(SessionLifecycle.prototype) as SessionLifecycle,
      {
        sessions: new Map(CORPUS().map((row) => [row.sessionId, row])),
        view: { wire, list },
      },
    )
    const facts = lifecycle.sessionFacts()
    expect(facts.map((f) => f.sessionId)).toContain('mine-explicit')
    expect(lifecycle.sessionFactsById(asSessionId('mine-by-cwd'))?.cwd).toBe(`${WORKTREE}/pkg`)
    expect(lifecycle.sessionFactsByIssue(WORKTREE, asIssueId(ISSUE)).length).toBeGreaterThan(0)
    expect(lifecycle.sessionFactsByWorktree(WORKTREE).length).toBeGreaterThan(0)
    expect(lifecycle.sessionFactsByMachine(MACHINE).length).toBeGreaterThan(0)
    expect(wire).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('carries the fields the internal callers decide on', () => {
    const facts = readerOver(CORPUS()).byId(asSessionId('mine-explicit'))!
    expect(facts).toMatchObject({
      sessionId: 'mine-explicit',
      issueId: asIssueId(ISSUE),
      cwd: '/elsewhere',
      machineId: MACHINE,
      agentKind: 'claude-code',
      status: 'starting',
      archived: false,
      headless: false,
    })
  })

  it('carries NO field the projection has to compute', () => {
    const facts = readerOver(CORPUS()).byId(asSessionId('mine-explicit'))!
    // Each of these costs a read the facts path must never make: a repo prefix
    // and issue row (displayRef), the machines service (machineName), the
    // harness login probe (condition), the reader's own overlay (unread /
    // readAt / snoozedUntil). A caller that needs one wants a WIRED session.
    for (const forbidden of [
      'displayRef',
      'machineName',
      'condition',
      'unread',
      'readAt',
      'snoozedUntil',
    ]) {
      expect(facts, forbidden).not.toHaveProperty(forbidden)
    }
  })

  describe('selects the same set as the projection it replaces', () => {
    it('byIssue matches SessionView.listForIssue', async () => {
      const corpus = CORPUS()
      const { view } = viewOver(corpus)
      const wired = await view.listForIssue(WORKTREE, asIssueId(ISSUE), PRINCIPAL)
      expect(readerOver(corpus).byIssue(WORKTREE, asIssueId(ISSUE)).map((f) => f.sessionId)).toEqual(
        wired.map((s) => s.sessionId),
      )
    })

    it('byWorktree is DELIBERATELY wider than byIssue', () => {
      const reader = readerOver(CORPUS())
      // `other-issue-same-path` lives in the worktree under a different issue.
      // The free / GC guards must see it or they delete a path still in use;
      // membership must not, or the issue claims a session that is not its own.
      expect(reader.byWorktree(WORKTREE).map((f) => f.sessionId)).toContain(
        'other-issue-same-path',
      )
      expect(reader.byIssue(WORKTREE, asIssueId(ISSUE)).map((f) => f.sessionId)).not.toContain(
        'other-issue-same-path',
      )
      // ...and the near-miss sibling path is in neither.
      expect(reader.byWorktree(WORKTREE).map((f) => f.sessionId)).not.toContain('sibling-prefix')
    })

    it('byWorktree of no path is empty, not everything', () => {
      expect(readerOver(CORPUS()).byWorktree(null)).toEqual([])
    })

    it('byMachine partitions the fleet', () => {
      const corpus = CORPUS()
      expect(readerOver(corpus).byMachine(MACHINE)).toHaveLength(corpus.length)
      expect(readerOver(corpus).byMachine(asMachineId('m2'))).toEqual([])
    })
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
    expect((await view.list(READER, 'rpc')).map((s) => s.sessionId)).toEqual(['mine'])
  })

  it('shows a reader who may see NOTHING nothing at all', async () => {
    const { view } = asyncViewOver(FLEET(), new Set())
    expect(await view.list(READER, 'rpc')).toEqual([])
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
    expect((await view.list(READER, 'rpc')).map((s) => s.sessionId)).toEqual(['mine'])
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
    await expect(view.list(READER, 'rpc')).rejects.toThrow('prime failed')
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
      expect((await view.list(PRINCIPAL, 'rpc')).map((meta) => meta.queuedMessageCount)).toEqual([2, 1])
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
      expect((await view.list(PRINCIPAL, 'rpc'))[0]).not.toHaveProperty('queuedMessageCount')
    } finally {
      await store.close()
    }
  })
})
