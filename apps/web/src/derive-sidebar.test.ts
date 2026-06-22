import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  dedupeSessionsByConversation,
  partitionStaleSessions,
  partitionWorkItems,
  sortWorktrees,
  type WorktreeNavView,
} from './derive'

const NOW = Date.parse('2026-06-21T12:00:00.000Z')

/** Minimal session: idle/done (non-working) by default, last active `hoursAgo`. */
function sess(id: string, hoursAgo: number, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    conversationId: id,
    lastActiveAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    agentKind: 'claude-code',
    status: 'hibernated',
    busy: false,
    archived: false,
    agentState: { phase: 'idle', since: '', openTaskCount: 0, idle: { kind: 'done' } },
    ...over,
  } as unknown as SessionMeta
}

const working = (id: string, hoursAgo: number): SessionMeta =>
  sess(id, hoursAgo, {
    status: 'live',
    agentState: { phase: 'working', since: '', openTaskCount: 0 },
  } as Partial<SessionMeta>)

describe('partitionStaleSessions', () => {
  it('keeps everything visible when 5 or fewer sessions', () => {
    const list = [sess('a', 100), sess('b', 100), sess('c', 100), sess('d', 100), sess('e', 100)]
    const { visible, stale } = partitionStaleSessions(list, NOW)
    expect(stale).toEqual([])
    expect(visible).toHaveLength(5)
  })

  it('keeps everything visible when 3 or fewer stale candidates', () => {
    // 6 total but only 3 are old & non-working.
    const list = [
      sess('old1', 20),
      sess('old2', 20),
      sess('old3', 20),
      sess('fresh1', 1),
      sess('fresh2', 1),
      sess('fresh3', 1),
    ]
    const { stale } = partitionStaleSessions(list, NOW)
    expect(stale).toEqual([])
  })

  it('collapses stale candidates past the 3 most-recently-active', () => {
    // 7 total, 5 stale candidates (>16h, non-working) + 2 fresh.
    const list = [
      sess('s1', 17),
      sess('s2', 18),
      sess('s3', 19),
      sess('s4', 20),
      sess('s5', 21),
      sess('fresh1', 1),
      sess('fresh2', 2),
    ]
    const { visible, stale } = partitionStaleSessions(list, NOW)
    // The 3 most-recently-active candidates (s1,s2,s3) stay; s4,s5 collapse.
    expect(stale.map((s) => s.sessionId).sort()).toEqual(['s4', 's5'])
    expect(visible.map((s) => s.sessionId)).toContain('s1')
    expect(visible.map((s) => s.sessionId)).toContain('fresh1')
    expect(visible.map((s) => s.sessionId)).not.toContain('s4')
  })

  it('never collapses working sessions even if old', () => {
    const list = [
      working('w1', 50),
      working('w2', 50),
      sess('s1', 17),
      sess('s2', 18),
      sess('s3', 19),
      sess('s4', 20),
      sess('s5', 21),
    ]
    const { stale } = partitionStaleSessions(list, NOW)
    expect(stale.every((s) => s.sessionId.startsWith('s'))).toBe(true)
    expect(stale.map((s) => s.sessionId).sort()).toEqual(['s4', 's5'])
  })
})

function wt(path: string, branch: string | undefined, isMain: boolean): WorktreeNavView {
  return {
    path,
    branch,
    repoPath: '/repo',
    repoName: 'repo',
    isMain,
    sessions: [],
  } as WorktreeNavView
}

function withResume(
  id: string,
  status: SessionMeta['status'],
  resumeValue: string | undefined,
  hoursAgo = 1,
): SessionMeta {
  return sess(id, hoursAgo, {
    status,
    // Rows of one conversation share a conversationId (what the server now enforces);
    // the resume thread doubles as that id in these fixtures.
    ...(resumeValue
      ? { resume: { kind: 'codex-thread', value: resumeValue }, conversationId: resumeValue }
      : {}),
  } as Partial<SessionMeta>)
}

describe('partitionWorkItems pin vs attention', () => {
  const needsYou = (id: string): SessionMeta =>
    sess(id, 1, {
      status: 'live',
      agentState: {
        phase: 'needs_user',
        since: '',
        openTaskCount: 0,
        need: { kind: 'question' },
      },
    } as Partial<SessionMeta>)

  it('a pinned session that needs you still appears in NEEDS YOUR ATTENTION', () => {
    const { attention, pinnedPanels } = partitionWorkItems([needsYou('p')], new Set(['p']), NOW)
    expect(attention.map((s) => s.sessionId)).toEqual(['p'])
    expect(pinnedPanels).toEqual([])
  })

  it('a pinned idle session stays in PINNED PANELS', () => {
    const { attention, pinnedPanels } = partitionWorkItems(
      [sess('p', 1, { status: 'live' })],
      new Set(['p']),
      NOW,
    )
    expect(pinnedPanels.map((s) => s.sessionId)).toEqual(['p'])
    expect(attention).toEqual([])
  })
})

describe('dedupeSessionsByConversation', () => {
  it('keeps sessions with distinct conversations untouched', () => {
    const list = [withResume('a', 'live', undefined), withResume('b', 'live', undefined)]
    expect(dedupeSessionsByConversation(list).map((s) => s.sessionId)).toEqual(['a', 'b'])
  })

  it('collapses two rows of one conversation, keeping the live one', () => {
    const list = [
      withResume('exited-twin', 'exited', 'thread-1', 5),
      withResume('live-one', 'live', 'thread-1', 1),
      withResume('other', 'live', 'thread-2', 1),
    ]
    const out = dedupeSessionsByConversation(list)
    expect(out.map((s) => s.sessionId).sort()).toEqual(['live-one', 'other'])
  })

  it('keeps the most-recently-active when statuses tie', () => {
    const list = [
      withResume('old', 'exited', 'thread-9', 10),
      withResume('new', 'exited', 'thread-9', 1),
    ]
    expect(dedupeSessionsByConversation(list).map((s) => s.sessionId)).toEqual(['new'])
  })

  it('never keeps an archived row over a non-archived one (the disappearance bug)', () => {
    const archivedLive = withResume('arch', 'live', 'thread-x', 1)
    ;(archivedLive as { archived: boolean }).archived = true
    const live = withResume('keep', 'live', 'thread-x', 5) // older but not archived
    expect(dedupeSessionsByConversation([archivedLive, live]).map((s) => s.sessionId)).toEqual([
      'keep',
    ])
  })

  it('is order-independent on a full tie (no flip across broadcasts)', () => {
    // Same rank AND same lastActiveAt — the case that used to swing on arrival order.
    const a = withResume('aaa', 'live', 'thread-z', 1)
    const b = withResume('bbb', 'live', 'thread-z', 1)
    expect(dedupeSessionsByConversation([a, b]).map((s) => s.sessionId)).toEqual(['aaa'])
    expect(dedupeSessionsByConversation([b, a]).map((s) => s.sessionId)).toEqual(['aaa'])
  })
})

describe('sortWorktrees', () => {
  const main = wt('/repo', 'main', true)
  const zeta = wt('/repo/zeta', 'zeta', false)
  const alpha = wt('/repo/alpha', 'alpha', false)
  const all = [main, zeta, alpha]

  it('sorts alphabetically by branch', () => {
    const out = sortWorktrees(all, 'alphabetical', new Map())
    expect(out.map((w) => w.branch)).toEqual(['alpha', 'main', 'zeta'])
  })

  it('sorts by last used (recency desc), main wins ties', () => {
    const lru = new Map<string, number>([
      ['/repo/zeta', NOW - 1000],
      ['/repo/alpha', NOW - 5000],
    ])
    const out = sortWorktrees(all, 'lastUsed', lru)
    // zeta most recent, alpha next, main (no activity) last.
    expect(out.map((w) => w.branch)).toEqual(['zeta', 'alpha', 'main'])
  })
})
