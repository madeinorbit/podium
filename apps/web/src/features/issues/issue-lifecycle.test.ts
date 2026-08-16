import { asSessionId, type SessionMeta, type SessionMetaInput } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { issueBulkCloseSummary } from './issue-lifecycle'

/**
 * The DERIVATION's own cases live in `@podium/client-core`'s
 * `viewmodels/issue-close.test.ts` (POD-1129) — it moved there so the phone
 * could read the same facts. What is web-owned, and tested here, is the batch
 * shape and the desktop's `memberSessionIds` spelling of membership.
 */

const session = (over: Partial<SessionMetaInput>): SessionMeta =>
  ({
    sessionId: asSessionId('s'),
    agentKind: 'codex',
    title: 'Agent',
    cwd: '/r/wt',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-22T10:00:00.000Z',
    lastActiveAt: '2026-07-22T10:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  }) as SessionMeta

describe('issue bulk close summary', () => {
  it('counts a batch by what is unresolved in it, keeping selection order', () => {
    const sessions = [
      session({
        sessionId: 'busy',
        agentState: { phase: 'working', since: 'now', nativeSubagentCount: 0 },
      }),
    ]
    const summary = issueBulkCloseSummary(
      [
        makeIssue({ id: 'clean', seq: 1 }),
        makeIssue({ id: 'busy', seq: 2, memberSessionIds: ['busy'] }),
        makeIssue({ id: 'children', seq: 3, childCount: 2, childDoneCount: 0 }),
      ],
      sessions,
    )

    expect(summary.clear).toBe(1)
    expect(summary.flagged.map((entry) => entry.issue.id)).toEqual(['busy', 'children'])
    // Every flagged row can be drawn: `lead` is the concern the icon comes from.
    expect(summary.flagged.map((entry) => entry.lead.key)).toEqual(['working', 'children'])
  })

  it('attributes a session to the issue that owns it, not to the whole batch', () => {
    // The batch takes the WHOLE roster and resolves membership per issue. Hand
    // the derivation the roster directly and every session reads as attached to
    // every issue — one busy agent would flag all twelve rows of a selection.
    const busy = session({
      sessionId: 'busy',
      agentState: { phase: 'working', since: 'now', nativeSubagentCount: 0 },
    })
    const summary = issueBulkCloseSummary(
      [
        makeIssue({ id: 'owner', seq: 1, memberSessionIds: ['busy'] }),
        makeIssue({ id: 'bystander', seq: 2 }),
      ],
      [busy],
    )

    expect(summary.flagged.map((entry) => entry.issue.id)).toEqual(['owner'])
    expect(summary.clear).toBe(1)
  })

  it('flags nothing when a whole batch is resolved', () => {
    const summary = issueBulkCloseSummary([makeIssue({ id: 'a' }), makeIssue({ id: 'b' })])

    expect(summary).toEqual({ flagged: [], clear: 2 })
  })
})
