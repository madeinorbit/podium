import { asSessionId, type SessionMeta, type SessionStatus } from '@podium/model'
import { describe, expect, test } from 'vitest'
import { deriveFleetPresence } from './fleet'

let seq = 0
function sess(over: Partial<SessionMeta> = {}): SessionMeta {
  seq += 1
  return {
    sessionId: asSessionId(`s${seq}`),
    cwd: '/r/acme',
    lastActiveAt: '2026-08-12T12:00:00.000Z',
    agentKind: 'claude-code',
    status: 'live' as SessionStatus,
    busy: false,
    archived: false,
    title: 'a session',
    ...over,
  } as unknown as SessionMeta
}

describe('deriveFleetPresence', () => {
  test('a parked agent is on the task — it is counted and it gets a tile', () => {
    // The whole POD-756 bug in one case: every Codex session in the fleet was
    // hibernated, so the issue rendered no Codex at all.
    const m = deriveFleetPresence([sess({ agentKind: 'codex', status: 'hibernated' })])
    expect(m.present).toHaveLength(1)
    expect(m.parkedCount).toBe(1)
    expect(m.tiles).toEqual([{ kind: 'codex', parked: true }])
  })

  test('exited and archived sessions are gone, not ghosted', () => {
    const m = deriveFleetPresence([
      sess({ status: 'exited' }),
      sess({ agentKind: 'grok', archived: true }),
      sess({ agentKind: 'grok', archived: true, status: 'hibernated' }),
    ])
    expect(m.present).toEqual([])
    expect(m.tiles).toEqual([])
    expect(m.parkedCount).toBe(0)
  })

  test('one awake session of a kind keeps that kind solid', () => {
    const m = deriveFleetPresence([
      sess({ agentKind: 'codex', status: 'hibernated' }),
      sess({ agentKind: 'codex', status: 'live' }),
      sess({ agentKind: 'grok', status: 'hibernated' }),
    ])
    expect(m.tiles).toEqual([
      { kind: 'codex', parked: false },
      { kind: 'grok', parked: true },
    ])
    expect(m.present).toHaveLength(3)
    expect(m.parkedCount).toBe(2)
  })

  test('kinds keep first-seen order and collapse duplicates', () => {
    const m = deriveFleetPresence([
      sess({ agentKind: 'grok' }),
      sess({ agentKind: 'claude-code' }),
      sess({ agentKind: 'grok' }),
      sess({ agentKind: 'codex' }),
      sess({ agentKind: 'cursor' }),
    ])
    // Not sliced here: the limit is the renderer's, so the count stays honest.
    expect(m.tiles.map((t) => t.kind)).toEqual(['grok', 'claude-code', 'codex', 'cursor'])
    expect(m.present).toHaveLength(5)
  })

  test('native children are counted on awake sessions only', () => {
    const withKids = (n: number, over: Partial<SessionMeta> = {}) =>
      sess({ ...over, agentState: { nativeSubagentCount: n } } as Partial<SessionMeta>)
    const m = deriveFleetPresence([withKids(3), withKids(4, { status: 'hibernated' })])
    // A parked process is not running four subagents; its last agentState says so
    // only because it was frozen mid-turn.
    expect(m.nativeCount).toBe(3)
  })

  test('the label says agents and parked, never "live agents"', () => {
    expect(deriveFleetPresence([sess()]).label).toBe('1 agent')
    expect(
      deriveFleetPresence([sess(), sess({ agentKind: 'codex', status: 'hibernated' })]).label,
    ).toBe('2 agents · 1 parked')
    expect(
      deriveFleetPresence([
        sess({ agentState: { nativeSubagentCount: 2 } } as Partial<SessionMeta>),
        sess({ status: 'hibernated' }),
      ]).label,
    ).toBe('2 agents · 1 parked · 2 native children')
  })

  test('an empty fleet has an empty everything', () => {
    const m = deriveFleetPresence([])
    expect(m).toEqual({ present: [], parkedCount: 0, tiles: [], nativeCount: 0, label: '0 agents' })
  })
})
