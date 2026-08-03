// @vitest-environment happy-dom
/**
 * POD-1535 — the rendered presence surface.
 *
 * The point of this suite is the ONE thing the gate's finding turns on: a
 * watcher can SEE who else is present, and "we do not know" never renders as
 * "nobody is here".
 */
import type { PresenceMember } from '@podium/protocol'
import { asSessionId } from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchersOf, watchersSummary } from './watchers'

type View =
  | { status: 'unknown'; members?: undefined }
  | { status: 'present'; members: readonly PresenceMember[] }

let presence: View = { status: 'unknown' }
let principal: { userId: string } | null = { userId: 'user:me' }
const usePresenceRoom = vi.fn(() => presence)

vi.mock('@podium/client-core/react', () => ({
  usePresenceRoom: (...args: unknown[]) => usePresenceRoom(...(args as [])),
  useCurrentPrincipal: () => principal,
}))

const { SessionWatchers } = await import('./SessionWatchers')

const SESSION = asSessionId('s_1')
const user = (id: string, payload?: unknown): PresenceMember => ({
  identity: { kind: 'user', user: id as never },
  ...(payload === undefined ? {} : { payload }),
})
const agent = (id: string, onBehalfOf: string): PresenceMember => ({
  identity: { kind: 'agent', agentIdentity: id as never, onBehalfOf: onBehalfOf as never },
})

beforeEach(() => {
  presence = { status: 'unknown' }
  principal = { userId: 'user:me' }
  usePresenceRoom.mockClear()
})
afterEach(cleanup)

const strip = () => screen.getByTestId('session-watchers')

describe('SessionWatchers', () => {
  it('joins the session room and publishes which pane this connection is reading', () => {
    render(<SessionWatchers sessionId={SESSION} view="native" />)
    expect(usePresenceRoom).toHaveBeenCalledWith({ kind: 'session', id: SESSION }, { view: 'native' })
  })

  it('renders unknown presence as unavailable — never as a count and never as nobody', () => {
    render(<SessionWatchers sessionId={SESSION} view="chat" />)
    expect(strip().dataset.presenceStatus).toBe('unknown')
    expect(screen.queryAllByTestId('session-watcher-chip')).toHaveLength(0)
    const label = strip().getAttribute('aria-label') ?? ''
    expect(label).toContain('unknown')
    expect(label).not.toMatch(/nobody|no one|0/i)
  })

  it('says "only you" — a different sentence from "unknown" — for a known-empty room', () => {
    presence = { status: 'present', members: [user('user:me')] }
    render(<SessionWatchers sessionId={SESSION} view="chat" />)
    expect(strip().dataset.presenceStatus).toBe('present')
    expect(strip().getAttribute('aria-label')).toBe('Only you are here')
    expect(screen.queryAllByTestId('session-watcher-chip')).toHaveLength(0)
  })

  it('renders a chip per OTHER watcher, excluding this principal', () => {
    presence = {
      status: 'present',
      members: [user('user:me'), user('user:alice'), agent('agent_bot', 'user:bob')],
    }
    render(<SessionWatchers sessionId={SESSION} view="chat" />)
    expect(screen.getAllByTestId('session-watcher-chip')).toHaveLength(2)
    const label = strip().getAttribute('aria-label') ?? ''
    expect(label).toContain('user:alice is here')
    expect(label).toContain('Agent agent_bot, for user:bob, is here')
    expect(label).not.toContain('user:me')
  })

  it('collapses past three others into a +N token', () => {
    presence = {
      status: 'present',
      members: ['a', 'b', 'c', 'd', 'e'].map((n) => user(`user:${n}`)),
    }
    render(<SessionWatchers sessionId={SESSION} view="chat" />)
    expect(screen.getAllByTestId('session-watcher-chip')).toHaveLength(3)
    expect(screen.getByTestId('session-watcher-overflow').textContent).toBe('+2')
  })

  it('keeps showing everyone when the client has no principal to exclude', () => {
    principal = null
    presence = { status: 'present', members: [user('user:me'), user('user:alice')] }
    render(<SessionWatchers sessionId={SESSION} view="chat" />)
    expect(screen.getAllByTestId('session-watcher-chip')).toHaveLength(2)
  })
})

describe('watchersOf / watchersSummary', () => {
  it('reports what a watcher is looking at from the room payload', () => {
    const [w] = watchersOf([user('user:alice', { view: 'native' })], 'user:me')
    expect(w?.label).toBe('user:alice is here — watching the terminal')
  })

  it('says nothing about focus for an unrecognised payload rather than guessing', () => {
    const [w] = watchersOf([user('user:alice', { view: 'something-else' })], 'user:me')
    expect(w?.label).toBe('user:alice is here')
  })

  it('never produces a count or the word nobody for unknown', () => {
    expect(watchersSummary('unknown', [])).toBe(
      'Presence unavailable — who else is here is unknown',
    )
  })
})
