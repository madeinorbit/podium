// @vitest-environment happy-dom
import { asSessionId, type SessionMeta } from '@podium/model'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(store.value),
}))

import {
  DockShellLifecycle,
  dockShellIsDead,
  dockShellIsParked,
  staleDockShellIds,
} from './dock-shell-lifecycle'

const session = (
  over: Omit<Partial<SessionMeta>, 'sessionId'> & { sessionId: string },
): SessionMeta => {
  const { sessionId, ...rest } = over
  return {
    sessionId: asSessionId(sessionId),
    agentKind: 'shell',
    archived: false,
    status: 'live',
    ...rest,
  } as SessionMeta
}

afterEach(cleanup)

describe('dock shell lifecycle', () => {
  it('treats exited shells as dead, parked shells as resumable, but not startup transients', () => {
    // POD-4429: hibernated is parked, not dead — the dock resumes the same id.
    expect(dockShellIsDead(session({ sessionId: 'hibernated', status: 'hibernated' }))).toBe(false)
    expect(dockShellIsParked(session({ sessionId: 'hibernated', status: 'hibernated' }))).toBe(true)
    expect(dockShellIsDead(session({ sessionId: 'exited', status: 'exited' }))).toBe(true)
    expect(dockShellIsParked(session({ sessionId: 'exited', status: 'exited' }))).toBe(false)
    expect(dockShellIsDead(session({ sessionId: 'archived', archived: true }))).toBe(true)
    expect(dockShellIsDead(session({ sessionId: 'starting', status: 'starting' }))).toBe(false)
    expect(dockShellIsDead(session({ sessionId: 'reconnecting', status: 'reconnecting' }))).toBe(
      false,
    )
  })

  it('selects only dead, unarchived shells owned by the dock mapping', () => {
    const dockShells = {
      '/repo/a': asSessionId('dead'),
      '/repo/b': asSessionId('live'),
      '/repo/c': asSessionId('agent'),
      '/repo/d': asSessionId('parked'),
    }
    const sessions = [
      session({ sessionId: 'dead', status: 'exited' }),
      session({ sessionId: 'live' }),
      session({ sessionId: 'agent', agentKind: 'codex', status: 'exited' }),
      session({ sessionId: 'parked', status: 'hibernated' }),
      session({ sessionId: 'unmapped', status: 'exited' }),
      session({ sessionId: 'already-archived', status: 'exited', archived: true }),
    ]

    expect(staleDockShellIds(dockShells, sessions)).toEqual([asSessionId('dead')])
  })

  it('archives a mapped dead shell without mounting the Shell panel', async () => {
    const mutate = vi.fn(async () => undefined)
    store.value = {
      dockShells: { '/repo/a': asSessionId('dead') },
      sessions: [session({ sessionId: 'dead', status: 'exited' })],
      trpc: { sessions: { setArchived: { mutate } } },
    }

    render(createElement(DockShellLifecycle))

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({ sessionId: asSessionId('dead'), archived: true }),
    )
  })

  it('leaves a parked shell alone without mounting the Shell panel', async () => {
    const mutate = vi.fn(async () => undefined)
    store.value = {
      dockShells: { '/repo/a': asSessionId('parked') },
      sessions: [session({ sessionId: 'parked', status: 'hibernated' })],
      trpc: { sessions: { setArchived: { mutate } } },
    }

    render(createElement(DockShellLifecycle))
    // Let the effect run; a parked shell must never be archived.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mutate).not.toHaveBeenCalled()
  })
})
