import { describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@podium/protocol'
import { SessionStore } from './store'
import { IssueService, type IssueDeps } from './issues'
import { StewardService, TRIGGER_RULES, type StewardDeps } from './steward'

function harness(opts: { enabled?: boolean; sessions?: SessionMeta[] } = {}) {
  const store = new SessionStore(':memory:')
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
    let cursorDuringHandler: string | undefined = 'unset'
    const orig = issues.addComment.bind(issues)
    vi.spyOn(issues, 'addComment').mockImplementation((id, author, body) => {
      cursorDuringHandler = store.getStewardState('cursor')
      return orig(id, author, body)
    })
    await steward.tick()
    expect(cursorDuringHandler).toBeUndefined() // still pre-batch while handling
    expect(Number(store.getStewardState('cursor'))).toBeGreaterThan(0)
  })
})

describe('StewardService unblock handler', () => {
  it('posting the unblock comment carries the closed issue completion note; no duplicate on re-tick', async () => {
    const { issues, steward } = harness()
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.addDep(b.id, a.id, 'blocks')
    issues.addComment(a.id, 'agent', '[completion-note] shipped X')
    issues.close(a.id)
    await steward.tick()
    const first = stewardComments(issues, b.id)
    expect(first.length).toBe(1)
    expect(first[0]!.body).toContain(`Unblocked by #${a.seq}`)
    expect(first[0]!.body).toContain('shipped X')
    // Idempotence: replaying the events (fresh cursor) or a later ready event
    // for the same closer must not re-comment.
    await steward.tick()
    expect(stewardComments(issues, b.id).length).toBe(1)
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

  it('nudges each live session in the dependent worktree exactly once', async () => {
    const sessions = [
      { sessionId: 's1', cwd: '/r/.worktrees/issue-2-b' },
      { sessionId: 's2', cwd: '/elsewhere' },
    ] as never as SessionMeta[]
    const { issues, steward, sendTextWhenReady } = harness({ sessions })
    const a = issues.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = issues.create({ repoPath: '/r', title: 'B', startNow: false })
    issues.update(b.id, { worktreePath: '/r/.worktrees/issue-2-b' })
    issues.addDep(b.id, a.id, 'blocks')
    issues.addComment(a.id, 'agent', '[completion-note] shipped X')
    issues.close(a.id)
    await steward.tick()
    expect(sendTextWhenReady).toHaveBeenCalledTimes(1)
    expect(sendTextWhenReady).toHaveBeenCalledWith(
      's1',
      `Blocker #${a.seq} closed. shipped X. You are unblocked — check \`podium issue prime\`.`,
    )
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
  it('disabled → tick consumes nothing', async () => {
    const { store, issues, steward, sendTextWhenReady } = harness({ enabled: false })
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
