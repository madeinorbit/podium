import type { SessionMeta } from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { shortPath, standbyCopy, TranscriptStandby } from './TranscriptStandby'

const session = (over: Partial<SessionMeta>): SessionMeta =>
  ({ agentKind: 'claude-code', status: 'live', ...over }) as SessionMeta

describe('standbyCopy', () => {
  it('asks the operator what to work on, and nothing else', () => {
    const copy = standbyCopy(session({ agentKind: 'claude-code', status: 'live' }))
    expect(copy.title).toBe('What do you want to work on?')
    expect(copy.asking).toBe(true)
    // The composer is directly below the question — a note pointing at it would
    // be the instruction line POD-746 removed.
    expect(copy.note).toBeUndefined()
  })

  it('treats a shell as having no transcript BY DESIGN, not as a missing one', () => {
    const copy = standbyCopy(session({ agentKind: 'shell' }))
    expect(copy.title).toMatch(/shell/i)
    expect(copy.note).toMatch(/CLI/)
  })

  it('says a stopped session wrote nothing — and asks nothing of the reader', () => {
    const copy = standbyCopy(session({ status: 'exited' }))
    expect(copy.title).toBe('This session wrote nothing')
    expect(copy.asking).toBe(false)
  })

  it('falls back to the question with no session at all', () => {
    expect(standbyCopy(undefined).asking).toBe(true)
  })
})

describe('the ghost harness mark', () => {
  afterEach(() => {
    cleanup()
  })

  const ghost = (): Element | null => document.querySelector('.transcript-standby-ghost')

  it('grounds the question in the mark of the harness that is waiting', () => {
    render(<TranscriptStandby session={session({ agentKind: 'claude-code' })} cwd="/w" />)
    expect(ghost()).not.toBeNull()
    // Decorative: the coordinates line already NAMES the harness, so a second
    // announcement of it is noise to a screen reader.
    expect(ghost()?.getAttribute('aria-hidden')).toBe('true')
  })

  it('gives a shell none — it never asks, and its glyph is not a brand mark', () => {
    render(<TranscriptStandby session={session({ agentKind: 'shell' })} cwd="/w" />)
    expect(ghost()).toBeNull()
  })

  it('gives a stopped session none — there is no question to sit behind', () => {
    render(<TranscriptStandby session={session({ status: 'exited' })} cwd="/w" />)
    expect(ghost()).toBeNull()
  })

  it('gives the orchestrator none — it is not a harness', () => {
    render(<TranscriptStandby session={undefined} cwd="/w" superagent />)
    expect(screen.getByText('What do you want to work on?')).toBeTruthy()
    expect(ghost()).toBeNull()
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
