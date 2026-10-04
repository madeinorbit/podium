import type { ClientRuntime } from '@podium/client-core/engine'
import { afterEach, expect, it, vi } from 'vitest'
import type { MobxPool } from '../pool'
import { createPoolHost, POOL_OWNED_KINDS } from './pool-host'
import type { PoolScreen, PoolScreenOptions } from './screens'

const graph = vi.hoisted(() => ({ log: [] as string[], pool: {} as object }))
vi.mock('../runtime-pool', () => ({
  createRuntimeWorklistPool: vi.fn((_runtime: object, options?: object) => {
    graph.log.push(`create ${JSON.stringify(options ?? null)}`)
    return { pool: graph.pool, dispose: () => graph.log.push('dispose') }
  }),
  createPoolProjection: vi.fn(),
}))
afterEach(() => {
  graph.log.length = 0
  vi.clearAllMocks()
})

const runtime = () => ({ ui: { get: () => null } }) as unknown as ClientRuntime
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function screen(name: string): PoolScreen {
  const { log } = graph
  return {
    prepare: () => {
      log.push(`prepare ${name}`)
      return () => log.push(`unprepare ${name}`)
    },
    options: () => ({ [name]: true }) as PoolScreenOptions,
    attach: async (_runtime, pool: MobxPool) => {
      log.push(`attach ${name} ${pool === graph.pool}`)
      return () => log.push(`detach ${name}`)
    },
  }
}
const start = () => {
  graph.log.push('start')
  return () => graph.log.push('stop start')
}

it('starts, prepares, creates with merged options, plugs in screens, and tears down in reverse', async () => {
  const host = createPoolHost({
    screens: [screen('header'), screen('preferences')],
    dev: false,
    start,
  })
  const detach = host.attach(runtime(), (error) => {
    throw error
  })
  await settle()
  expect(graph.log).toEqual([
    'start',
    'prepare header',
    'prepare preferences',
    'create {"owns":["issue","session"],"header":true,"preferences":true}',
    'attach header true',
    'attach preferences true',
  ])
  graph.log.length = 0
  detach()
  detach()
  expect(graph.log).toEqual([
    'stop start',
    'detach preferences',
    'detach header',
    'unprepare preferences',
    'unprepare header',
    'dispose',
  ])
})

it('a sign-out during the graph import builds no pool', async () => {
  const host = createPoolHost({ screens: [screen('header')], dev: false })
  host.attach(runtime(), (error) => {
    throw error
  })()
  await settle()
  expect(graph.log).toEqual(['prepare header', 'unprepare header'])
})

it('one pool per runtime: a user switch gets its own pool and the old one is disposed', async () => {
  const host = createPoolHost({ screens: [screen('header')], dev: false })
  const first = host.attach(runtime(), (error) => {
    throw error
  })
  await settle()
  first()
  const second = host.attach(runtime(), (error) => {
    throw error
  })
  await settle()
  second()
  expect(graph.log.filter((line) => line.startsWith('create') || line === 'dispose')).toEqual([
    'create {"owns":["issue","session"],"header":true}',
    'dispose',
    'create {"owns":["issue","session"],"header":true}',
    'dispose',
  ])
})

it('starts before reading ownership options; defaults to POOL_OWNED_KINDS and retains the revert path', async () => {
  for (const options of [undefined, () => ({ owns: [] }) as PoolScreenOptions]) {
    let started = false
    const host = createPoolHost({
      screens: [screen('header')],
      dev: false,
      start: () => {
        started = true
      },
      options: () => {
        expect(started).toBe(true)
        return options?.() ?? {}
      },
    })
    const stop = host.attach(runtime(), (error) => {
      throw error
    })
    await settle()
    stop()
  }
  expect(graph.log.filter((line) => line.startsWith('create'))).toEqual([
    `create {"owns":${JSON.stringify(POOL_OWNED_KINDS)},"header":true}`,
    'create {"owns":[],"header":true}',
  ])
})
