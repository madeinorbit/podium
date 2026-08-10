import type { SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { shortPath, standbyCopy } from './TranscriptStandby'

const session = (over: Partial<SessionMeta>): SessionMeta =>
  ({ agentKind: 'claude-code', status: 'live', ...over }) as SessionMeta

describe('standbyCopy', () => {
  it('names the agent standing by, and points at the composer', () => {
    const copy = standbyCopy(session({ agentKind: 'claude-code', status: 'live' }))
    expect(copy.title).toBe('Claude is standing by')
    expect(copy.hint).toMatch(/prompt/i)
  })

  it('treats a shell as having no transcript BY DESIGN, not as a missing one', () => {
    const copy = standbyCopy(session({ agentKind: 'shell' }))
    expect(copy.title).toMatch(/shell/i)
    expect(copy.lede).toMatch(/Native/)
  })

  it('says a stopped session wrote nothing — and asks nothing of the reader', () => {
    const copy = standbyCopy(session({ status: 'exited' }))
    expect(copy.title).toBe('This session wrote nothing')
    expect(copy.hint).toBeUndefined()
  })

  it('falls back to standby copy with no session at all', () => {
    expect(standbyCopy(undefined).title).toMatch(/standing by/)
  })
})

describe('shortPath', () => {
  it('leaves a short path alone', () => {
    expect(shortPath('/home/podium/podium')).toBe('/home/podium/podium')
  })

  it('abbreviates from the LEFT — the trailing segments identify the worktree', () => {
    expect(shortPath('/home/podium/podium/.claude/worktrees/pod-701-chat-view')).toBe(
      '…/worktrees/pod-701-chat-view',
    )
  })

  it('never invents a ~ for a machine whose home it cannot know', () => {
    expect(shortPath('/var/lib/podium/checkouts/some/deep/tree')).not.toContain('~')
  })
})
