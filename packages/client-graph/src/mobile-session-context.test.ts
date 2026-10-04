import type { ClientRuntime } from '@podium/client-core/engine'
import { asSessionId } from '@podium/model'
import { autorun, observable } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createMobileSessionReader, createMobileSessionSource } from './mobile-session-context'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

it('demands only the declared borrowed window, coalesces loading, and tears down the existing owner subscriptions', async () => {
  const addressed = new Set<() => void>()
  let cursor: number | null = null
  const readLocal = vi.fn(() => { throw new Error('The cursor source must not read runtime locals') })
  const getCursor = vi.fn(() => cursor)
  const owner = {
    readLocal,
    onLocals: () => { throw new Error('Spawn prompts belong to the pool log') },
    replica: {
      getCursor,
      subscribeCursor: (fn: () => void) => {
        addressed.add(fn)
        return () => {
          addressed.delete(fn)
        }
      },
    },
  } as unknown as ClientRuntime
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const source = createMobileSessionSource(owner, pool)
  expect(readLocal).not.toHaveBeenCalled()
  expect(source.read('mobileSessionReader')).toBeTypeOf('object')
  expect(source.read('mobileSessionWindow')).toBe(LOADING)
  expect(source.read('mobileSessionWindow')).toBe(LOADING)
  await Promise.resolve()
  expect(readLocal).not.toHaveBeenCalled()
  expect(getCursor).toHaveBeenCalledTimes(1)
  expect(source.read('mobileSessionWindow')).toEqual({ cursor: null })
  // The cursor alone moves on its own signal (POD-5433). Watched, not read:
  // a read schedules its own refresh.
  let seen: unknown
  const stopWatch = autorun(() => {
    seen = source.read('mobileSessionWindow')
  })
  await Promise.resolve()
  cursor = 27
  for (const fn of addressed) fn()
  await Promise.resolve()
  expect(seen).toEqual({ cursor: 27 })
  stopWatch()
  source.dispose()
  source.dispose()
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
  pool.attachTransactions({ mutate: vi.fn(), spawnPrompts: observable.map([['provisional', null]]) } as never)
  pool.sources.register(['sessionPaneWindow'], {
    read: () => ({
      panelMode: {},
      dockShells: {},
      reposLoaded: false,
    }),
    dispose() {},
  })
  expect(reader.spawnPending('provisional')).toBe(true)
  expect(reader.spawnPending('confirmed')).toBe(false)
  pool.sources.register(['mobileSessionWindow'], {
    read: () => ({ cursor: null }),
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

it('answers spawn prompts from the pool log while it owns sessions (POD-5432)', () => {
  for (const ownsSessions of [true, false]) {
    const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null }),
      reader = createMobileSessionReader(pool)
    const spawnPrompts = observable.map<string, string | null>([
      ['from-log', 'Log prompt'],
      ['no-prompt', null],
    ])
    pool.attachTransactions({ mutate: vi.fn(), spawnPrompts } as never, ownsSessions)
    pool.sources.register(['mobileSessionWindow'], {
      read: () => ({ cursor: null }),
      dispose: () => {},
    } as never)
    expect(reader.spawnPrompt('from-log')).toBe(ownsSessions ? 'Log prompt' : undefined)
    expect(reader.spawnPrompt('no-prompt')).toBeUndefined()
    expect(reader.spawnPrompt('absent')).toBeUndefined()
    pool.dispose()
  }
})
