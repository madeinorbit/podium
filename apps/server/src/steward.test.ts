import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { type StewardDeps, StewardService, TRIGGER_RULES } from './steward'
import { SessionStore } from './store'

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
  // Incrementing clock: a pinned constant made same-batch comments share
  // created_at, so order assertions fell to the cmt_<uuid> tie-break (flaky).
  let clockMs = Date.parse('2026-07-02T00:00:00.000Z')
  const now = () => new Date(clockMs++).toISOString()
  const issueDeps: IssueDeps = {
    store,
    listSessions: () => sessions,
    getSettings: () => settings,
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(),
    now,
  }
  const issues = new IssueService(issueDeps)
  const sendTextWhenReady = vi.fn()
  const deps: StewardDeps = {
    store,
    issues,
    listSessions: () => sessions,
    sendTextWhenReady,
    getSettings: () => settings,
    now,
  }
  return { store, issues, sendTextWhenReady, deps, steward: new StewardService(deps) }
}

const fakeSession = (s: Partial<SessionMeta>): SessionMeta =>
  ({ sessionId: 's?', agentKind: 'claude-code', cwd: '/', status: 'live', ...s }) as never

// #175: comment bodies left IssueWire — read the thread via IssueService.comments.
const stewardComments = (issues: IssueService, id: string) =>
  issues.comments(id).filter((c) => c.author === 'steward')

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
    expect(
      TRIGGER_RULES['issue.closed']!({ ...e, payload: { seq: 3, parentId: 'iss_p' } }),
    ).toEqual(['unblock:/r', 'parentnudge:closed:iss_p'])
    // No parentId → single unblock key only (no parentnudge batch is formed).
    expect(TRIGGER_RULES['issue.closed']!({ ...e, payload: { seq: 3 } })).toBe('unblock:/r')
  })

  it('issue.stage_changed→review with a parentId keys a review parent-nudge; other stages ignored', () => {
    const e = { id: 1, ts: 't', kind: 'issue.stage_changed', subject: 'iss_c', repoPath: '/r' }
    expect(
      TRIGGER_RULES['issue.stage_changed']!({
        ...e,
        payload: { seq: 3, to: 'review', parentId: 'iss_p' },
      }),
    ).toBe('parentnudge:review:iss_p')
    // to !== review → no key; to === review but no parent → no key.
    expect(
      TRIGGER_RULES['issue.stage_changed']!({
        ...e,
        payload: { seq: 3, to: 'in_progress', parentId: 'iss_p' },
      }),
    ).toBeUndefined()
    expect(
      TRIGGER_RULES['issue.stage_changed']!({ ...e, payload: { seq: 3, to: 'review' } }),
    ).toBeUndefined()
  })

  it('issue.needs_human always breadcrumbs; with a parentId ALSO keys a parent-nudge', () => {
    const e = { id: 1, ts: 't', kind: 'issue.needs_human', subject: 'iss_c', repoPath: '/r' }
    expect(TRIGGER_RULES['issue.needs_human']!({ ...e, payload: { seq: 3 } })).toBe(
      'needshuman:iss_c',
    )
    expect(
      TRIGGER_RULES['issue.needs_human']!({ ...e, payload: { seq: 3, parentId: 'iss_p' } }),
    ).toEqual(['needshuman:iss_c', 'parentnudge:needs_human:iss_p'])
  })
})

describe('StewardService cursor', () => {
  it('consumes events exactly once and persists the cursor across re-instantiation', async () => {
    const { store, deps, steward } = harness()
    store.appendEvent({ ts: 't', kind: 'issue.created', subject: 'iss_a', repoPath: '/r' })
    const id2 = store.appendEvent({
      ts: 't',
      kind: 'issue.created',
      subject: 'iss_b',
      repoPath: '/r',
    })
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

  it('suppresses the nudge to the session that caused the close, still nudges others', async () => {
    const sessions = [
      // The agent that closed the blocker: it already knows — must NOT be nudged.
      fakeSession({ sessionId: 'causer', cwd: '/r/.worktrees/issue-2-b' }),
      fakeSession({ sessionId: 'other', cwd: '/r/.worktrees/issue-2-b' }),
    ]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id, 'done', { actorSessionId: 'causer' })
    await steward.tick()
    // Comment/audit trail is unchanged — the note still lands on the dependent.
    expect(stewardComments(issues, b.id).length).toBe(1)
    // Only the non-actor live session is nudged.
    const targets = sendTextWhenReady.mock.calls.map((c) => (c as [string, string])[0])
    expect(targets).toEqual(['other'])
  })
})

describe('StewardService parent-nudge handler', () => {
  it('child close → parent comment with note excerpt + one nudge with correct counts', async () => {
    const sessions = [fakeSession({ sessionId: 'plive', cwd: '/r/.worktrees/issue-1-epic' })]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false }) // seq 1
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
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
    const c1 = issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    const c2 = issues.create({
      repoPath: '/r',
      title: 'Child 2',
      parentId: parent.id,
      startNow: false,
    })
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
    const c1 = issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
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
    // #175: bodies left the wire — assert via counts + the thread read.
    expect(issues.list('/r').every((w) => (w.commentCount ?? 0) === 0)).toBe(true)
    expect(issues.list('/r').flatMap((w) => issues.comments(w.id))).toEqual([])
  })

  it('suppresses the nudge to the session that caused the child close, comment still lands', async () => {
    const sessions = [
      // The orchestrator session that closed the child itself — no self-nudge.
      fakeSession({ sessionId: 'causer', cwd: '/r/.worktrees/issue-1-epic' }),
      fakeSession({ sessionId: 'other', cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    issues.create({ repoPath: '/r', title: 'Child 2', parentId: parent.id, startNow: false })
    issues.close(c1.id, 'done', { actorSessionId: 'causer' })
    await steward.tick()
    // The parent comment is unchanged.
    expect(stewardComments(issues, parent.id).length).toBe(1)
    // The causer is excluded from the single coalesced nudge; 'other' still gets it.
    const targets = sendTextWhenReady.mock.calls.map((c) => (c as [string, string])[0])
    expect(targets).toEqual(['other'])
  })

  it('shell and exited sessions in the parent worktree get nothing', async () => {
    const sessions = [
      fakeSession({ sessionId: 'parked', cwd: '/r/.worktrees/issue-1-epic', status: 'exited' }),
      fakeSession({ sessionId: 'sh', cwd: '/r/.worktrees/issue-1-epic', agentKind: 'shell' }),
    ]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    issues.close(c1.id)
    await steward.tick()
    expect(sendTextWhenReady).not.toHaveBeenCalled()
    expect(stewardComments(issues, parent.id).length).toBe(1) // comment still lands
  })

  it('note excerpt is first-line-only and capped at 200 chars', async () => {
    const { issues, steward } = harness()
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    const c1 = issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    issues.addComment(c1.id, 'agent', `[completion-note] ${'x'.repeat(500)}\nmore lines`)
    issues.close(c1.id)
    await steward.tick()
    const body = stewardComments(issues, parent.id)[0]!.body
    expect(body).toBe(`Child #${c1.seq} closed: ${'x'.repeat(200)}`)
    expect(body).not.toContain('\n')
  })
})

describe('StewardService child→review parent nudge', () => {
  it('a child moving to review notifies the parent (comment + nudge), other stages ignored', async () => {
    const sessions = [fakeSession({ sessionId: 'plive', cwd: '/r/.worktrees/issue-1-epic' })]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    issues.addComment(c1.id, 'agent', '[completion-note] widget ready for review')
    issues.update(c1.id, { stage: 'in_progress' }) // backlog→in_progress: NOT a review transition
    issues.update(c1.id, { stage: 'review' }) // in_progress→review: fires
    await steward.tick()
    const posted = stewardComments(issues, parent.id)
    expect(posted.length).toBe(1)
    expect(posted[0]!.body).toBe(`Child #${c1.seq} in review: widget ready for review`)
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    const [target, text] = sendTextWhenReady.mock.calls[0] as [string, string]
    expect(target).toBe('plive')
    expect(text).toContain(`Child issue #${c1.seq} moved to review`)
    expect(text).not.toContain('\n')
  })

  it('suppresses the review nudge to the session that caused the transition (#116 carried)', async () => {
    const sessions = [
      fakeSession({ sessionId: 'causer', cwd: '/r/.worktrees/issue-1-epic' }),
      fakeSession({ sessionId: 'other', cwd: '/r/.worktrees/issue-1-epic' }),
    ]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    issues.update(c1.id, { stage: 'review' }, { actorSessionId: 'causer' })
    await steward.tick()
    expect(stewardComments(issues, parent.id).length).toBe(1)
    const targets = sendTextWhenReady.mock.calls.map((c) => (c as [string, string])[0])
    expect(targets).toEqual(['other'])
  })
})

describe('StewardService child→needs_human parent nudge', () => {
  it('a child needing a human notifies the parent AND leaves a breadcrumb', async () => {
    const sessions = [fakeSession({ sessionId: 'plive', cwd: '/r/.worktrees/issue-1-epic' })]
    const { store, issues, steward, sendTextWhenReady } = harness({ sessions })
    const parent = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    issues.setNeedsHuman(c1.id, 'which database?')
    await steward.tick()
    const posted = stewardComments(issues, parent.id)
    expect(posted.length).toBe(1)
    expect(posted[0]!.body).toBe(`Child #${c1.seq} needs a human: which database?`)
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    expect((sendTextWhenReady.mock.calls[0] as [string, string])[1]).toContain('needs a human')
    // Breadcrumb still recorded (unchanged from before).
    expect(store.listEventsSince(0, { kinds: ['steward.observed'] }).length).toBe(1)
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

describe('StewardService stored subscriptions (Phase B)', () => {
  const seedSub = (
    over: Partial<import('./store').Subscription>,
  ): import('./store').Subscription => ({
    id: 'sub_x',
    subscriberKind: 'issue',
    subscriberId: 'iss_p',
    event: 'issue.closed',
    sourceKind: 'issue',
    sourceRef: 'iss_x',
    deliverNudge: true,
    deliverNotify: false,
    origin: 'custom',
    enabled: true,
    createdAt: 't',
    ...over,
  })

  it('an issue-event subscription fires once and dedups on cursor-rewind replay', async () => {
    const sessions = [fakeSession({ sessionId: 'psess', cwd: '/r/.worktrees/p' })]
    const { store, issues, steward, sendTextWhenReady } = harness({ sessions })
    const p = issues.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    issues.update(p.id, { worktreePath: '/r/.worktrees/p' })
    const x = issues.create({ repoPath: '/r', title: 'Target', startNow: false })
    store.addSubscription(seedSub({ id: 'sub_1', subscriberId: p.id, sourceRef: x.id }))
    issues.close(x.id)
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    const [target, text] = sendTextWhenReady.mock.calls[0] as [string, string]
    expect(target).toBe('psess')
    expect(text).not.toContain('`')
    expect(text).not.toContain('\n')
    // Crash-replay: the same close event is re-read but never re-delivered.
    store.setStewardState('cursor', '0')
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
  })

  it('a session.finished subscription nudges the subscriber session', async () => {
    const sessions = [
      fakeSession({ sessionId: 'watcher', cwd: '/w' }),
      fakeSession({ sessionId: 'worker', cwd: '/x' }),
    ]
    const { store, steward, sendTextWhenReady } = harness({ sessions })
    store.addSubscription(
      seedSub({
        id: 'sub_s',
        subscriberKind: 'session',
        subscriberId: 'watcher',
        event: 'session.finished',
        sourceKind: 'session',
        sourceRef: 'worker',
      }),
    )
    // Non-finished phases are ignored; only idle+done derives session.finished.
    store.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'worker',
      payload: { phase: 'active' },
    })
    store.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'worker',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    expect((sendTextWhenReady.mock.calls[0] as [string, string])[0]).toBe('watcher')
  })

  it("resolves a 'my-children' relationship source for a child session.finished", async () => {
    const sessions: SessionMeta[] = []
    const { store, issues, steward, sendTextWhenReady } = harness({ sessions })
    const epic = issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issues.update(epic.id, { worktreePath: '/r/.worktrees/epic' })
    const child = issues.create({
      repoPath: '/r',
      title: 'Child',
      parentId: epic.id,
      startNow: false,
    })
    const outsider = issues.create({ repoPath: '/r', title: 'Outsider', startNow: false })
    // Sessions bound (issueId) to the child vs an unrelated issue; the parent's own
    // session receives the nudge. Pushed after creation so ids are known.
    sessions.push(
      fakeSession({ sessionId: 'psess', cwd: '/r/.worktrees/epic', issueId: epic.id }),
      fakeSession({ sessionId: 'kid', cwd: '/k', issueId: child.id }),
      fakeSession({ sessionId: 'stranger', cwd: '/s', issueId: outsider.id }),
    )
    store.addSubscription(
      seedSub({
        id: 'sub_rel',
        subscriberId: epic.id,
        event: 'session.finished',
        sourceKind: 'relationship',
        sourceRef: 'my-children',
      }),
    )
    // A non-child session finishing does NOT deliver.
    store.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'stranger',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).not.toHaveBeenCalled()
    // The child session finishing DOES — its bound issue's parent is the subscriber.
    store.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'kid',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    expect((sendTextWhenReady.mock.calls[0] as [string, string])[0]).toBe('psess')
  })

  it('a disabled subscription is silent', async () => {
    const sessions = [fakeSession({ sessionId: 'psess', cwd: '/r/.worktrees/p' })]
    const { store, issues, steward, sendTextWhenReady } = harness({ sessions })
    const p = issues.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    issues.update(p.id, { worktreePath: '/r/.worktrees/p' })
    const x = issues.create({ repoPath: '/r', title: 'Target', startNow: false })
    store.addSubscription(
      seedSub({ id: 'sub_off', subscriberId: p.id, sourceRef: x.id, enabled: false }),
    )
    issues.close(x.id)
    await steward.tick()
    expect(sendTextWhenReady).not.toHaveBeenCalled()
  })

  it('suppresses the nudge to the session that caused the source event (#116)', async () => {
    const sessions = [
      fakeSession({ sessionId: 'causer', cwd: '/r/.worktrees/p' }),
      fakeSession({ sessionId: 'other', cwd: '/r/.worktrees/p' }),
    ]
    const { store, issues, steward, sendTextWhenReady } = harness({ sessions })
    const p = issues.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    issues.update(p.id, { worktreePath: '/r/.worktrees/p' })
    const x = issues.create({ repoPath: '/r', title: 'Target', startNow: false })
    store.addSubscription(seedSub({ id: 'sub_c', subscriberId: p.id, sourceRef: x.id }))
    issues.close(x.id, 'done', { actorSessionId: 'causer' })
    await steward.tick()
    const targets = sendTextWhenReady.mock.calls.map((c) => (c as [string, string])[0])
    expect(targets).toEqual(['other'])
  })

  it('deliverNotify appends a steward.notify breadcrumb', async () => {
    const { store, issues, steward, sendTextWhenReady } = harness()
    const p = issues.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    const x = issues.create({ repoPath: '/r', title: 'Target', startNow: false })
    store.addSubscription(
      seedSub({
        id: 'sub_n',
        subscriberId: p.id,
        sourceRef: x.id,
        deliverNudge: false,
        deliverNotify: true,
      }),
    )
    issues.close(x.id)
    await steward.tick()
    expect(sendTextWhenReady).not.toHaveBeenCalled()
    const crumbs = store.listEventsSince(0, { kinds: ['steward.notify'] })
    expect(crumbs.length).toBe(1)
    expect(crumbs[0]).toMatchObject({
      subject: p.id,
      payload: { subscriptionId: 'sub_n', event: 'issue.closed' },
    })
  })
})
