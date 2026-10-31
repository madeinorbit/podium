import type { SessionView, SessionViewInput } from '../session-values'
// Cross-harness child grouping + native-subagent expand rules (M6 / POD-900).

import { describe, expect, it } from 'vitest'
import {
  nativeSubagentCountOf,
  nativeSubagentLabel,
  sessionHasNativeSubagents,
  sessionIssueLinkage,
} from './index'

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

describe('nativeSubagent helpers', () => {
  it('reads nativeSubagentCount from agentState (0 when absent)', () => {
    expect(nativeSubagentCountOf(sess('a'))).toBe(0)
    expect(
      nativeSubagentCountOf(
        sess('b', { agentState: { phase: 'working', since: 't', nativeSubagentCount: 3 } }),
      ),
    ).toBe(3)
    expect(
      sessionHasNativeSubagents(
        sess('c', { agentState: { phase: 'working', since: 't', nativeSubagentCount: 1 } }),
      ),
    ).toBe(true)
    expect(sessionHasNativeSubagents(sess('d'))).toBe(false)
  })

  it('formats the nested indicator label', () => {
    expect(nativeSubagentLabel(0)).toBe('')
    expect(nativeSubagentLabel(1)).toBe('1 subagent')
    expect(nativeSubagentLabel(3)).toBe('3 subagents')
  })
})

describe('sessionIssueLinkage', () => {
  it('prefers the session displayRef, falls back to the issue displayRef, and hides IDs', () => {
    expect(sessionIssueLinkage(sess('a'))).toBeNull()
    expect(sessionIssueLinkage(sess('b', { issueId: 'iss_1' }))).toBeNull()
    expect(sessionIssueLinkage(sess('b', { issueId: 'iss_1' }), 'POD-42')).toBe('POD-42')
    expect(
      sessionIssueLinkage(sess('c', { issueId: 'iss_1', displayRef: 'POD-42-B' }), 'POD-42'),
    ).toBe('POD-42-B')
    expect(sessionIssueLinkage(sess('d', { displayRef: '  ' }))).toBeNull()
    expect(sessionIssueLinkage(sess('e', { issueId: 'iss_1' }), '  ')).toBeNull()
  })
})
