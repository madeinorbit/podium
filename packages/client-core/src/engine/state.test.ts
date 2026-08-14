/**
 * Workspace membership: WHICH tabs a workspace may keep.
 *
 * The rule decides what the origin strip drops when a session is rehomed, so a
 * subtle change here silently loses someone's tabs (see the note on
 * `knownTabIdsForWorkspace`, and POD-679 for the mission half of it). Two
 * obligations are pinned below:
 *
 *  1. EQUIVALENCE — the resolved-per-key predicate answers exactly what the
 *     original per-session one did, over a matrix of keys and session shapes.
 *     `legacyBelongs` is the pre-index implementation copied verbatim, so this
 *     is a differential test rather than a restatement of the new code.
 *  2. BUDGET — resolving a workspace is O(issues + sessions), not O(issues x
 *     sessions). A Chrome profile of a live client with 1,027 issues and 827
 *     sessions measured ~651 ms of blocked main thread per inbound feed frame
 *     here, 82% of all busy CPU across four functions, because the index every
 *     answer needed was rebuilt inside the loop that consumed it.
 */

import type { IssueWire, SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { FileTab, WorkspaceKey } from '../viewmodels'
import { missionIssueIds } from '../viewmodels'
import type { EngineState } from './state'
import { knownTabIdsForWorkspace, sessionBelongsToWorkspace } from './state'

/** Exactly the slices the membership rule reads. */
type MembershipState = Pick<EngineState, 'issues' | 'sessions' | 'pendingSpawnIds' | 'fileTabs'>

function issue(id: string, over: Record<string, unknown> = {}): IssueWire {
  return {
    id,
    repoPath: '/r/acme',
    seq: 1,
    title: id,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    blockedByNotes: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: false,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    origin: 'human',
    audience: 'human',
    draft: false,
    ...over,
  } as unknown as IssueWire
}

function sess(id: string, over: Record<string, unknown> = {}): SessionMeta {
  return {
    sessionId: id,
    title: id,
    cwd: '/r/acme',
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T01:00:00.000Z',
    ...over,
  } as unknown as SessionMeta
}

function membership(
  issues: IssueWire[],
  sessions: SessionMeta[],
  over: Partial<MembershipState> = {},
): MembershipState {
  return {
    issues,
    sessions,
    pendingSpawnIds: new Set<string>(),
    fileTabs: [],
    ...over,
  }
}

/**
 * `sessionBelongsToWorkspace` EXACTLY as it stood before the index — the linear
 * `find` per session, the mission set rebuilt per session, and all.
 */
function legacyBelongs(
  st: Pick<EngineState, 'issues' | 'sessions'>,
  key: WorkspaceKey,
  session: SessionMeta,
): boolean {
  if (key === 'none') return true
  if (key.startsWith('wt:')) {
    const path = key.slice(3)
    return session.cwd === path || session.cwd.startsWith(`${path}/`)
  }
  if (key.startsWith('issue:')) {
    const issueId = key.slice(6)
    if (session.issueId !== undefined) return session.issueId === issueId
    const found = st.issues.find((candidate) => candidate.id === issueId)
    const wt = found?.worktreePath
    return Boolean(wt && (session.cwd === wt || session.cwd.startsWith(`${wt}/`)))
  }
  if (key.startsWith('mission:')) {
    const rootId = key.slice(8)
    const ids = missionIssueIds(st.issues, rootId, st.sessions)
    if (session.issueId !== undefined) return ids.has(session.issueId)
    for (const candidate of st.issues) {
      if (!ids.has(candidate.id) || !candidate.worktreePath) continue
      if (
        session.cwd === candidate.worktreePath ||
        session.cwd.startsWith(`${candidate.worktreePath}/`)
      ) {
        return true
      }
    }
    return false
  }
  return true
}

describe('workspace membership', () => {
  // A world with every shape the rule distinguishes: a mission with a formal
  // child and an agent-started one, a departed spin-off that is NOT a member, an
  // unrelated issue, worktrees that nest, and one issue with no worktree at all
  // so the `issue:` key's null path is exercised too.
  const issues = [
    issue('root', { worktreePath: '/wt/root' }),
    issue('child', { parentId: 'root', worktreePath: '/wt/child' }),
    issue('started', { startedBySession: 's-child', worktreePath: '/wt/started' }),
    issue('spin', {
      startedBySession: 's-child',
      stage: 'in_progress',
      deps: [{ id: 'child', type: 'discovered-from' }],
      worktreePath: '/wt/spin',
    }),
    issue('other', { worktreePath: '/wt/other' }),
    issue('paperless'),
  ]
  const sessions = [
    sess('s-root', { issueId: 'root', cwd: '/wt/root' }),
    sess('s-child', { issueId: 'child', cwd: '/wt/child' }),
    sess('s-spin', { issueId: 'spin', cwd: '/wt/spin' }),
    // No issueId: these fall through to the worktree paths, and are the ones the
    // old code paid a full slice scan for, each.
    sess('s-loose-root', { cwd: '/wt/root/packages/app' }),
    sess('s-loose-started', { cwd: '/wt/started' }),
    sess('s-loose-other', { cwd: '/wt/other' }),
    sess('s-loose-none', { cwd: '/somewhere/else' }),
    // A near-miss on the prefix test: `/wt/rooted` must not match `/wt/root`.
    sess('s-loose-nearmiss', { cwd: '/wt/rooted' }),
  ]
  const st = membership(issues, sessions)

  const keys: WorkspaceKey[] = [
    'none',
    'wt:/wt/root',
    'wt:/wt/other',
    'issue:root',
    'issue:child',
    'issue:paperless',
    'issue:missing',
    'mission:root',
    'mission:other',
    'mission:missing',
    'something-else',
  ]

  it('answers exactly what the pre-index rule answered, key by key', () => {
    for (const key of keys) {
      for (const session of sessions) {
        const where = `${key} / ${session.sessionId}`
        expect(`${where} ${sessionBelongsToWorkspace(st, key, session)}`).toBe(
          `${where} ${legacyBelongs(st, key, session)}`,
        )
      }
    }
  })

  it('collects the same tab ids as testing each session one at a time', () => {
    for (const key of keys) {
      const oneAtATime = sessions
        .filter((session) => legacyBelongs(st, key, session))
        .map((session) => session.sessionId)
        .sort()
      expect([...knownTabIdsForWorkspace(st, key)].sort()).toEqual(oneAtATime)
    }
  })

  it('keeps pending spawns and file tabs regardless of the key', () => {
    const fileTab = {
      id: 'file-1',
      scope: { kind: 'worktree', worktreePath: '/wt/root' },
      path: '/wt/root/README.md',
      worktreePath: '/wt/root',
    } as unknown as FileTab
    const withTabs = membership(issues, sessions, {
      pendingSpawnIds: new Set(['spawn-1']),
      fileTabs: [fileTab],
    })
    for (const key of keys) {
      const ids = knownTabIdsForWorkspace(withTabs, key)
      expect(ids.has('spawn-1')).toBe(true)
      expect(ids.has('file-1')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The budget. `pruneWorkspaces` runs this for every workspace on every
// `sessions` publish — i.e. on every inbound feed frame — so the cost per
// workspace has to be linear in the slice, never in the product.
// ---------------------------------------------------------------------------

/** Counts ELEMENT reads of the issue slice. The old code's per-session `find`
 *  and per-session index rebuild are both visible here and nowhere else: they
 *  are pure array traversal. */
function countingIssues(rows: IssueWire[]): { issues: IssueWire[]; reads: () => number } {
  let reads = 0
  const proxy = new Proxy(rows, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && `${Number(prop)}` === prop) reads += 1
      return Reflect.get(target, prop, receiver)
    },
  })
  return { issues: proxy, reads: () => reads }
}

describe('workspace membership budget', () => {
  const ISSUES = 500
  const SESSIONS = 400

  function world(): { rows: IssueWire[]; sessions: SessionMeta[] } {
    const rows = [issue('root', { worktreePath: '/wt/root' })]
    for (let i = 0; i < ISSUES - 1; i += 1) {
      rows.push(issue(`iss-${i}`, { parentId: 'root', worktreePath: `/wt/iss-${i}` }))
    }
    // None of them name an issue: that is the branch that falls through to the
    // slice, and it is what made the cost quadratic.
    const sessions = Array.from({ length: SESSIONS }, (_, i) =>
      sess(`s-${i}`, { cwd: `/wt/iss-${i}` }),
    )
    return { rows, sessions }
  }

  it('resolves an issue: key in one pass over the slice, not one per session', () => {
    const { rows, sessions } = world()
    const counted = countingIssues(rows)
    knownTabIdsForWorkspace(membership(counted.issues, sessions), `issue:iss-${ISSUES - 2}`)
    // One index build. The old `find` scanned to the second-to-last row for
    // every one of the 400 sessions — ~200,000 reads.
    expect(counted.reads()).toBeLessThanOrEqual(2 * ISSUES)
  })

  it('resolves a mission: key in a bounded number of passes over the slice', () => {
    const { rows, sessions } = world()
    const counted = countingIssues(rows)
    const ids = knownTabIdsForWorkspace(membership(counted.issues, sessions), 'mission:root')
    // Sanity: the answer is the whole world, so nothing was skipped to be fast.
    expect(ids.size).toBe(SESSIONS)
    // The mission index and the mission's worktree list are one pass each. The
    // old code rebuilt both inside the per-session loop — ~400,000 reads.
    expect(counted.reads()).toBeLessThanOrEqual(4 * ISSUES)
  })

  it('shares one index across every workspace resolved against the same slice', () => {
    const { rows, sessions } = world()
    const counted = countingIssues(rows)
    const st = membership(counted.issues, sessions)
    knownTabIdsForWorkspace(st, 'issue:iss-0')
    const afterFirst = counted.reads()
    // `workspacesPatch` reduces EVERY workspace on every publish; the second and
    // subsequent `issue:` keys must not each re-index the slice.
    for (let i = 1; i < 20; i += 1) knownTabIdsForWorkspace(st, `issue:iss-${i}`)
    expect(counted.reads()).toBe(afterFirst)
  })
})
