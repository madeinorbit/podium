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
import { sessionsForIssue } from '../../issue-util'
import { Session } from './session'
import type { SessionStatePrincipal } from './session-state/service'
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
  return { view: new SessionView(ports), canReadCalls }
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
  it('returns exactly what filtering the full list returns', () => {
    const { view } = viewOver(CORPUS())
    const oracle = sessionsForIssue(WORKTREE, view.list(PRINCIPAL), ISSUE)
    const narrow = view.listForIssue(WORKTREE, ISSUE, PRINCIPAL)
    expect(narrow.map((s) => s.sessionId)).toEqual(oracle.map((s) => s.sessionId))
    expect(narrow).toEqual(oracle)
    // Named, so a predicate that silently widened is visible in the diff.
    expect(narrow.map((s) => s.sessionId)).toEqual([
      'mine-explicit',
      'mine-by-cwd',
      'mine-is-the-root',
    ])
  })

  it('still applies the visibility rule to the members it keeps', () => {
    const { view } = viewOver(CORPUS(), new Set(['mine-by-cwd']))
    const oracle = sessionsForIssue(WORKTREE, view.list(PRINCIPAL), ISSUE)
    expect(view.listForIssue(WORKTREE, ISSUE, PRINCIPAL)).toEqual(oracle)
    expect(oracle.map((s) => s.sessionId)).toEqual(['mine-explicit', 'mine-is-the-root'])
  })

  it('visibility-checks the members only — that saving IS the fix', () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    view.list(PRINCIPAL)
    expect(canReadCalls.length).toBe(6)
    canReadCalls.length = 0
    view.listForIssue(WORKTREE, ISSUE, PRINCIPAL)
    expect(canReadCalls).toEqual(['mine-explicit', 'mine-by-cwd', 'mine-is-the-root'])
  })

  it('an issue with no worktree and no attached session costs nothing', () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    expect(view.listForIssue(null, asIssueId('iss_none') as IssueId, PRINCIPAL)).toEqual([])
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
  const oracleById = (view: SessionView, id: string) =>
    view.list(PRINCIPAL).find((s) => s.sessionId === id)

  it('returns exactly what finding in the full list returns', () => {
    const { view } = viewOver(CORPUS())
    for (const id of CORPUS().map((s) => s.sessionId)) {
      expect(view.byId(asSessionId(id), PRINCIPAL)).toEqual(oracleById(view, id))
    }
    expect(view.byId(asSessionId('mine-by-cwd'), PRINCIPAL)?.sessionId).toBe('mine-by-cwd')
  })

  it('still applies the visibility rule to the one session', () => {
    const { view } = viewOver(CORPUS(), new Set(['mine-by-cwd']))
    expect(oracleById(view, 'mine-by-cwd')).toBeUndefined()
    expect(view.byId(asSessionId('mine-by-cwd'), PRINCIPAL)).toBeUndefined()
    // The neighbours are unaffected — the check narrowed, the rule did not.
    expect(view.byId(asSessionId('unrelated'), PRINCIPAL)?.sessionId).toBe('unrelated')
  })

  it('an id that names nothing is undefined, not a throw', () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    expect(view.byId(asSessionId('ghost'), PRINCIPAL)).toBeUndefined()
    expect(canReadCalls).toEqual([])
  })

  it('visibility-checks ONE session — that count IS the fix', () => {
    const { view, canReadCalls } = viewOver(CORPUS())
    view.list(PRINCIPAL)
    expect(canReadCalls.length).toBe(6)
    canReadCalls.length = 0
    view.byId(asSessionId('unrelated'), PRINCIPAL)
    expect(canReadCalls).toEqual(['unrelated'])
  })
})

describe('SessionView.spawnedByOf [POD-1646]', () => {
  const CHILD = () => [
    session('parent', '/w', undefined),
    session('child', '/w', undefined, 'session:parent'),
  ]

  it('returns what the wired lookup put on `spawnedBy`', () => {
    const { view } = viewOver(CHILD())
    for (const id of ['parent', 'child']) {
      const wired = view.list(PRINCIPAL).find((s) => s.sessionId === id)?.spawnedBy
      expect(view.spawnedByOf(asSessionId(id), PRINCIPAL)).toBe(wired)
    }
    expect(view.spawnedByOf(asSessionId('child'), PRINCIPAL)).toBe('session:parent')
    expect(view.spawnedByOf(asSessionId('parent'), PRINCIPAL)).toBeUndefined()
  })

  it('refuses an invisible session and an absent one alike', () => {
    const { view } = viewOver(CHILD(), new Set(['child']))
    expect(view.spawnedByOf(asSessionId('child'), PRINCIPAL)).toBeUndefined()
    expect(view.spawnedByOf(asSessionId('ghost'), PRINCIPAL)).toBeUndefined()
  })
})
