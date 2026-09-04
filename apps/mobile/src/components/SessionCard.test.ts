import type { SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { hidesDraftDot } from './SessionCard'

/**
 * What this file guards is the DRAFT-DOT GATE: a draft chat that has never
 * started shows no status dot, while every live state — a running turn, a
 * pending ask, an error, idle-after-a-turn — keeps its dot even on a draft.
 */
function session(over: Record<string, unknown> = {}): SessionMeta {
  return {
    sessionId: asSessionId('s1'),
    agentKind: 'claude-code',
    status: 'live',
    archived: false,
    cwd: '/r',
    lastActiveAt: '2026-08-28T00:00:00.000Z',
    ...over,
  } as unknown as SessionMeta
}

const draft = { draft: true }
const promoted = { draft: false }

describe('hidesDraftDot', () => {
  it('hides the dot on a draft chat that never started a turn', () => {
    expect(hidesDraftDot({ dotTone: 'ready' }, draft, session())).toBe(true)
    // The `unknown` phase is the same fact: nothing observed yet.
    expect(
      hidesDraftDot({ dotTone: 'ready' }, draft, session({ agentState: { phase: 'unknown' } })),
    ).toBe(true)
  })

  it('keeps the dot once the draft is actually live', () => {
    // A turn was started and finished — idle-after-a-turn is a live ready state.
    expect(
      hidesDraftDot(
        { dotTone: 'ready' },
        draft,
        session({ agentState: { phase: 'idle', since: '2026-08-28T00:00:00.000Z' } }),
      ),
    ).toBe(false)
    // Attention (an ask, or an offer with no agentState) keeps its amber dot.
    expect(hidesDraftDot({ dotTone: 'attention' }, draft, session())).toBe(false)
    expect(hidesDraftDot({ dotTone: 'error' }, draft, session())).toBe(false)
    // An uninstrumented shell with a command running is live.
    expect(hidesDraftDot({ dotTone: 'ready' }, draft, session({ busy: true }))).toBe(false)
  })

  it('never hides the dot on a promoted (non-draft) task or without context', () => {
    expect(hidesDraftDot({ dotTone: 'ready' }, promoted, session())).toBe(false)
    expect(hidesDraftDot({ dotTone: 'ready' }, undefined, session())).toBe(false)
    expect(hidesDraftDot({ dotTone: 'ready' }, draft, undefined)).toBe(false)
  })
})
