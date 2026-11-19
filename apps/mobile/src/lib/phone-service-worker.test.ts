import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PHONE_SERVICE_WORKER_SCOPE,
  PHONE_SERVICE_WORKER_URL,
  type PhoneServiceWorkerEnv,
  refreshPhoneBuild,
  registerPhoneServiceWorker,
  resetPhoneServiceWorkerForTests,
} from './phone-service-worker'

type Listener = () => void

function events() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    addEventListener: vi.fn((type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(type, set)
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener)
    }),
    dispatch(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
  }
}

function worker(state: ServiceWorkerState) {
  const target = events()
  const value = {
    ...target,
    state,
    scriptURL: 'https://podium.example/mobile/sw.js',
    postMessage: vi.fn(),
    become(next: ServiceWorkerState) {
      value.state = next
      target.dispatch('statechange')
    },
  }
  return value
}

type FakeWorker = ReturnType<typeof worker>

function registration(slots: { active?: FakeWorker; waiting?: FakeWorker } = {}) {
  const target = events()
  return {
    ...target,
    scope: 'https://podium.example/mobile',
    active: slots.active ?? null,
    waiting: slots.waiting ?? null,
    installing: null as FakeWorker | null,
    update: vi.fn(async () => undefined),
    unregister: vi.fn(async () => true),
  }
}

function container(controller: FakeWorker | null, reg: ReturnType<typeof registration>) {
  const target = events()
  return {
    ...target,
    controller,
    register: vi.fn(async () => reg),
    getRegistration: vi.fn(async () => reg),
  }
}

function env(
  serviceWorker: ReturnType<typeof container> | undefined,
  overrides: Partial<PhoneServiceWorkerEnv> = {},
): PhoneServiceWorkerEnv & { location: { pathname: string; reload: ReturnType<typeof vi.fn> } } {
  return {
    container: serviceWorker as unknown as PhoneServiceWorkerEnv['container'],
    location: { pathname: '/mobile/work', reload: vi.fn() },
    dev: false,
    whenLoaded: (run) => run(),
    ...overrides,
  } as PhoneServiceWorkerEnv & { location: { pathname: string; reload: ReturnType<typeof vi.fn> } }
}

afterEach(() => {
  resetPhoneServiceWorkerForTests()
  vi.useRealTimers()
})

describe('registerPhoneServiceWorker', () => {
  it('registers /mobile/sw.js for the /mobile scope, revalidating the script every time', async () => {
    const reg = registration()
    const sw = container(null, reg)
    expect(await registerPhoneServiceWorker(env(sw))).toBe(reg)
    expect(sw.register).toHaveBeenCalledWith(PHONE_SERVICE_WORKER_URL, {
      scope: PHONE_SERVICE_WORKER_SCOPE,
      updateViaCache: 'none',
    })
  })

  it('registers nothing in a development build, off the phone path, or without a container', async () => {
    const sw = container(null, registration())
    expect(await registerPhoneServiceWorker(env(sw, { dev: true }))).toBeUndefined()
    resetPhoneServiceWorkerForTests()
    const elsewhere = env(sw)
    elsewhere.location.pathname = '/harness.html'
    expect(await registerPhoneServiceWorker(elsewhere)).toBeUndefined()
    resetPhoneServiceWorkerForTests()
    expect(await registerPhoneServiceWorker(env(undefined))).toBeUndefined()
    expect(sw.register).not.toHaveBeenCalled()
  })

  it('a failed registration resolves to nothing rather than throwing into the app', async () => {
    const sw = container(null, registration())
    sw.register.mockRejectedValueOnce(new Error('Script load failed'))
    expect(await registerPhoneServiceWorker(env(sw))).toBeUndefined()
  })

  it('reloads once when a new worker takes over a page an older one served', async () => {
    const sw = container(worker('activated'), registration())
    const page = env(sw)
    await registerPhoneServiceWorker(page)
    sw.dispatch('controllerchange')
    sw.dispatch('controllerchange')
    expect(page.location.reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload when the first install claims an uncontrolled page', async () => {
    const sw = container(null, registration())
    const page = env(sw)
    await registerPhoneServiceWorker(page)
    sw.dispatch('controllerchange')
    expect(page.location.reload).not.toHaveBeenCalled()
  })
})

describe('refreshPhoneBuild', () => {
  it('reloads a page no worker can serve', async () => {
    const page = env(undefined)
    await refreshPhoneBuild(page)
    expect(page.location.reload).toHaveBeenCalledTimes(1)
  })

  it('hands over to the waiting build, then reloads once, with the takeover listener too', async () => {
    const active = worker('activated')
    const waiting = worker('installed')
    const reg = registration({ active, waiting })
    const sw = container(active, reg)
    const page = env(sw)
    await registerPhoneServiceWorker(page)
    const result = refreshPhoneBuild(page)
    await vi.waitFor(() =>
      expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }),
    )
    expect(page.location.reload).not.toHaveBeenCalled()
    waiting.become('activated')
    sw.controller = waiting
    sw.dispatch('controllerchange')
    expect((await result)?.outcome).toBe('reloading')
    expect(page.location.reload).toHaveBeenCalledTimes(1)
  })

  it('with no replacement to hand over to, unregisters and reloads from the network', async () => {
    const active = worker('activated')
    const reg = registration({ active })
    const sw = container(active, reg)
    const page = env(sw)
    await registerPhoneServiceWorker(page)
    expect((await refreshPhoneBuild(page))?.outcome).toBe('reloading')
    expect(reg.unregister).toHaveBeenCalledTimes(1)
    expect(page.location.reload).toHaveBeenCalledTimes(1)
  })
})
