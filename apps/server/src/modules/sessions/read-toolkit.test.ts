// Read toolkit tiers 1–2 (#237) [spec:SP-34d7 read-toolkit]: status shape (no
// transcript text), issue-ref target resolution, the read line cap, and the
// per-read event log.

import type { SessionMeta, TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { IssueService } from '../issues/service'
import type { MessageDeliveryService } from '../messages/service'
import { READ_LINE_CAP, SessionReadToolkit } from './read-toolkit'

function session(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's1',
    cwd: '/wt/a',
    agentKind: 'claude-code',
    status: 'live',
    createdAt: 't',
    machineId: 'm1',
    agentState: { phase: 'working', since: 't', openTaskCount: 0 },
    ...over,
  } as SessionMeta
}

const ISSUE = {
  id: 'iss_a',
  seq: 228,
  stage: 'in_progress',
  title: 'The issue',
  worktreePath: '/wt/a',
  panel: { todos: [{ text: 'a', done: false }], artifacts: [], deferred: [] },
}

function harness(opts?: { sessions?: SessionMeta[]; items?: TranscriptItem[]; hasMore?: boolean }) {
  const events: { kind: string; subject: string; payload: unknown }[] = []
  const repoOps: string[] = []
  const toolkit = new SessionReadToolkit({
    listSessions: () => opts?.sessions ?? [session({ issueId: ISSUE.id })],
    issues: () =>
      ({
        resolveRef: (ref: string) => {
          if (ref === '#228' || ref === '228' || ref === ISSUE.id) return ISSUE.id
          throw new Error(`unknown ref ${ref}`)
        },
        get: (id: string) => (id === ISSUE.id ? ISSUE : undefined),
        issueForCwd: () => null,
      }) as unknown as IssueService,
    messages: () =>
      ({
        deliveredUnacked: () => [{ id: 'm1' }, { id: 'm2' }],
      }) as unknown as MessageDeliveryService,
    events: {
      appendEvent: (e) => {
        events.push({ kind: e.kind, subject: e.subject, payload: e.payload })
        return 1
      },
    },
    repoOp: async (op) => {
      repoOps.push(op)
      return op === 'log'
        ? { ok: true, output: 'c1 one\nc2 two\nc3\nc4\nc5\nc6\nc7' }
        : { ok: true, output: '## branch\n M a.ts\n?? b.ts' }
    },
    readTranscript: async () => ({
      items: opts?.items ?? [
        { id: 'i1', cursor: 'c1', role: 'user', text: 'hi' },
        { id: 'i2', cursor: 'c2', role: 'assistant', text: 'hello' },
      ],
      hasMore: opts?.hasMore ?? false,
    }),
    now: () => 't0',
  })
  return { toolkit, events, repoOps }
}

describe('session status (tier 1)', () => {
  it('returns phase, issue stage/todos, ≤5 commits, files, unacked count — no transcript', async () => {
    const { toolkit, events } = harness()
    const s = await toolkit.status('s1', 'operator')
    expect(s).toMatchObject({
      sessionId: 's1',
      phase: 'working',
      issue: { seq: 228, stage: 'in_progress', todos: ['[ ] a'] },
      unackedMessages: 2,
    })
    expect(s.commits).toHaveLength(5)
    expect(s.files).toEqual(['## branch', ' M a.ts', '?? b.ts'])
    expect(JSON.stringify(s)).not.toContain('transcript')
    expect(events).toEqual([
      { kind: 'session.status_read', subject: 's1', payload: { reader: 'operator' } },
    ])
  })

  it('resolves an issue ref to its best member session', async () => {
    const { toolkit } = harness()
    const s = await toolkit.status('#228', 'operator')
    expect(s.sessionId).toBe('s1')
    await expect(toolkit.status('#999', 'operator')).rejects.toThrow(/no session found/)
  })
})

describe('session read (tier 2)', () => {
  it('returns the bounded window with a paging cursor and event-logs the read', async () => {
    const { toolkit, events } = harness({ hasMore: true })
    const r = await toolkit.read({ sessionId: 's1', turns: 2 }, 'sX')
    expect(r.items.map((i) => i.text)).toEqual(['hi', 'hello'])
    expect(r.cursor).toBe('c1')
    expect(r.hasMore).toBe(true)
    expect(events[0]).toMatchObject({
      kind: 'session.transcript_read',
      subject: 's1',
      payload: { reader: 'sX' },
    })
  })

  it('hard-caps total lines, dropping OLDER items first', async () => {
    const big = Array.from({ length: 10 }, (_, n) => ({
      id: `i${n}`,
      cursor: `c${n}`,
      role: 'assistant' as const,
      text: Array.from({ length: 40 }, (_, l) => `line${n}.${l}`).join('\n'),
    }))
    const { toolkit } = harness({ items: big })
    const r = await toolkit.read({ sessionId: 's1' }, 'op')
    expect(r.truncated).toBe(true)
    const totalLines = r.items.reduce((a, i) => a + i.text.split('\n').length + 1, 0)
    expect(totalLines).toBeLessThanOrEqual(READ_LINE_CAP)
    // newest items survive
    expect(r.items[r.items.length - 1]!.text).toContain('line9.')
  })

  it('rejects an unknown session', async () => {
    const { toolkit } = harness()
    await expect(toolkit.read({ sessionId: 'nope' }, 'op')).rejects.toThrow(/unknown session/)
  })
})
