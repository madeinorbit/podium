import type { AgentRuntimeState } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { attentionNotice } from './notify'

const state = (
  phase: AgentRuntimeState['phase'],
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState => ({ phase, since: '2026-06-12T10:00:00.000Z', openTaskCount: 0, ...extra })

describe('attentionNotice', () => {
  it('fires on the transition into needs_user with the real question', () => {
    const n = attentionNotice(
      'podium / keyboard',
      state('working'),
      state('needs_user', {
        need: { kind: 'question', summary: 'SQLite or Postgres?' },
      }),
    )
    expect(n).toEqual({ title: 'podium / keyboard needs you', body: 'SQLite or Postgres?' })
  })

  it('stays quiet on a re-report of the same blocked phase', () => {
    const blocked = state('needs_user', { need: { kind: 'permission' } })
    expect(attentionNotice('s', blocked, blocked)).toBeNull()
  })

  it('fires for errors and idle questions/approvals, not plain done', () => {
    expect(
      attentionNotice(
        's',
        state('working'),
        state('errored', {
          error: { class: 'rate_limit', retryable: true },
        }),
      )?.body,
    ).toContain('rate_limit')
    expect(
      attentionNotice('s', state('working'), state('idle', { idle: { kind: 'approval' } }))?.title,
    ).toContain('plan ready')
    expect(
      attentionNotice('s', state('working'), state('idle', { idle: { kind: 'done' } })),
    ).toBeNull()
    expect(
      attentionNotice('s', state('working'), state('idle', { idle: { kind: 'interrupted' } })),
    ).toBeNull()
    expect(attentionNotice('s', state('working'), state('working'))).toBeNull()
  })
})
