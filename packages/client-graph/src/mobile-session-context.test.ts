import type { ClientRuntime } from '@podium/client-core/engine'
import { asSessionId } from '@podium/model'
import { expect, it, vi } from 'vitest'
import { createMobileSessionReader, createMobileSessionSource } from './mobile-session-context'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

it('demands only the declared borrowed window, coalesces loading, and tears down the existing owner subscriptions', async () => {
  const listeners = new Set<() => void>(),
    addressed = new Set<() => void>()
  let prompts = new Map([[asSessionId('pending'), 'First prompt']]),
    cursor: number | null = null
  const getSnapshot = vi.fn(
    () =>
      new Proxy(
        { pendingSpawnPrompts: prompts },
        {
          get(target, key) {
            if (key !== 'pendingSpawnPrompts') throw new Error(`Legacy field ${String(key)}`)
            return target.pendingSpawnPrompts
          },
        },
      ),
  )
  const getCursor = vi.fn(() => cursor)
  const owner = {
    getSnapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    replica: {
      getCursor,
      subscribeAddressedBatch: (fn: () => void) => {
        addressed.add(fn)
        return () => {
          addressed.delete(fn)
        }
      },
    },
  } as unknown as ClientRuntime
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const source = createMobileSessionSource(owner, pool)
  expect(getSnapshot).not.toHaveBeenCalled()
  expect(source.read('mobileSessionReader')).toBeTypeOf('object')
  expect(source.read('mobileSessionWindow')).toBe(LOADING)
  expect(source.read('mobileSessionWindow')).toBe(LOADING)
  await Promise.resolve()
  expect(source.counts.batches).toBe(1)
  expect(getSnapshot).toHaveBeenCalledTimes(1)
  expect(getCursor).toHaveBeenCalledTimes(1)
  expect(source.read('mobileSessionWindow')).toEqual({ cursor: null, pendingSpawnPrompts: prompts })
  prompts = new Map()
  cursor = 27
  for (const fn of listeners) fn()
  for (const fn of addressed) fn()
  await Promise.resolve()
  expect(source.read('mobileSessionWindow')).toEqual({ cursor: 27, pendingSpawnPrompts: prompts })
  source.dispose()
  source.dispose()
  expect(listeners.size).toBe(0)
  expect(addressed.size).toBe(0)
  expect(source.read('mobileSessionWindow')).toBe(LOADING)
  pool.dispose()
})

it('keeps spawn confirmation loading until the shared pane source is attached and answers undefined routes without demand', () => {
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null }),
    reader = createMobileSessionReader(pool)
  expect(reader.spawnPending(undefined)).toBe(false)
  expect(reader.spawnPrompt(undefined)).toBeUndefined()
  expect(reader.session(undefined)).toBeUndefined()
  expect(reader.issue(undefined)).toBeUndefined()
  expect(reader.exit(undefined)).toBeUndefined()
  expect(reader.spawnPending('not-attached')).toBe(LOADING)
  expect(reader.booting()).toBe(true)
  pool.sources.register(['sessionPaneWindow'], {
    read: () => ({
      pendingSpawnIds: new Set([asSessionId('provisional')]),
      panelMode: {},
      dockShells: {},
      reposLoaded: false,
    }),
    dispose() {},
  })
  expect(reader.spawnPending('provisional')).toBe(true)
  expect(reader.spawnPending('confirmed')).toBe(false)
  pool.sources.register(['mobileSessionWindow'], {
    read: () => ({ cursor: null, pendingSpawnPrompts: new Map() }),
    dispose() {},
  })
  pool.sources.register(['chatSessionOrder', 'chatIssueOrder'], {
    read: () => ({ ids: [] }),
    dispose() {},
  })
  expect(reader.booting()).toBe(true)
  // The first provisional row can arrive before the replica cursor or order.
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'session',
        id: 'provisional',
        value: {
          sessionId: 'provisional',
          agentKind: 'codex',
          status: 'starting',
          archived: false,
          cwd: '/synthetic/project',
          lastActiveAt: '2026-10-03T00:00:00Z',
        } as never,
      },
    ],
  })
  expect(reader.booting()).toBe(false)
  pool.dispose()
})
