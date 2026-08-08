import type { SessionMeta } from '@podium/model'
import { asSessionId, type SessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import type { Ledger } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

// POD-98: the git-state service wiring end-to-end at the service layer —
// turn-end trigger → coalesced probe (via repoOp) → targeted gitState update,
// with attribution unioned from recorded session activity.
function harness(sessions: SessionMeta[], repoOpScript: Record<string, string>) {
  const store = new SessionStore(':memory:')
  const broadcast = vi.fn()
  const repoOp = vi.fn(async (op: string, _cwd: string, args?: Record<string, string>) => {
    const key =
      op === 'revListCount'
        ? `${op}:${args?.from}..${args?.to}`
        : op === 'revParseVerify'
          ? `${op}:${args?.ref}`
          : op
    const output = repoOpScript[key]
    return output !== undefined ? { ok: true, output } : { ok: false, output: '' }
  })
  const plumbing = issueTestPlumbing((msg) => broadcast(msg))
  const deps: IssueDeps = {
    store,
    listSessions: () => sessions,
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
    repoOp: repoOp as IssueDeps['repoOp'],
    ...plumbing,
    setSessionArchived: vi.fn(),
    now: () => '2026-07-20T00:00:00.000Z',
  }
  // The plumbing wires a REAL Ledger; widen from the narrow IssueLedger face so
  // tests can read the log back (cursor/changesSince).
  return { svc: new IssueService(deps), repoOp, broadcast, ledger: plumbing.ledger as Ledger }
}

const member = (sessionId: SessionId, issueId: string): SessionMeta =>
  ({
    sessionId,
    agentKind: 'claude-code',
    title: 't',
    cwd: '/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: 't',
    lastActiveAt: 't',
    origin: { kind: 'spawn' },
    archived: false,
    issueId,
  }) as unknown as SessionMeta

describe('POD-98 git-state service wiring', () => {
  it('keeps stateful workflow methods bound when passed across a port', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main',
      logHead: 'sha-bound\t2026-07-20T11:30:00Z',
    })
    const id = svc.create({ repoPath: '/repo', title: 'bound receiver', startNow: false }).id
    sessions.push(member(asSessionId('sess-bound'), id))

    const { recordSessionGitActivity, refreshGitState, onSessionRemovedOrArchived } =
      svc.gitWorkflow
    recordSessionGitActivity(asSessionId('sess-bound'), { commits: ['sha-bound'] })
    await refreshGitState(id, '/repo')
    expect(svc.get(id)?.gitState?.commits).toEqual(['sha-bound'])

    onSessionRemovedOrArchived(asSessionId('sess-bound'))
    await refreshGitState(id, '/repo')
    expect(svc.get(id)?.gitState?.commits).toBeUndefined()
  })

  it('turn end probes a shared checkout and lands attributed gitState on the wire', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main\n M apps/a.ts\n M apps/b.ts',
      logHead: 'abc\t2026-07-20T11:00:00Z',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member(asSessionId('sess-1'), id))

    // Daemon-captured attribution: one touched file. Registration also fires
    // the repopulation probe in the background, so poll until one settles.
    svc.recordSessionGitActivity(asSessionId('sess-1'), { touched: ['/repo/apps/a.ts'] })
    await svc.refreshGitState(id, '/repo')
    for (let i = 0; i < 50; i++) {
      const gs = svc.allWire().find((w) => w.id === id)?.gitState
      if (gs && gs.updatedAt !== '' && gs.computing !== true) break
      await new Promise((r) => setTimeout(r, 10))
    }

    const wire = svc.allWire().find((w) => w.id === id)
    expect(wire?.gitState).toMatchObject({
      shared: true,
      branch: 'main',
      dirtyFiles: 2,
      dirtyOwn: 1,
      commits: [],
      updatedAt: '2026-07-20T00:00:00.000Z',
    })
    expect(wire?.gitState?.fallback).toBeUndefined()
    expect(wire?.gitState?.computing).toBeUndefined()
  })

  it('recording a commit triggers a probe via the turn-end path', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main',
      logHead: 'sha9\t2026-07-20T11:30:00Z',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member(asSessionId('sess-1'), id))

    svc.recordSessionGitActivity(asSessionId('sess-1'), { commits: ['sha9'] })
    // The commit-triggered probe is fire-and-forget — poll until it settles
    // (vi.waitFor is unavailable under the bun runner).
    let commits: string[] | undefined
    for (let i = 0; i < 50 && commits === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10))
      commits = svc.allWire().find((w) => w.id === id)?.gitState?.commits
    }
    expect(commits).toEqual(['sha9'])
  })

  it('without any attribution the shared probe discloses fallback', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main\n M x.ts',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member(asSessionId('sess-1'), id))

    await svc.refreshGitState(id, '/repo')
    const wire = svc.allWire().find((w) => w.id === id)
    expect(wire?.gitState?.fallback).toBe(true)
    expect(wire?.gitState?.dirtyOwn).toBeUndefined()
  })

  it('first registration after a restart repopulates the stamp without a turn end', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main',
      logHead: 'abc\t2026-07-20T11:00:00Z',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member(asSessionId('sess-1'), id))

    // The daemon's empty baseline registration (SessionStart) is enough.
    svc.recordSessionGitActivity(asSessionId('sess-1'), {})
    let state: unknown
    for (let i = 0; i < 50 && state === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10))
      const gs = svc.allWire().find((w) => w.id === id)?.gitState
      state = gs && gs.updatedAt !== '' && gs.computing !== true ? gs : undefined
    }
    expect(state).toMatchObject({ shared: true, branch: 'main' })
  })

  it('coalesces rapid turn ends and publishes one targeted final update', async () => {
    const sessions: SessionMeta[] = []
    const { svc, repoOp, broadcast } = harness(sessions, {
      statusProbe: '## main',
      logHead: 'abc\t2026-07-20T11:00:00Z',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member(asSessionId('sess-1'), id))
    repoOp.mockClear()
    broadcast.mockClear()

    svc.onSessionTurnEnd(asSessionId('sess-1'))
    svc.onSessionTurnEnd(asSessionId('sess-1'))
    svc.onSessionTurnEnd(asSessionId('sess-1'))
    expect(repoOp).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()

    await svc.refreshGitState(id, '/repo')
    expect(repoOp).toHaveBeenCalledTimes(4)
    // ONE published row for the probed issue — `['issueUpdated']` before
    // POD-1203, the same "exactly one targeted publish" claim read off the
    // change log the client is served from.
    expect(broadcast.mock.calls.map(([row]) => [row.id, row.op])).toEqual([[id, 'upsert']])
  })

  it('a targeted git-state publish never journals removes for other issues [POD-210]', async () => {
    const sessions: SessionMeta[] = []
    const { svc, ledger } = harness(sessions, {
      statusProbe: '## main',
      logHead: 'abc\t2026-07-20T11:00:00Z',
    })
    const probed = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    svc.create({ repoPath: '/repo', title: 'two', startNow: false })
    svc.create({ repoPath: '/repo', title: 'three', startNow: false })
    sessions.push(member(asSessionId('sess-1'), probed))

    const cursor = ledger.cursor()
    await svc.refreshGitState(probed, '/repo')

    // broadcastIssue must CAPTURE the one row, not reconcile it as full truth:
    // a full-truth reconcile of a single row journals a remove for every other
    // issue (the boot-adjacent ledger flapping — thousands of remove+upsert
    // pairs per probe wave).
    const appended = ledger.changesSince(cursor) ?? []
    expect(appended.filter((c) => c.op === 'remove')).toEqual([])
    expect(appended.map((c) => [c.id, c.op])).toEqual([[probed, 'upsert']])
  })

  it('runs one trailing probe for attribution recorded during an active refresh', async () => {
    const sessions: SessionMeta[] = []
    const { svc, repoOp, broadcast } = harness(sessions, {})
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member(asSessionId('sess-1'), id))
    let releaseStatus!: () => void
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    let statusCalls = 0
    repoOp.mockImplementation(async (op: string) => {
      if (op === 'statusProbe') {
        statusCalls += 1
        if (statusCalls === 1) await statusGate
        return { ok: true, output: '## main' }
      }
      return { ok: false, output: '' }
    })
    broadcast.mockClear()

    const initial = svc.refreshGitState(id, '/repo')
    for (let i = 0; i < 50 && statusCalls === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(statusCalls).toBe(1)
    svc.recordSessionGitActivity(asSessionId('sess-1'), { commits: ['late-sha'] })
    releaseStatus()
    await initial

    expect(statusCalls).toBe(2)
    expect(repoOp).toHaveBeenCalledTimes(8)
    expect(svc.get(id)?.gitState?.commits).toEqual(['late-sha'])
    // One published row, carrying the TRAILING probe's result — read off the
    // change log since POD-1203 deleted the `issueUpdated` snapshot.
    expect(broadcast.mock.calls.map(([row]) => [row.id, row.op])).toEqual([[id, 'upsert']])
  })

  it('drops archived or removed sessions from file and commit attribution', async () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions, {
      statusProbe: '## main\n M apps/a.ts\n M apps/b.ts',
    })
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member(asSessionId('sess-1'), id), member(asSessionId('sess-2'), id))
    svc.recordSessionGitActivity(asSessionId('sess-1'), {
      commits: ['sha-1'],
      touched: ['/repo/apps/a.ts'],
    })
    svc.recordSessionGitActivity(asSessionId('sess-2'), {
      commits: ['sha-2'],
      touched: ['/repo/apps/b.ts'],
    })
    await svc.refreshGitState(id, '/repo')
    expect(svc.get(id)?.gitState).toMatchObject({
      commits: ['sha-1', 'sha-2'],
      dirtyOwn: 2,
    })

    svc.onSessionRemovedOrArchived(asSessionId('sess-1'))
    await svc.refreshGitState(id, '/repo')
    expect(svc.get(id)?.gitState).toMatchObject({ commits: ['sha-2'], dirtyOwn: 1 })

    svc.onSessionRemovedOrArchived(asSessionId('sess-2'))
    await svc.refreshGitState(id, '/repo')
    expect(svc.get(id)?.gitState).toMatchObject({ fallback: true })
    expect(svc.get(id)?.gitState?.commits).toBeUndefined()
    expect(svc.get(id)?.gitState?.dirtyOwn).toBeUndefined()
  })

  it('sessions without an issue are a no-op on turn end', () => {
    const sessions: SessionMeta[] = [
      { ...member(asSessionId('sess-x'), 'nope'), issueId: undefined } as unknown as SessionMeta,
    ]
    const { svc, repoOp } = harness(sessions, {})
    svc.onSessionTurnEnd(asSessionId('sess-x'))
    expect(repoOp).not.toHaveBeenCalled()
  })
})

// POD-384: the merge that settles an issue happens in ANOTHER checkout, so no
// session edge of that issue's own ever re-probes it. The watch closes that hole
// by tracking the one ref such a merge must move — the parent branch.
describe('POD-384 parent-branch movement watch', () => {
  /** Row-level private worktree, no git: the merge axis is only live for an
   *  issue that owns a checkout and a branch. */
  function giveWorktree(svc: IssueService, id: string, parentBranch = 'main'): void {
    const rows = (
      svc as unknown as {
        rows: Map<
          string,
          { seq: number; worktreePath: string | null; branch: string | null; parentBranch: string }
        >
      }
    ).rows
    const row = rows.get(id)
    if (!row) throw new Error(`no row for ${id}`)
    row.worktreePath = `/repo/wt-${row.seq}`
    row.branch = `issue/${row.seq}`
    row.parentBranch = parentBranch
  }

  /** A branch one commit ahead of `main`, whose reflog proves the tip has moved
   *  off its creation point (so containment reads as "landed", not "fresh").
   *  isMergedInto is ABSENT until a test flips it — after POD-576 the ancestry
   *  check always runs, so a present key would mark unlanded work as merged. */
  const unlandedScript = (): Record<string, string> => ({
    'revParseVerify:main': 'tip-1',
    statusProbe: '## issue/1',
    logHead: 'sha-tip\t2026-07-20T11:00:00Z',
    'revListCount:main..HEAD': '1',
    branchReflog: 'sha-tip\nsha-created',
  })

  /** Mark the script as "contained in parent" for the ungated ancestry check. */
  const markLanded = (script: Record<string, string>) => {
    script.isMergedInto = ''
  }

  it('records a parent tip on first sight instead of fanning out at boot', async () => {
    const script = unlandedScript()
    const { svc, repoOp } = harness([], script)
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    giveWorktree(svc, id)

    await svc.sweepParentBranchMovement()

    expect(repoOp.mock.calls.map(([op]) => op)).toEqual(['revParseVerify'])
    expect(svc.get(id)?.gitState).toBeUndefined()
  })

  it('re-probes a branch merged from another checkout when the parent tip moves', async () => {
    const script = unlandedScript()
    const { svc } = harness([], script)
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    giveWorktree(svc, id)
    await svc.sweepParentBranchMovement()

    // The snapshot that strands the row: one unlanded commit, no merged verdict.
    await svc.refreshGitState(id)
    expect(svc.get(id)?.gitState).toMatchObject({ shared: false, ahead: 1 })
    expect(svc.get(id)?.gitState?.merged).toBeUndefined()

    // Somebody fast-forwards main from a different checkout — no commit in this
    // worktree, no turn edge on this issue's sessions, nothing else to notice it.
    script['revParseVerify:main'] = 'tip-2'
    script['revListCount:main..HEAD'] = '0'
    markLanded(script)
    await svc.sweepParentBranchMovement()

    expect(svc.get(id)?.gitState).toMatchObject({ ahead: 0, merged: true })
  })

  it('answers a whole repo group with one rev-parse and refreshes all of it', async () => {
    const script = unlandedScript()
    const { svc, repoOp } = harness([], script)
    const a = svc.create({ repoPath: '/repo', title: 'a', startNow: false }).id
    const b = svc.create({ repoPath: '/repo', title: 'b', startNow: false }).id
    giveWorktree(svc, a)
    giveWorktree(svc, b)
    await svc.sweepParentBranchMovement()
    expect(repoOp.mock.calls.filter(([op]) => op === 'revParseVerify')).toHaveLength(1)

    script['revParseVerify:main'] = 'tip-2'
    script['revListCount:main..HEAD'] = '0'
    markLanded(script)
    await svc.sweepParentBranchMovement()

    expect(svc.get(a)?.gitState).toMatchObject({ merged: true })
    expect(svc.get(b)?.gitState).toMatchObject({ merged: true })
  })

  it('costs one rev-parse and nothing else while the parent tip holds still', async () => {
    const script = unlandedScript()
    const { svc, repoOp } = harness([], script)
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    giveWorktree(svc, id)
    await svc.sweepParentBranchMovement()
    repoOp.mockClear()

    await svc.sweepParentBranchMovement()

    expect(repoOp.mock.calls.map(([op]) => op)).toEqual(['revParseVerify'])
  })

  it('keeps the last known tip when the parent branch is unreadable', async () => {
    const script = unlandedScript()
    const { svc, repoOp } = harness([], script)
    const id = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    giveWorktree(svc, id)
    await svc.sweepParentBranchMovement()

    // Machine offline / ref not there: no observation, so no recorded tip either.
    delete script['revParseVerify:main']
    await svc.sweepParentBranchMovement()

    // Back, and unmoved — a recovery must not read as movement and re-probe.
    script['revParseVerify:main'] = 'tip-1'
    repoOp.mockClear()
    await svc.sweepParentBranchMovement()
    expect(repoOp.mock.calls.map(([op]) => op)).toEqual(['revParseVerify'])
  })

  it('watches neither a shared checkout nor an issue without a branch', async () => {
    const script = unlandedScript()
    const { svc, repoOp } = harness([], script)
    // Shared: no worktree of its own, so no merge axis to keep fresh.
    svc.create({ repoPath: '/repo', title: 'shared', startNow: false })
    const branchless = svc.create({ repoPath: '/repo', title: 'branchless', startNow: false }).id
    giveWorktree(svc, branchless)
    ;(svc as unknown as { rows: Map<string, { branch: string | null }> }).rows.get(
      branchless,
    )!.branch = null

    await svc.sweepParentBranchMovement()

    expect(repoOp).not.toHaveBeenCalled()
  })

  // POD-576: a stacked issue's cut parent freezes when that sibling lands. The
  // hard land moves main, so the sweep must also watch the landing base — not
  // only the dead parent — or the finished issue never re-probes.
  it('re-probes a stacked issue when the landing base moves even if the cut parent is frozen', async () => {
    const script: Record<string, string> = {
      'revParseVerify:issue/520-parent': 'parent-tip-frozen',
      'revParseVerify:main': 'main-tip-1',
      statusProbe: '## issue/527',
      logHead: 'sha-tip\t2026-08-07T12:00:00Z',
      'revListCount:issue/520-parent..HEAD': '9',
      // First isMergedInto key is bare op name in this harness → single response
      // for both parents; simulate "not in parent, in main" via the probe path
      // only after main moves (see below).
      isMergedInto: '',
      branchReflog: 'sha-tip\nsha-created',
    }
    const { svc, repoOp } = harness([], script)
    const id = svc.create({ repoPath: '/repo', title: 'stacked', startNow: false }).id
    giveWorktree(svc, id, 'issue/520-parent')

    // First sight of both watched refs: record, do not probe.
    await svc.sweepParentBranchMovement()
    expect(repoOp.mock.calls.filter(([op]) => op === 'revParseVerify')).toHaveLength(2)
    expect(svc.get(id)?.gitState).toBeUndefined()

    // Seed the stranded snapshot: still ahead of the dead parent.
    // Custom isMergedInto: fail for parent, succeed for main only after we flip
    // the script — here pre-land, neither contains it.
    repoOp.mockImplementation(async (op: string, _cwd: string, args?: Record<string, string>) => {
      if (op === 'revListCount') {
        const key = `${op}:${args?.from}..${args?.to}`
        const output = script[key]
        return output !== undefined ? { ok: true, output } : { ok: false, output: '' }
      }
      if (op === 'revParseVerify') {
        const key = `${op}:${args?.ref}`
        const output = script[key]
        return output !== undefined ? { ok: true, output } : { ok: false, output: '' }
      }
      if (op === 'isMergedInto') {
        // Before/after land: tip is in main only once main advanced past it.
        if (args?.parentBranch === 'main' && script['revParseVerify:main'] === 'main-tip-2') {
          return { ok: true, output: '' }
        }
        return { ok: false, output: '' }
      }
      const output = script[op]
      return output !== undefined ? { ok: true, output } : { ok: false, output: '' }
    })

    await svc.refreshGitState(id)
    expect(svc.get(id)?.gitState).toMatchObject({ shared: false, ahead: 9 })
    expect(svc.get(id)?.gitState?.merged).toBeUndefined()

    // Somebody lands on main from another checkout. Cut parent does not move.
    script['revParseVerify:main'] = 'main-tip-2'
    await svc.sweepParentBranchMovement()

    expect(svc.get(id)?.gitState).toMatchObject({ ahead: 9, merged: true })
  })

  it('retargeting parentBranch re-probes gitState against the new base [POD-576]', async () => {
    const script = unlandedScript()
    script['revListCount:issue/520-parent..HEAD'] = '9'
    // Drop main's rev-list so the first probe only has the cut-parent count.
    delete script['revListCount:main..HEAD']
    const { svc } = harness([], script)
    const id = svc.create({ repoPath: '/repo', title: 'stacked', startNow: false }).id
    giveWorktree(svc, id, 'issue/520-parent')

    await svc.refreshGitState(id)
    expect(svc.get(id)?.gitState).toMatchObject({ ahead: 9 })
    expect(svc.get(id)?.gitState?.merged).toBeUndefined()

    // Retarget to main; next probe measures against main (0 ahead, merged).
    script['revListCount:main..HEAD'] = '0'
    markLanded(script)

    svc.update(id, { parentBranch: 'main' })
    // refreshGitState is fire-and-forget from update — wait for the coalesced probe.
    for (let i = 0; i < 50; i++) {
      const gs = svc.get(id)?.gitState
      if (gs?.ahead === 0 && gs.merged === true) break
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(svc.get(id)?.gitState).toMatchObject({ ahead: 0, merged: true })
  })
})
