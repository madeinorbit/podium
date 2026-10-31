import type { SessionView, SessionViewInput } from '@podium/client-core/session-values'
// Cross-harness child grouping (#237) [spec:SP-34d7 web]: sessions spawned by
// another session nest under their spawner in the sidebar; consumed (exited)
// children auto-tuck behind a disclosure. M6 also expands for native counts.

import {
  nativeSubagentLabel,
  sessionIssueLinkage,
} from '@podium/client-core/values'

import { describe, expect, it } from 'vitest'

function sess(id: string, over: Partial<SessionViewInput> = {}): SessionView {
  return {
    sessionId: id,
    cwd: '/repo',
    createdAt: '2026-07-13T00:00:00.000Z',
    lastActiveAt: '2026-07-13T01:00:00.000Z',
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: id,
    ...over,
  } as unknown as SessionView
}

describe('nativeSubagentLabel / sessionIssueLinkage', () => {
  it('labels native counts and surfaces issue linkage from SessionView', () => {
    expect(nativeSubagentLabel(2)).toBe('2 subagents')
    expect(sessionIssueLinkage(sess('c', { displayRef: 'POD-9-B', issueId: 'iss_x' }))).toBe(
      'POD-9-B',
    )
    expect(sessionIssueLinkage(sess('c', { issueId: 'iss_x' }), 'POD-9')).toBe('POD-9')
    expect(sessionIssueLinkage(sess('c', { issueId: 'iss_x' }))).toBeNull()
  })
})
