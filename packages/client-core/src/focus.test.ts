import type { AgentRuntimeState, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  attentionGroup,
  attentionSummary,
  compareRecency,
  groupSessions,
  withoutShells,
} from './focus'

const needsUser = (since: string): AgentRuntimeState => ({
  phase: 'needs_user',
  since,
  openTaskCount: 0,
  need: { kind: 'question', summary: 'Need a decision' },
})

const working = (since: string): AgentRuntimeState => ({
  phase: 'working',
  since,
  openTaskCount: 0,
})

function meta(over: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  const { sessionId, ...rest } = over
  return {
    sessionId,
    agentKind: 'claude-code',
    title: 'task',
    cwd: '/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...rest,
  }
}

describe('shared focus selectors', () => {
  it('classifies attention, working, and idle sessions', () => {
    expect(
      attentionGroup(
        meta({ sessionId: 'need', agentState: needsUser('2026-07-01T01:00:00.000Z') }),
      ),
    ).toBe('needsYou')
    expect(
      attentionGroup(
        meta({ sessionId: 'work', agentState: working('2026-07-01T01:00:00.000Z') }),
      ),
    ).toBe('working')
    expect(attentionGroup(meta({ sessionId: 'idle', status: 'exited' }))).toBe('idle')
  })

  it('uses the captured need summary on attention cards', () => {
    const s = meta({
      sessionId: 'need',
      agentState: needsUser('2026-07-01T01:00:00.000Z'),
    })
    expect(attentionSummary(s)).toBe('Need a decision')
  })

  it('orders each focus group by effective recency', () => {
    const old = meta({
      sessionId: 'old',
      lastActiveAt: '2026-07-01T01:00:00.000Z',
      agentState: needsUser('2026-07-01T01:00:00.000Z'),
    })
    const draft = meta({
      sessionId: 'draft',
      lastActiveAt: '2026-07-01T00:00:00.000Z',
      draftUpdatedAt: '2026-07-01T02:00:00.000Z',
      agentState: needsUser('2026-07-01T00:00:00.000Z'),
    })
    expect([old, draft].sort(compareRecency).map((s) => s.sessionId)).toEqual(['draft', 'old'])
    expect(groupSessions([old, draft]).needsYou.map((s) => s.sessionId)).toEqual([
      'draft',
      'old',
    ])
  })

  it('drops shells and headless sessions from command-center lists', () => {
    const agent = meta({ sessionId: 'agent' })
    const shell = meta({ sessionId: 'shell', agentKind: 'shell' })
    const headless = meta({ sessionId: 'headless', headless: true })
    expect(withoutShells([agent, shell, headless]).map((s) => s.sessionId)).toEqual(['agent'])
  })
})

const idle = (since: string, kind: 'done' | 'question' = 'done'): AgentRuntimeState => ({
  phase: 'idle',
  since,
  openTaskCount: 0,
  idle: { kind },
})

const report = (
  attention: 'blocking' | 'soon' | 'whenever',
  over: Partial<SessionMeta['stopReport'] & object> = {},
): SessionMeta['stopReport'] => ({
  outcome: 'partial',
  need: 'decision',
  attention,
  summary: `declared ${attention}`,
  at: '2026-07-01T01:00:00.000Z',
  ...over,
})

describe('stop report is authoritative over the inferred phase', () => {
  it("routes a 'blocking' or 'soon' report to needsYou even when the phase reads done-idle", () => {
    const done = idle('2026-07-01T01:00:00.000Z', 'done')
    expect(attentionGroup(meta({ sessionId: 'b', agentState: done, stopReport: report('blocking') }))).toBe('needsYou')
    expect(attentionGroup(meta({ sessionId: 's', agentState: done, stopReport: report('soon') }))).toBe('needsYou')
  })

  it("routes a 'whenever' report to idle even when the phase would read needsYou", () => {
    const q = idle('2026-07-01T01:00:00.000Z', 'question')
    // Without the report this idle-with-question would be needsYou; the FYI overrides.
    expect(attentionGroup(meta({ sessionId: 'q', agentState: q }))).toBe('needsYou')
    expect(attentionGroup(meta({ sessionId: 'w', agentState: q, stopReport: report('whenever') }))).toBe('idle')
  })

  it('prefers the declared summary as the attention subtitle', () => {
    const s = meta({
      sessionId: 'x',
      agentState: needsUser('2026-07-01T01:00:00.000Z'),
      stopReport: report('blocking', { summary: 'Need the staging credential' }),
    })
    expect(attentionSummary(s)).toBe('Need the staging credential')
  })
})
