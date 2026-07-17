import type { SessionMeta } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import {
  type StewardDeps,
  sessionSpawnerParentId,
  StewardService,
  TRIGGER_RULES,
} from './steward'
import { SessionStore } from './store'
import { NotificationArbiter } from './store/notification-facts'

function harness(opts: { enabled?: boolean; sessions?: SessionMeta[]; seedCursor?: boolean } = {}) {
  const store = new SessionStore(':memory:')
  // Most tests want the events they emit consumed — pin the cursor to the log
  // start, as if the steward had been enabled since boot. First-enable seeding
  // tests pass seedCursor: false to exercise the absent-row path.
  if (opts.seedCursor !== false) store.events.setStewardState('cursor', '0')
  const sessions = opts.sessions ?? []
  const settings = normalizeSettings({
    steward: { enabled: opts.enabled ?? true },
    gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
    sessionDefaults: { agent: 'claude-code' },
  })
  // Incrementing clock: a pinned constant made same-batch comments share
  // created_at, so order assertions fell to the cmt_<uuid> tie-break (flaky).
  let clockMs = Date.parse('2026-07-02T00:00:00.000Z')
  const now = () => new Date(clockMs++).toISOString()
  const advanceTime = (ms: number) => {
    clockMs += ms
  }
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
  // The external-notification seam (#470) [spec:SP-17db] — injected, so the unit
  // tests assert the call without ever reaching ntfy/Telegram.
  const notify = vi.fn()
  const deps: StewardDeps = {
    store: store.events,
    facts: store.notificationFacts,
    issues,
    listSessions: () => sessions,
    sendTextWhenReady,
    notify,
    getSettings: () => settings,
    now,
  }
  return {
    store,
    issues,
    sendTextWhenReady,
    notify,
    deps,
    arbiter: new NotificationArbiter(store.notificationFacts, now),
    advanceTime,
    steward: new StewardService(deps),
  }
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
    store.events.appendEvent({ ts: 't', kind: 'issue.created', subject: 'iss_a', repoPath: '/r' })
    const id2 = store.events.appendEvent({
      ts: 't',
      kind: 'issue.created',
      subject: 'iss_b',
      repoPath: '/r',
    })
    await steward.tick()
    expect(store.events.getStewardState('cursor')).toBe(String(id2))
    // Crash-resume: a fresh instance over the same store starts past the batch.
    const reborn = new StewardService(deps)
    const listSpy = vi.spyOn(store.events, 'listEventsSince')
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
      cursorDuringHandler = store.events.getStewardState('cursor')
      return orig(id, author, body)
    })
    await steward.tick()
    expect(cursorDuringHandler).toBe('0') // still pre-batch while handling
    expect(Number(store.events.getStewardState('cursor'))).toBeGreaterThan(0)
  })

  it('first enable seeds the cursor to the log head — dark-run history never replays', async () => {
    const { store, issues, steward, sendTextWhenReady } = harness({ seedCursor: false })
    // Events accumulated while the steward ran dark (no cursor row yet).
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.addDep(b.id, a.id, 'blocks')
    issues.close(a.id)
    const max = store.events.maxEventId()
    expect(max).toBeGreaterThan(0)
    await steward.tick()
    expect(store.events.getStewardState('cursor')).toBe(String(max))
    expect(stewardComments(issues, b.id)).toEqual([])
    expect(sendTextWhenReady).not.toHaveBeenCalled()
  })

  it('a corrupt cursor re-seeds to the log head instead of wedging', async () => {
    const { store, issues, steward } = harness()
    store.events.setStewardState('cursor', 'garbage')
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(steward.tick()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[podium:steward] corrupt cursor'))
    expect(store.events.getStewardState('cursor')).toBe(String(store.events.maxEventId()))
    warn.mockRestore()
    // Recovered: the next event past the re-seed is consumed normally.
    issues.setNeedsHuman(a.id, 'q')
    await steward.tick()
    expect(store.events.listEventsSince(0, { kinds: ['steward.observed'] }).length).toBe(1)
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
    store.events.setStewardState('cursor', '0')
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
    store.events.setStewardState('cursor', '0')
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
    expect(store.events.listEventsSince(0, { kinds: ['steward.observed'] }).length).toBe(1)
  })
})

describe('StewardService needs-human handler', () => {
  it('P1: leaves only a steward.observed breadcrumb', async () => {
    const { store, issues, steward } = harness()
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    issues.setNeedsHuman(a.id, 'which key?')
    await steward.tick()
    const crumbs = store.events.listEventsSince(0, { kinds: ['steward.observed'] })
    expect(crumbs.length).toBe(1)
    expect(crumbs[0]).toMatchObject({ subject: a.id, payload: { kind: 'issue.needs_human' } })
    // The breadcrumb itself is unmatched — the next tick consumes it silently.
    await steward.tick()
    expect(store.events.listEventsSince(0, { kinds: ['steward.observed'] }).length).toBe(1)
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
    expect(store.events.getStewardState('cursor')).toBeUndefined()
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
    expect(Number(store.events.getStewardState('cursor'))).toBeGreaterThan(0)
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
    store.events.addSubscription(seedSub({ id: 'sub_1', subscriberId: p.id, sourceRef: x.id }))
    issues.close(x.id)
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    const [target, text] = sendTextWhenReady.mock.calls[0] as [string, string]
    expect(target).toBe('psess')
    expect(text).not.toContain('`')
    expect(text).not.toContain('\n')
    // Crash-replay: the same close event is re-read but never re-delivered.
    store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
  })

  it('a session.finished subscription nudges the subscriber session', async () => {
    const sessions = [
      fakeSession({ sessionId: 'watcher', cwd: '/w' }),
      fakeSession({ sessionId: 'worker', cwd: '/x' }),
    ]
    const { store, steward, sendTextWhenReady } = harness({ sessions })
    store.events.addSubscription(
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
    store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'worker',
      payload: { phase: 'active' },
    })
    store.events.appendEvent({
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
    store.events.addSubscription(
      seedSub({
        id: 'sub_rel',
        subscriberId: epic.id,
        event: 'session.finished',
        sourceKind: 'relationship',
        sourceRef: 'my-children',
      }),
    )
    // A non-child session finishing does NOT deliver.
    store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'stranger',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).not.toHaveBeenCalled()
    // The child session finishing DOES — its bound issue's parent is the subscriber.
    store.events.appendEvent({
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
    store.events.addSubscription(
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
    store.events.addSubscription(seedSub({ id: 'sub_c', subscriberId: p.id, sourceRef: x.id }))
    issues.close(x.id, 'done', { actorSessionId: 'causer' })
    await steward.tick()
    const targets = sendTextWhenReady.mock.calls.map((c) => (c as [string, string])[0])
    expect(targets).toEqual(['other'])
  })

  it('deliverNotify appends a steward.notify breadcrumb AND pushes externally (#470)', async () => {
    const { store, issues, steward, sendTextWhenReady, notify } = harness()
    const p = issues.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    const x = issues.create({ repoPath: '/r', title: 'Target', startNow: false })
    store.events.addSubscription(
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
    // The breadcrumb stays — it is the durable audit record the dedup is keyed on.
    const crumbs = store.events.listEventsSince(0, { kinds: ['steward.notify'] })
    expect(crumbs.length).toBe(1)
    expect(crumbs[0]).toMatchObject({
      subject: p.id,
      payload: { subscriptionId: 'sub_n', event: 'issue.closed' },
    })
    // …and the switch now does what its label says.
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toMatchObject({
      title: 'Podium: issue.closed',
      body: expect.stringContaining(x.id),
    })
    // Replay-safe with the breadcrumb: a cursor rewind re-matches but never re-pushes.
    store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('a notify:false subscription never pushes', async () => {
    const sessions = [fakeSession({ sessionId: 'psess', cwd: '/r/.worktrees/p' })]
    const { store, issues, steward, notify } = harness({ sessions })
    const p = issues.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    issues.update(p.id, { worktreePath: '/r/.worktrees/p' })
    const x = issues.create({ repoPath: '/r', title: 'Target', startNow: false })
    store.events.addSubscription(seedSub({ id: 'sub_q', subscriberId: p.id, sourceRef: x.id }))
    issues.close(x.id)
    await steward.tick()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a throwing notifier costs neither the breadcrumb nor the cursor advance', async () => {
    const { store, issues, steward, deps, notify } = harness()
    notify.mockImplementation(() => {
      throw new Error('ntfy exploded')
    })
    expect(deps.notify).toBe(notify)
    const p = issues.create({ repoPath: '/r', title: 'Watcher', startNow: false })
    const x = issues.create({ repoPath: '/r', title: 'Target', startNow: false })
    store.events.addSubscription(
      seedSub({
        id: 'sub_boom',
        subscriberId: p.id,
        sourceRef: x.id,
        deliverNudge: false,
        deliverNotify: true,
      }),
    )
    issues.close(x.id)
    await expect(steward.tick()).resolves.toBeUndefined()
    expect(store.events.listEventsSince(0, { kinds: ['steward.notify'] })).toHaveLength(1)
  })
})

describe('StewardService ack fallback (#237) [spec:SP-34d7 acks]', () => {
  it('maps settled session.phase events to ackfallback + sessionparentnudge (finished + errored only)', () => {
    const e = { id: 1, ts: 't', kind: 'session.phase', subject: 's9', repoPath: null, payload: {} }
    expect(
      TRIGGER_RULES['session.phase']!({ ...e, payload: { phase: 'idle', verdict: 'done' } }),
    ).toEqual(['ackfallback:s9', 'sessionparentnudge:done:s9'])
    expect(TRIGGER_RULES['session.phase']!({ ...e, payload: { phase: 'errored' } })).toEqual([
      'ackfallback:s9',
      'sessionparentnudge:errored:s9',
    ])
    expect(
      TRIGGER_RULES['session.phase']!({ ...e, payload: { phase: 'idle', verdict: 'needs_user' } }),
    ).toBeUndefined()
    expect(TRIGGER_RULES['session.phase']!({ ...e, payload: { phase: 'working' } })).toBeUndefined()
  })

  it('maps session.exited to a sessionparentnudge:exited key', () => {
    const e = { id: 1, ts: 't', kind: 'session.exited', subject: 's9', repoPath: null, payload: {} }
    expect(TRIGGER_RULES['session.exited']!(e)).toBe('sessionparentnudge:exited:s9')
  })

  it('invokes the messaging seam once per settled session with the outcome', async () => {
    const h = harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)
    h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's8',
      payload: { phase: 'errored' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(2)
    expect(ackFallback).toHaveBeenCalledWith('s9', 'finished', {
      factKey: 'settle:s9',
      target: 's9',
    })
    expect(ackFallback).toHaveBeenCalledWith('s8', 'errored', {
      factKey: 'settle:s8',
      target: 's8',
    })
    // Replays past the advanced cursor never re-fire.
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(2)
  })

  it('coalesces and replay-suppresses repeated events for one settle transition', async () => {
    const h = harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)
    for (let i = 0; i < 2; i++) {
      h.store.events.appendEvent({
        ts: 't',
        kind: 'session.phase',
        subject: 's9',
        payload: { phase: 'idle', verdict: 'done' },
      })
    }

    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    h.store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)
  })

  it('suppresses a second producer claiming the same settle fact and target', async () => {
    const h = harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)

    expect(
      h.arbiter.claim('settle:s9', 's9', {
        source: 'daemon.stop-hook',
      }),
    ).toBe(true)
    expect(
      h.arbiter.claim('settle:s9', 's9', {
        source: 'subscription:session.finished',
      }),
    ).toBe(false)

    h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).not.toHaveBeenCalled()
  })

  it('allows a replayed settle transition to re-fire after the fact TTL expires', async () => {
    const h = harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)
    h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })

    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    h.advanceTime(24 * 60 * 60 * 1000 + 1)
    h.store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(2)
  })

  it('is inert without the seam (unwired deployments)', async () => {
    const h = harness()
    h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'errored' },
    })
    await expect(h.steward.tick()).resolves.toBeUndefined()
  })
})

describe('StewardService notification fact retirement [spec:SP-ba61]', () => {
  it('retires facts scoped to an issue when issue.closed is consumed', async () => {
    const h = harness()
    const issue = h.issues.create({ repoPath: '/r', title: 'Closing', startNow: false })

    expect(
      h.arbiter.claim('sub:issue.ready:iss_source', 'target-session', {
        source: 'subscription:issue.ready',
        issueId: issue.id,
      }),
    ).toBe(true)
    expect(
      h.arbiter.claim('sub:issue.ready:iss_source', 'target-session', {
        source: 'steward.unblock',
        issueId: issue.id,
      }),
    ).toBe(false)

    h.issues.close(issue.id)
    await h.steward.tick()

    expect(
      h.arbiter.claim('sub:issue.ready:iss_source', 'target-session', {
        source: 'subscription:issue.ready',
        issueId: issue.id,
      }),
    ).toBe(true)
  })
})

/**
 * POD-890 / POD-908: retire arbiter facts when the underlying condition clears
 * so a later genuine edge re-fires without shortening the 24h TTL.
 */
describe('StewardService condition-clear fact retirement (POD-890)', () => {
  it('re-settling after leave-idle re-fires ackfallback (fact retired on leave; TTL unchanged)', async () => {
    const h = harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)

    // First settle → claim settle:s9 + fire once.
    h.store.events.appendEvent({
      ts: 't1',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    // Still settled (no leave): same-condition re-tick must NOT re-fire, and
    // the fact remains live well before the 24h TTL ceiling.
    h.store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)
    // A concurrent producer still loses while the fact is live (TTL not shortened).
    expect(
      h.arbiter.claim('settle:s9', 's9', { source: 'daemon.stop-hook' }),
    ).toBe(false)

    // Leave idle (working) → condition-clear retires settle:s9 (not TTL expiry).
    h.store.events.appendEvent({
      ts: 't2',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'working' },
    })
    await steward.tick()

    // Second genuine settle → re-fires.
    h.store.events.appendEvent({
      ts: 't3',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(2)
  })

  it('review→out→review re-fires the review parentnudge', async () => {
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

    // Enter review → first parentnudge.
    issues.update(c1.id, { stage: 'review' })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    expect((sendTextWhenReady.mock.calls[0] as [string, string])[1]).toContain('moved to review')

    // Leave review (condition clear) without closing.
    issues.update(c1.id, { stage: 'in_progress' })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)

    // Re-enter review → must re-fire (fact was retired on leave).
    issues.update(c1.id, { stage: 'review' })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(2)
    expect((sendTextWhenReady.mock.calls[1] as [string, string])[0]).toBe('plive')
    expect((sendTextWhenReady.mock.calls[1] as [string, string])[1]).toContain('moved to review')
  })

  it('flapping within the same condition still dedups (no over-fire)', async () => {
    const h = harness()
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)

    // Two settle events in one poll (rapid re-tick / dual producer shape).
    h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 's9',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    // Cursor rewind: still the same settled condition — no leave-idle — no re-fire.
    h.store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledTimes(1)

    // Review path: re-process the same review transition without leaving review.
    const sessions = [fakeSession({ sessionId: 'plive', cwd: '/r/.worktrees/issue-1-epic' })]
    const rev = harness({ sessions })
    const parent = rev.issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    rev.issues.update(parent.id, { worktreePath: '/r/.worktrees/issue-1-epic' })
    const c1 = rev.issues.create({
      repoPath: '/r',
      title: 'Child 1',
      parentId: parent.id,
      startNow: false,
    })
    rev.issues.update(c1.id, { stage: 'review' })
    await rev.steward.tick()
    expect(rev.sendTextWhenReady).toHaveBeenCalledTimes(1)
    rev.store.events.setStewardState('cursor', '0')
    await rev.steward.tick()
    expect(rev.sendTextWhenReady).toHaveBeenCalledTimes(1)
  })

  it('preserves POD-907 exit-after-done silence within one completion cycle', async () => {
    const sessions = [
      fakeSession({ sessionId: 'parent', status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: 'child',
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendTextWhenReady, store } = harness({ sessions })
    store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)

    // Exit in the SAME completion cycle (no leave-idle) stays silent.
    store.events.appendEvent({
      ts: 't',
      kind: 'session.exited',
      subject: 'child',
      payload: { code: 0, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)

    // A NEW work cycle: leave idle, settle again, exit after that settle —
    // leave-idle retires phase-reported so exit-after-done silence re-arms for
    // the new cycle (settle re-fires via event id; exit still suppressed).
    store.events.appendEvent({
      ts: 't2',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'working' },
    })
    await steward.tick()
    store.events.appendEvent({
      ts: 't3',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(2)
    store.events.appendEvent({
      ts: 't4',
      kind: 'session.exited',
      subject: 'child',
      payload: { code: 0, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(2)
  })

  it('needs_human clear→set re-fires the needs_human parentnudge', async () => {
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

    issues.setNeedsHuman(c1.id, 'which database?')
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)

    issues.clearNeedsHuman(c1.id)
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)

    issues.setNeedsHuman(c1.id, 'which database again?')
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(2)
  })
})

describe('sessionSpawnerParentId', () => {
  it('extracts a session parent id and rejects other provenance', () => {
    expect(sessionSpawnerParentId('session:parent-1')).toBe('parent-1')
    expect(sessionSpawnerParentId('issue:iss_1')).toBeUndefined()
    expect(sessionSpawnerParentId('user')).toBeUndefined()
    expect(sessionSpawnerParentId('session:')).toBeUndefined()
    expect(sessionSpawnerParentId(null)).toBeUndefined()
    expect(sessionSpawnerParentId(undefined)).toBeUndefined()
  })
})

/**
 * M4 / POD-904: session-spawner edge wakes a parked parent when its child
 * settles (done/errored) or exits without a prior settle report. Distinct from
 * ISSUE parentnudge (needs_human/closed/review), which stays live-only.
 */
describe('StewardService session-parent wake (POD-904 / §07b)', () => {
  it('wakes a PARKED session parent when the child settles idle+done', async () => {
    const sessions = [
      // Parked parent — issue parentnudge would skip this; session-parent wake must not.
      fakeSession({
        sessionId: 'parent',
        status: 'hibernated',
        cwd: '/r/parent',
        title: 'Coordinator',
      }),
      fakeSession({
        sessionId: 'child',
        status: 'live',
        cwd: '/r/child',
        title: 'Worker',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendTextWhenReady, store } = harness({ sessions })
    store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    const [target, text] = sendTextWhenReady.mock.calls[0] as [string, string]
    expect(target).toBe('parent')
    expect(text).toContain('child')
    expect(text).toMatch(/finished \(done\)/i)
    // Wake path = sendTextWhenReady (wired to queueText → resurrect), not a
    // breadcrumb-only steward.observed row.
    expect(store.events.listEventsSince(0, { kinds: ['steward.observed'] })).toHaveLength(0)
  })

  it('wakes a parked session parent when the child errors', async () => {
    const sessions = [
      fakeSession({ sessionId: 'parent', status: 'exited', cwd: '/r/p' }),
      fakeSession({
        sessionId: 'child',
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendTextWhenReady, store } = harness({ sessions })
    store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'errored' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    const [target, text] = sendTextWhenReady.mock.calls[0] as [string, string]
    expect(target).toBe('parent')
    expect(text).toMatch(/errored/i)
  })

  it('wakes a session parent on child exit-without-report (session.exited)', async () => {
    const sessions = [
      fakeSession({ sessionId: 'parent', status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: 'child',
        status: 'exited',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendTextWhenReady, store } = harness({ sessions })
    store.events.appendEvent({
      ts: 't',
      kind: 'session.exited',
      subject: 'child',
      payload: { code: 1, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    const [target, text] = sendTextWhenReady.mock.calls[0] as [string, string]
    expect(target).toBe('parent')
    expect(text).toMatch(/exited without reporting/i)
  })

  it('resolves parent from event payload spawnedBy when the child row is gone', async () => {
    // killSession removes the child before agentExit; payload carries spawnedBy.
    const sessions = [fakeSession({ sessionId: 'parent', status: 'hibernated', cwd: '/r/p' })]
    const { steward, sendTextWhenReady, store } = harness({ sessions })
    store.events.appendEvent({
      ts: 't',
      kind: 'session.exited',
      subject: 'gone-child',
      payload: { code: -1, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    expect((sendTextWhenReady.mock.calls[0] as [string, string])[0]).toBe('parent')
  })

  it('is silent when the child has no session-spawner parent', async () => {
    const sessions = [
      fakeSession({ sessionId: 'parent', status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: 'child',
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'issue:iss_x', // issue provenance — not the session edge
      }),
      fakeSession({ sessionId: 'orphan', status: 'live', cwd: '/r/o' }),
    ]
    const { steward, sendTextWhenReady, store } = harness({ sessions })
    store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'orphan',
      payload: { phase: 'errored' },
    })
    await steward.tick()
    expect(sendTextWhenReady).not.toHaveBeenCalled()
  })

  it('dedups: same settle re-tick and exit-after-done do not storm the parent', async () => {
    const sessions = [
      fakeSession({ sessionId: 'parent', status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: 'child',
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendTextWhenReady, store } = harness({ sessions })
    store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)

    // Cursor rewind + same settle event (same durable id): transition-instance
    // fact holds — flapping / crash-replay does not re-wake.
    store.events.setStewardState('cursor', '0')
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)

    // Exit after a clean done settle is not exit-without-report — phase-reported
    // sticky suppresses the exit wake (distinct event id alone would re-fire).
    store.events.appendEvent({
      ts: 't',
      kind: 'session.exited',
      subject: 'child',
      payload: { code: 0, spawnedBy: 'session:parent' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
  })

  it('re-fires on a genuinely NEW later settle of the same child (transition instance)', async () => {
    const sessions = [
      fakeSession({ sessionId: 'parent', status: 'hibernated', cwd: '/r/p' }),
      fakeSession({
        sessionId: 'child',
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const { steward, sendTextWhenReady, store } = harness({ sessions })

    // First settle → wake once.
    store.events.appendEvent({
      ts: 't1',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)

    // Distinct later settle (new durable event id) → wake AGAIN. Same child,
    // parent still parked — must not be swallowed by a child-only fact key.
    store.events.appendEvent({
      ts: 't2',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(2)
    expect((sendTextWhenReady.mock.calls[1] as [string, string])[0]).toBe('parent')

    // Re-process the second settle only (cursor rewind to just before it): still
    // one wake for that event id — not a third.
    const events = store.events.listEventsSince(0, { kinds: ['session.phase'] })
    expect(events.length).toBe(2)
    store.events.setStewardState('cursor', String(events[0]!.id))
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(2)
  })

  it('issue needs_human parentnudge path is unchanged (issue parent, live targets)', async () => {
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
    expect(store.events.listEventsSince(0, { kinds: ['steward.observed'] }).length).toBe(1)
  })

  it('keeps ackfallback alongside session-parent wake on the same settle', async () => {
    const sessions = [
      fakeSession({ sessionId: 'parent', status: 'live', cwd: '/r/p' }),
      fakeSession({
        sessionId: 'child',
        status: 'live',
        cwd: '/r/c',
        spawnedBy: 'session:parent',
      }),
    ]
    const h = harness({ sessions })
    const ackFallback = vi.fn()
    h.deps.messaging = { ackFallback }
    const steward = new StewardService(h.deps)
    h.store.events.appendEvent({
      ts: 't',
      kind: 'session.phase',
      subject: 'child',
      payload: { phase: 'idle', verdict: 'done' },
    })
    await steward.tick()
    expect(ackFallback).toHaveBeenCalledWith('child', 'finished', {
      factKey: 'settle:child',
      target: 'child',
    })
    expect(h.sendTextWhenReady).toHaveBeenCalledTimes(1)
    expect((h.sendTextWhenReady.mock.calls[0] as [string, string])[0]).toBe('parent')
  })
})
