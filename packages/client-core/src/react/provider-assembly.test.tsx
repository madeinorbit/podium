// @vitest-environment happy-dom
/**
 * ONE RUNTIME PER ASSEMBLY (POD-6913).
 *
 * A replica assembly's outbox factory may be consumed once: two engines must
 * never drive one durable queue. StoreProvider builds its runtime during
 * render, and React may run a render whose hooks it then throws away
 * (StrictMode's double render, a mount that suspends or errors before it
 * commits). The second attempt starts with a fresh ref, so it must find the
 * runtime the first attempt built for the same assembly instead of consuming
 * the factory again.
 */
import { asUserId } from '@podium/model'
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { withKeyedInputs } from '../../test-support/keyed-inputs'
import { createSubscriptionStore } from '../../test-support/local-store'
import type { PodiumClientApi } from '../api'
import { asClientPrincipal } from '../principal'
import type { CreateEngineOutbox } from '../runtime-root/outbox/wiring'
import type { ServerOrigin } from '../runtime-root/types'
import type { ScreenState } from '../ui/state'
import { StoreProvider, useClientRuntime } from './provider'

const built = vi.hoisted(() => ({ runtimes: [] as unknown[] }))
vi.mock('../runtime-root/root', () => ({
  // As the real root does: the outbox factory is consumed while the runtime is built.
  createClientRuntime: (options: { createOutboxFn?: (callbacks: unknown) => unknown }) => {
    options.createOutboxFn?.({})
    const owner = { start: vi.fn(), stop: vi.fn(), dispose: vi.fn(), isDisposed: false }
    owner.dispose.mockImplementation(() => {
      owner.isDisposed = true
    })
    const runtime = withKeyedInputs(
      Object.assign(owner, createSubscriptionStore({} as ScreenState, undefined, owner)),
    )
    built.runtimes.push(runtime)
    return runtime
  },
}))
afterEach(() => {
  cleanup()
  built.runtimes = []
})

/** The kernel factory's contract: a second consumption throws. */
function oneShotOutbox(): CreateEngineOutbox & { consumed: number } {
  const create = Object.assign(
    () => {
      create.consumed++
      if (create.consumed > 1) {
        throw new Error('kernel engine Outbox factory may only be consumed once')
      }
      return {} as ReturnType<CreateEngineOutbox>
    },
    { consumed: 0 },
  )
  return create as unknown as CreateEngineOutbox & { consumed: number }
}

const api = {} as PodiumClientApi
const config: ServerOrigin = {
  httpOrigin: 'http://offline.invalid',
  wsClientUrl: 'ws://offline.invalid',
}
const alice = asClientPrincipal(asUserId('alice'))
const createReplicaFn = () => {
  throw new Error('fixture owns runtime')
}

function Probe({ seen }: { seen: unknown[] }) {
  seen.push(useClientRuntime())
  return null
}

it('builds one runtime for one assembly under StrictMode double render and effect replay', async () => {
  const outbox = oneShotOutbox()
  const seen: unknown[] = []
  render(
    <StrictMode>
      <StoreProvider
        principal={alice}
        config={config}
        api={api}
        networkEnabled={false}
        onFatalError={() => {}}
        createReplicaFn={createReplicaFn}
        createOutboxFn={outbox}
      >
        <Probe seen={seen} />
      </StoreProvider>
    </StrictMode>,
  )
  await act(async () => {})
  expect(outbox.consumed).toBe(1)
  expect(built.runtimes).toHaveLength(1)
  const [runtime] = built.runtimes as Array<{ isDisposed: boolean; start: () => void }>
  expect(new Set(seen)).toEqual(new Set([runtime]))
  // The StrictMode effect replay stopped and restarted it; it is still live.
  expect(runtime?.isDisposed).toBe(false)
})

it('releases an assembly runtime on a real unmount, and a remount needs a new assembly', async () => {
  const first = oneShotOutbox()
  const frame = (outbox: CreateEngineOutbox) => (
    <StoreProvider
      principal={alice}
      config={config}
      api={api}
      networkEnabled={false}
      onFatalError={() => {}}
      createReplicaFn={createReplicaFn}
      createOutboxFn={outbox}
    >
      <div />
    </StoreProvider>
  )
  const view = render(frame(first))
  view.unmount()
  await act(async () => {})
  const [released] = built.runtimes as Array<{ isDisposed: boolean }>
  expect(released?.isDisposed).toBe(true)
  const second = oneShotOutbox()
  render(frame(second))
  expect(first.consumed).toBe(1)
  expect(second.consumed).toBe(1)
  expect(built.runtimes).toHaveLength(2)
})
