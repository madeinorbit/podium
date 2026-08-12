import type { SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { mostRelevantSession } from './mission-session'

/**
 * Which agent the mission opens on [POD-724]. This is a triage rule, not a
 * convenience: tapping a task lands the operator straight in one conversation,
 * so picking the wrong one costs them the pull-down and a second choice every
 * single time.
 */
const session = (partial: Partial<SessionMeta> & { id: string }): SessionMeta =>
  ({
    sessionId: asSessionId(partial.id),
    agentKind: 'claude-code',
    status: 'live',
    archived: false,
    cwd: '/src/podium',
    lastActiveAt: '2026-08-11T00:00:00.000Z',
    ...partial,
  }) as SessionMeta

describe('mostRelevantSession', () => {
  it('opens on the agent that is asking, even when a sibling is busier and newer', () => {
    const asking = session({
      id: 'ask',
      lastActiveAt: '2026-08-11T09:00:00.000Z',
      offer: {
        message: 'Merge it?',
        actions: [],
        createdAt: '2026-08-11T09:00:00.000Z',
      } as SessionMeta['offer'],
    })
    const working = session({
      id: 'work',
      lastActiveAt: '2026-08-11T10:00:00.000Z',
      agentState: {
        phase: 'working',
        since: '2026-08-11T10:00:00.000Z',
      } as SessionMeta['agentState'],
    })
    expect(mostRelevantSession([working, asking])?.sessionId).toBe(asking.sessionId)
  })

  it('prefers a working agent over one that has merely been alive longer', () => {
    const idle = session({ id: 'idle', lastActiveAt: '2026-08-11T11:00:00.000Z' })
    const working = session({
      id: 'work',
      lastActiveAt: '2026-08-11T08:00:00.000Z',
      agentState: {
        phase: 'working',
        since: '2026-08-11T08:00:00.000Z',
      } as SessionMeta['agentState'],
    })
    expect(mostRelevantSession([idle, working])?.sessionId).toBe(working.sessionId)
  })

  it('never opens on a finished transcript while a live one exists', () => {
    const exited = session({
      id: 'gone',
      status: 'exited',
      lastActiveAt: '2026-08-11T12:00:00.000Z',
    })
    const live = session({ id: 'live', lastActiveAt: '2026-08-10T12:00:00.000Z' })
    expect(mostRelevantSession([exited, live])?.sessionId).toBe(live.sessionId)
  })

  it('falls back to the most recent when every session is finished', () => {
    const older = session({ id: 'older', archived: true, lastActiveAt: '2026-08-09T00:00:00.000Z' })
    const newer = session({ id: 'newer', archived: true, lastActiveAt: '2026-08-10T00:00:00.000Z' })
    expect(mostRelevantSession([older, newer])?.sessionId).toBe(newer.sessionId)
  })

  it('has no answer for a mission with nobody on it', () => {
    expect(mostRelevantSession([])).toBeUndefined()
  })
})
