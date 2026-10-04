// @vitest-environment happy-dom

import { withKeyedInputs } from '@podium/client-core/engine'
import type { MobxPool } from '@podium/client-graph'
import { asSessionId, type SessionMeta } from '@podium/model'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ value: {} as Record<string, unknown>, reads: [] as string[] }))
vi.mock('@/app/store', () => ({
  useStoreSelector: () => {
    throw new Error('Dock lifecycle read the old store')
  },
}))
const owner = withKeyedInputs({ getSnapshot: () => store.value, subscribe: () => () => {} })
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => owner }))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPoolProjection: <T>(read: (pool: MobxPool) => T) =>
    read({
      queries: { collapsed: () => false, orderKey: (id: string) => id },
      row: (_entity: string, id: string) => {
        store.reads.push(id)
        return (store.value.sessions as SessionMeta[]).find((row) => row.sessionId === id)
      },
    } as unknown as MobxPool),
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

afterEach(() => {
  cleanup()
  store.reads.length = 0
})

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

  it('reads only mapped pool rows and archives each stale identity once until it leaves the stale set', async () => {
    const mutate = vi.fn(async () => undefined)
    const parked = session({ sessionId: 'parked', status: 'hibernated' })
    const dead = session({ sessionId: 'dead', status: 'exited' })
    store.value = {
      dockShells: {
        '/repo/a': dead.sessionId,
        '/repo/duplicate': dead.sessionId,
        '/repo/b': parked.sessionId,
      },
      sessions: [session({ sessionId: 'unmapped', status: 'exited' }), dead, parked],
      trpc: { sessions: { setArchived: { mutate } } },
    }
    const view = render(createElement(DockShellLifecycle))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(mutate).toHaveBeenCalledWith({ sessionId: dead.sessionId, archived: true })
    expect(new Set(store.reads)).toEqual(new Set(['dead', 'parked']))
    view.rerender(createElement(DockShellLifecycle))
    expect(mutate).toHaveBeenCalledTimes(1)
    store.value.sessions = [parked, { ...dead, archived: true }]
    view.rerender(createElement(DockShellLifecycle))
    store.value.sessions = [parked, dead]
    view.rerender(createElement(DockShellLifecycle))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
  })
})
