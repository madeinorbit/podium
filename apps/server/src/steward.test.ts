import { describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@podium/protocol'
import { SessionStore } from './store'
import { IssueService, type IssueDeps } from './issues'
import { StewardService, TRIGGER_RULES, type StewardDeps } from './steward'

function harness(opts: { enabled?: boolean; sessions?: SessionMeta[]; seedCursor?: boolean } = {}) {
  const store = new SessionStore(':memory:')
  // Most tests want the events they emit consumed — pin the cursor to the log
  // start, as if the steward had been enabled since boot. First-enable seeding
  // tests pass seedCursor: false to exercise the absent-row path.
  if (opts.seedCursor !== false) store.setStewardState('cursor', '0')
  const sessions = opts.sessions ?? []
  const settings = {
    steward: { enabled: opts.enabled ?? true },
    gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
    sessionDefaults: { agent: 'claude-code' },
  } as never
  const issueDeps: IssueDeps = {
    store,
    listSessions: () => sessions,
    getSettings: () => settings,
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    broadcast: vi.fn(),
    now: () => '2026-07-02T00:00:00.000Z',
  }
  const issues = new IssueService(issueDeps)
  const sendTextWhenReady = vi.fn()
  const deps: StewardDeps = {
    store,
    issues,
    listSessions: () => sessions,
    sendTextWhenReady,
    getSettings: () => settings,
    now: () => '2026-07-02T00:00:00.000Z',
  }
  return { store, issues, sendTextWhenReady, deps, steward: new StewardService(deps) }
}

const fakeSession = (s: Partial<SessionMeta>): SessionMeta =>
  ({ sessionId: 's?', agentKind: 'claude-code', cwd: '/', status: 'live', ...s }) as never

const stewardComments = (issues: IssueService, id: string) =>
  issues.get(id)!.comments.filter((c) => c.author === 'steward')

describe('TRIGGER_RULES', () => {
  it('maps closed/ready to a per-repo unblock key and needs_human to a per-issue key', () => {
    const e = { id: 1, ts: 't', kind: '', subject: 'iss_x', repoPath: '/r', payload: {} }
    expect(TRIGGER_RULES['issue.closed']!({ ...e, kind: 'issue.closed' })).toBe('unblock:/r')
    expect(TRIGGER_RULES['issue.ready']!({ ...e, kind: 'issue.ready' })).toBe('unblock:/r')
    expect(TRIGGER_RULES['issue.needs_human']!({ ...e, kind: 'issue.needs_human' })).toBe(
      'needshuman:iss_x',
    )
    expect(TRIGGER_RULES['issue.created']).toBeUndefined()
  })

  it('issue.closed with a parentId fans out to unblock AND parentnudge keys', () => {
    const e = { id: 1, ts: 't', kind: 'issue.closed', subject: 'iss_c', repoPath: '/r' }
    expect(TRIGGER_RULES['issue.closed']!({ ...e, payload: { seq: 3, parentId: 'iss_p' } })).toEqual(
      ['unblock:/r', 'parentnudge:iss_p'],
    )
    // No parentId → single unblock key only (no parentnudge batch is formed).
    expect(TRIGGER_RULES['issue.closed']!({ ...e, payload: { seq: 3 } })).toBe('unblock:/r')
  })
})

describe('StewardService cursor', () => {
  it('consumes events exactly once and persists the cursor across re-instantiation', async () => {
    const { store, deps, steward } = harness()
    store.appendEvent({ ts: 't', kind: 'issue.created', subject: 'iss_a', repoPath: '/r' })
    const id2 = store.appendEvent({ ts: 't', kind: 'issue.created', subject: 'iss_b', repoPath: '/r' })
    await steward.tick()
    expect(store.getStewardState('cursor')).toBe(String(id2))
    // Crash-resume: a fresh instance over the same store starts past the batch.
    const reborn = new StewardService(deps)
    const listSpy = vi.spyOn(store, 'listEventsSince')
    await reborn.tick()
    expect(listSpy).toHaveBeenCalledWith(id2)
  })

  it('does not advance the cursor past a batch until its handlers ran', async () => {
    const { store, issues, steward } = harness()
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id)
    let cursorDuringHandler: string | undefined
    const orig = issues.addComment.bind(issues)
    vi.spyOn(issues, 'addComment').mockImplementation((id, author, body) => {
      cursorDuringHandler = store.getStewardState('cursor')
      return orig(id, author, body)
    })
    await steward.tick()
    expect(cursorDuringHandler).toBe('0') // still pre-batch while handling
    expect(Number(store.getStewardState('cursor'))).toBeGreaterThan(0)
  })

  it('first enable seeds the cursor to the log head — dark-run history never replays', async () => {
    const { store, issues, steward, sendTextWhenReady } = harness({ seedCursor: false })
    // Events accumulated while the steward ran dark (no cursor row yet).
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id)
    const max = store.maxEventId()
    expect(max).toBeGreaterThan(0)
    await steward.tick()
    expect(store.getStewardState('cursor')).toBe(String(max))
    expect(stewardComments(issues, b.id)).toEqual([])
    expect(sendTextWhenReady).not.toHaveBeenCalled()
  })

  it('a corrupt cursor re-seeds to the log head instead of wedging', async () => {
    const { store, issues, steward } = harness()
    store.setStewardState('cursor', 'garbage')
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(steward.tick()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[podium:steward] corrupt cursor'))
    expect(store.getStewardState('cursor')).toBe(String(store.maxEventId()))
    warn.mockRestore()
    // Recovered: the next event past the re-seed is consumed normally.
    issues.setNeedsHuman(a.id, 'q')
    await steward.tick()
    expect(store.listEventsSince(0, { kinds: ['steward.observed'] }).length).toBe(1)
  })
})

describe('StewardService unblock handler', () => {
  it('posting the unblock comment carries the closed issue completion note', async () => {
    const { issues, steward } = harness()
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.addDep(b.id, a.id, 'blocks')
    issues.addComment(a.id, 'agent', '[completion-note] shipped X')
    issues.close(a.id)
    await steward.tick()
    const posted = stewardComments(issues, b.id)
    expect(posted.length).toBe(1)
    expect(posted[0]!.body).toContain(`Unblocked by #${a.seq}:`)
    expect(posted[0]!.body).toContain('shipped X')
  })

  it('replayed events do not duplicate the comment or nudge (reset-cursor idempotence)', async () => {
    const sessions = [fakeSession({ sessionId: 's1', cwd: '/r/.worktrees/issue-2-b' })]
    const { store, issues, steward, sendTextWhenReady } = harness({ sessions })
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id)
    await steward.tick()
    expect(stewardComments(issues, b.id).length).toBe(1)
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    // Crash-replay: rewind the cursor so the SAME events are read again.
    store.setStewardState('cursor', '0')
    await steward.tick()
    expect(stewardComments(issues, b.id).length).toBe(1)
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
  })

  it('dedup is colon-anchored: a prior #<seq><digit> comment does not swallow #<seq>', async () => {
    const { issues, steward } = harness()
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false }) // seq 1
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    // A steward comment for a DIFFERENT closer whose seq starts with a's seq
    // ('#15' contains '#1') — must not match a's marker 'Unblocked by #1:'.
    issues.addComment(b.id, 'steward', 'Unblocked by #15: earlier thing')
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id)
    await steward.tick()
    const posted = stewardComments(issues, b.id).filter((c) =>
      c.body.startsWith(`Unblocked by #${a.seq}:`),
    )
    expect(posted.length).toBe(1)
  })

  it('falls back to the closed issue title when it has no completion note', async () => {
    const { issues, steward } = harness()
    const a = issues.create({ repoPath: '/r', title: 'Fix the flux capacitor', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id)
    await steward.tick()
    expect(stewardComments(issues, b.id)[0]!.body).toBe(
      `Unblocked by #${a.seq}: Fix the flux capacitor`,
    )
  })

  it('nudges only live/starting agent sessions — never shells, never parked sessions', async () => {
    const sessions = [
      // queueText would resurrect this via its resume ref — must be skipped.
      fakeSession({ sessionId: 'parked', cwd: '/r/.worktrees/issue-2-b', status: 'exited' }),
      fakeSession({ sessionId: 'hib', cwd: '/r/.worktrees/issue-2-b', status: 'hibernated' }),
      // a shell would have the nudge typed into bash — must be skipped.
      fakeSession({ sessionId: 'sh', cwd: '/r/.worktrees/issue-2-b', agentKind: 'shell' }),
      fakeSession({ sessionId: 'live1', cwd: '/r/.worktrees/issue-2-b' }),
      fakeSession({ sessionId: 'elsewhere', cwd: '/other' }),
    ]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    issues.addDep(b.id, a.id, 'blocks')
    issues.addComment(a.id, 'agent', '[completion-note] shipped $(dangerous) X')
    issues.close(a.id)
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    const [target, text] = sendTextWhenReady.mock.calls[0] as [string, string]
    expect(target).toBe('live1')
    // Defense in depth: single line, no backticks, no agent-authored note text.
    expect(text).toBe(
      `Blocker #${a.seq} closed — you are unblocked. See the steward comment on your issue, or run: podium issue prime`,
    )
    expect(text).not.toContain('`')
    expect(text).not.toContain('shipped')
    expect(text).not.toContain('\n')
  })

  it('no live session → no nudge, but the comment still lands', async () => {
    const { issues, steward, sendTextWhenReady } = harness()
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id)
    await steward.tick()
    expect(sendTextWhenReady).not.toHaveBeenCalled()
    expect(stewardComments(issues, b.id).length).toBe(1)
  })
})

describe('StewardService parent-nudge handler', () => {
  it('child close → parent comment with note excerpt + one nudge with correct counts', async () => {
    const sessions = [fakeSession({ sessionId: 'plive', cwd: '/r/.worktrees/issue-1-epic' })]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false }) // seq 1
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({ repoPath: '/r', title: 'Child 1', parentId: parent.id, startNow: false })
    issues.create({ repoPath: '/r', title: 'Child 2', parentId: parent.id, startNow: false })
    issues.create({ repoPath: '/r', title: 'Child 3', parentId: parent.id, startNow: false })
    issues.addComment(c1.id, 'agent', '[completion-note] shipped the widget\nsecond line ignored')
    issues.close(c1.id)
    await steward.tick()
    const posted = stewardComments(issues, parent.id)
    expect(posted.length).toBe(1)
    expect(posted[0]!.body).toBe(`Child #${c1.seq} closed: shipped the widget`)
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    const [target, text] = sendTextWhenReady.mock.calls[0] as [string, string]
    expect(target).toBe('plive')
    expect(text).toBe(
      `Child issue #${c1.seq} closed — 2 of 3 children remain. See the steward comment, or run: podium issue prime`,
    )
    // Comment-only excerpt: the agent-authored note never reaches the nudge.
    expect(text).not.toContain('widget')
    expect(text).not.toContain('\n')
  })

  it('two children closing in one batch → two comments, ONE nudge with latest counts', async () => {
    const sessions = [fakeSession({ sessionId: 'plive', cwd: '/r/.worktrees/issue-1-epic' })]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({ repoPath: '/r', title: 'Child 1', parentId: parent.id, startNow: false })
    const c2 = issues.create({ repoPath: '/r', title: 'Child 2', parentId: parent.id, startNow: false })
    issues.create({ repoPath: '/r', title: 'Child 3', parentId: parent.id, startNow: false })
    issues.close(c1.id)
    issues.close(c2.id)
    await steward.tick()
    const posted = stewardComments(issues, parent.id)
    expect(posted.map((c) => c.body)).toEqual([
      `Child #${c1.seq} closed: Child 1`,
      `Child #${c2.seq} closed: Child 2`,
    ])
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    expect((sendTextWhenReady.mock.calls[0] as [string, string])[1]).toBe(
      `Child issue #${c2.seq} closed — 1 of 3 children remain. See the steward comment, or run: podium issue prime`,
    )
  })

  it('cursor-rewind replay posts no duplicate comment and no second nudge', async () => {
    const sessions = [fakeSession({ sessionId: 'plive', cwd: '/r/.worktrees/issue-1-epic' })]
    const { store, issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({ repoPath: '/r', title: 'Child 1', parentId: parent.id, startNow: false })
    issues.close(c1.id)
    await steward.tick()
    expect(stewardComments(issues, parent.id).length).toBe(1)
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    store.setStewardState('cursor', '0')
    await steward.tick()
    expect(stewardComments(issues, parent.id).length).toBe(1)
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
  })

  it('closing an issue without a parentId produces no parent-nudge activity', async () => {
    const { issues, steward, sendTextWhenReady } = harness()
    const solo = issues.create({ repoPath: '/r', title: 'Solo', startNow: false })
    issues.close(solo.id)
    await steward.tick()
    // No parent exists; nothing to comment on, nothing to nudge.
    expect(sendTextWhenReady).not.toHaveBeenCalled()
    expect(issues.list('/r').flatMap((w) => w.comments)).toEqual([])
  })

  it('shell and exited sessions in the parent worktree get nothing', async () => {
    const sessions = [
      fakeSession({ sessionId: 'parked', cwd: '/r/.worktrees/issue-1-epic', status: 'exited' }),
      fakeSession({ sessionId: 'sh', cwd: '/r/.worktrees/issue-1-epic', agentKind: 'shell' }),
    ]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({ repoPath: '/r', title: 'Child 1', parentId: parent.id, startNow: false })
    issues.close(c1.id)
    await steward.tick()
    expect(sendTextWhenReady).not.toHaveBeenCalled()
    expect(stewardComments(issues, parent.id).length).toBe(1) // comment still lands
  })

  it('note excerpt is first-line-only and capped at 200 chars', async () => {
    const { issues, steward } = harness()
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    const c1 = issues.create({ repoPath: '/r', title: 'Child 1', parentId: parent.id, startNow: false })
    issues.addComment(c1.id, 'agent', `[completion-note] ${'x'.repeat(500)}\nmore lines`)
    issues.close(c1.id)
    await steward.tick()
    const body = stewardComments(issues, parent.id)[0]!.body
    expect(body).toBe(`Child #${c1.seq} closed: ${'x'.repeat(200)}`)
    expect(body).not.toContain('\n')
  })
})

describe('StewardService needs-human handler', () => {
  it('P1: leaves only a steward.observed breadcrumb', async () => {
    const { store, issues, steward } = harness()
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    issues.setNeedsHuman(a.id, 'which key?')
    await steward.tick()
    const crumbs = store.listEventsSince(0, { kinds: ['steward.observed'] })
    expect(crumbs.length).toBe(1)
    expect(crumbs[0]).toMatchObject({ subject: a.id, payload: { kind: 'issue.needs_human' } })
    // The breadcrumb itself is unmatched — the next tick consumes it silently.
    await steward.tick()
    expect(store.listEventsSince(0, { kinds: ['steward.observed'] }).length).toBe(1)
  })
})

describe('StewardService gating and resilience', () => {
  it('disabled → tick consumes nothing, not even the cursor seed', async () => {
    const { store, issues, steward, sendTextWhenReady } = harness({
      enabled: false,
      seedCursor: false,
    })
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id)
    await steward.tick()
    expect(store.getStewardState('cursor')).toBeUndefined()
    expect(sendTextWhenReady).not.toHaveBeenCalled()
    expect(stewardComments(issues, b.id)).toEqual([])
  })

  it('a throwing handler is dropped, not wedged: tick resolves and the cursor advances', async () => {
    const { store, issues, steward } = harness()
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id)
    vi.spyOn(issues, 'addComment').mockImplementation(() => {
      throw new Error('boom')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(steward.tick()).resolves.toBeUndefined()
    expect(Number(store.getStewardState('cursor'))).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[podium:steward]'),
      expect.any(Error),
    )
    warn.mockRestore()
  })
})
