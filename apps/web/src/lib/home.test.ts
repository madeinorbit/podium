import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { withoutShells } from './home'

function meta(over: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastActiveAt: '2026-06-10T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  }
}

describe('withoutShells', () => {
  it('drops shell sessions from a command-center list', () => {
    const agent = meta({ sessionId: 'ag', agentKind: 'claude-code' })
    const shell = meta({ sessionId: 'sh', agentKind: 'shell' })
    expect(withoutShells([agent, shell]).map((s) => s.sessionId)).toEqual(['ag'])
  })

  it('keeps every non-shell agent kind', () => {
    const claude = meta({ sessionId: 'c', agentKind: 'claude-code' })
    const codex = meta({ sessionId: 'x', agentKind: 'codex' })
    expect(withoutShells([claude, codex]).map((s) => s.sessionId)).toEqual(['c', 'x'])
  })
})
