/**
 * The tab/row status grammar (.design/specs/native-pane.md §2.8): working →
 * braille spinner, waiting on you → still amber (dot on tabs, pill on rows),
 * everything else → nothing. Stillness is a signal, so the "renders nothing"
 * cases are as load-bearing as the glyphs.
 */
import type { SessionMeta } from '@podium/protocol'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentStatusGlyph } from './AgentStatusGlyph'

afterEach(cleanup)

function session(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's1',
    agentKind: 'claude-code',
    cwd: '/w',
    status: 'live',
    lastActiveAt: '2026-07-14T12:00:00.000Z',
    ...over,
  } as SessionMeta
}

const working = session({
  agentState: { phase: 'working', since: '2026-07-14T12:00:00.000Z', openTaskCount: 0 },
})
const waiting = session({
  agentState: {
    phase: 'needs_user',
    since: '2026-07-14T12:00:00.000Z',
    openTaskCount: 0,
    need: { kind: 'question' },
  },
} as Partial<SessionMeta>)
const done = session({
  agentState: {
    phase: 'idle',
    since: '2026-07-14T12:00:00.000Z',
    openTaskCount: 0,
    idle: { kind: 'done' },
  },
})

describe('AgentStatusGlyph — tab variant', () => {
  it('working renders the braille spinner (the only ongoing motion)', () => {
    const { container } = render(<AgentStatusGlyph session={working} variant="tab" />)
    expect(container.querySelector('span.spb')).toBeTruthy()
  })

  it('waiting renders a still amber dot, no spinner', () => {
    const { container } = render(<AgentStatusGlyph session={waiting} variant="tab" />)
    expect(container.querySelector('span.spb')).toBeNull()
    const dot = container.querySelector('[aria-label="waiting on you"]') as HTMLElement
    expect(dot).toBeTruthy()
    expect(dot.style.background).toContain('--motion-waiting')
  })

  it('done and idle render nothing — stillness is the signal', () => {
    expect(render(<AgentStatusGlyph session={done} variant="tab" />).container.innerHTML).toBe('')
    const idle = session({})
    expect(
      render(<AgentStatusGlyph session={idle} variant="tab" />).container.innerHTML,
    ).not.toContain('aria-label')
  })
})

describe('AgentStatusGlyph — row variant (mobile menu rows)', () => {
  it('waiting renders the amber pill, numbered when a count is given', () => {
    const { container } = render(<AgentStatusGlyph session={waiting} variant="row" count={3} />)
    const pill = container.querySelector('[role="img"]') as HTMLElement
    expect(pill.getAttribute('aria-label')).toBe('3 waiting on you')
    expect(pill.textContent).toBe('3')
  })

  it('waiting without a count stays an unnumbered pill', () => {
    const { container } = render(<AgentStatusGlyph session={waiting} variant="row" />)
    const pill = container.querySelector('[role="img"]') as HTMLElement
    expect(pill.getAttribute('aria-label')).toBe('waiting on you')
    expect(pill.textContent).toBe('')
  })

  it('working renders the spinner at row size', () => {
    const { container } = render(<AgentStatusGlyph session={working} variant="row" />)
    const el = container.querySelector('span.spb') as HTMLElement
    expect(el.style.fontSize).toBe('10px')
  })
})
