import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerReloadGuard,
  registerReloadPreparation,
  withReloadPreparation,
} from '@/lib/reload-preparation'

/**
 * THE WRAPPER AROUND vite-plugin-pwa, WHICH NOTHING ELSE TESTS (POD-3224).
 *
 * Every other suite mocks `@/app/pwa-register` wholesale, so the module that
 * turns the library's callbacks into forwarded lines had no coverage at all.
 * What matters here is not that it logs — it is that wrapping did not change
 * what the library does:
 *
 *  - a caller's own handlers still run, after the line;
 *  - `onNeedReload` performs the SAME navigation the library performs when the
 *    callback is absent (its `controlling` listener calls `location.reload()`),
 *    and defers to a caller that supplies its own.
 *
 * The virtual module is mocked rather than the wrapper, which is the whole
 * point: the code under test is the real one.
 */

const navigateReload = vi.fn()
vi.mock('@/lib/navigate', () => ({ navigateReload }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const { registeredOptions: captured } = await import('./pwa-register-virtual.vitest')
const { useRegisterSW } = await import('./pwa-register')
const { resetTakeoverForTests } = await import('@/lib/update-takeover')

let visibility: DocumentVisibilityState = 'hidden'

let logged: LogRecord[]

beforeEach(() => {
  resetLogging()
  logged = []
  setLogLevel('info')
  addSink({ name: 'capture', write: (record) => logged.push(record) })
  captured.current = undefined
  navigateReload.mockClear()
  vi.mocked(toast.error).mockClear()
  registerReloadPreparation(async () => {})
  resetTakeoverForTests()
  // Nobody is looking at the page unless a test says so (POD-7539).
  visibility = 'hidden'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  resetLogging()
  resetTakeoverForTests()
  Reflect.deleteProperty(document, 'visibilityState')
})

/** A registration the wrapper can describe and observe without a real browser. */
function registration(): ServiceWorkerRegistration {
  return {
    scope: 'https://podium.test/',
    active: null,
    installing: null,
    waiting: null,
    addEventListener: vi.fn(),
  } as unknown as ServiceWorkerRegistration
}

const messages = (): string[] => logged.map((record) => record.msg)

describe('the pwa-register wrapper', () => {
  it('records the registration outcome and still calls the app back', () => {
    const onRegisteredSW = vi.fn()
    useRegisterSW({ onRegisteredSW })
    const reg = registration()

    captured.current?.onRegisteredSW?.('/sw.js', reg)

    expect(messages()).toContain('service worker registered')
    expect(logged[0]).toMatchObject({ ns: 'web:sw', level: 'info', swUrl: '/sw.js' })
    expect(onRegisteredSW).toHaveBeenCalledWith('/sw.js', reg)
  })

  /**
   * The macOS desktop case: the container is present and the script will not
   * load. Before this the only trace was the browser's own bare rejection
   * landing in `web:crash` with no page, surface or scope attached.
   */
  it('records a registration that failed, at error, with the error', () => {
    const onRegisterError = vi.fn()
    useRegisterSW({ onRegisterError })
    const failure = new TypeError('Script https://podium.test/sw.js load failed')

    captured.current?.onRegisterError?.(failure)

    expect(logged[0]).toMatchObject({
      ns: 'web:sw',
      level: 'error',
      msg: 'service worker registration failed',
    })
    expect(onRegisterError).toHaveBeenCalledWith(failure)
  })

  it('performs the navigation the library would have performed itself after preserving local work', async () => {
    useRegisterSW()

    captured.current?.onNeedReload?.()
    await withReloadPreparation(vi.fn())

    expect(navigateReload).toHaveBeenCalledWith(
      'workbox-controlling',
      'a new worker took control of this page',
    )
  })

  it('pauses a hidden library reload without a toast when an editor cannot be preserved', async () => {
    const detach = registerReloadGuard(() => 'Save or discard the unsaved file before reloading.')
    useRegisterSW()
    try {
      captured.current?.onNeedReload?.()
      await vi.waitFor(() =>
        expect(messages()).toContain('reload paused to preserve local changes'),
      )
      expect(navigateReload).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
    } finally {
      detach()
    }
    captured.current?.onNeedReload?.()
    await withReloadPreparation(vi.fn())
    expect(navigateReload).toHaveBeenCalledOnce()
  })

  it('keeps an editor guard across a held reload and retries after saving on the next hide', async () => {
    visibility = 'visible'
    let unsaved = true
    const detach = registerReloadGuard(() => (unsaved ? 'Save the unsaved file.' : undefined))
    useRegisterSW()
    try {
      captured.current?.onNeedReload?.()
      expect(messages()).toContain(
        'a new build took control; the reload waits until this page is hidden',
      )
      expect(navigateReload).not.toHaveBeenCalled()

      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.waitFor(() =>
        expect(messages()).toContain('reload paused to preserve local changes'),
      )
      expect(navigateReload).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()

      visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
      unsaved = false
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.waitFor(() => expect(navigateReload).toHaveBeenCalledOnce())
    } finally {
      detach()
    }
  })

  it('keeps a visible signed-in screen until the page is hidden (POD-7539)', async () => {
    visibility = 'visible'
    useRegisterSW()

    captured.current?.onNeedReload?.()
    await Promise.resolve()
    expect(navigateReload).not.toHaveBeenCalled()

    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(navigateReload).toHaveBeenCalledOnce())
    expect(navigateReload.mock.calls[0]?.[0]).toBe('workbox-controlling')
  })

  it('defers to a caller that supplies its own onNeedReload, and navigates nothing', () => {
    const onNeedReload = vi.fn()
    useRegisterSW({ onNeedReload })

    captured.current?.onNeedReload?.()

    expect(onNeedReload).toHaveBeenCalledOnce()
    expect(navigateReload).not.toHaveBeenCalled()
  })

  it('records the needRefresh latch and the offline-ready first install apart', () => {
    const onNeedRefresh = vi.fn()
    useRegisterSW({ onNeedRefresh })

    captured.current?.onNeedRefresh?.()
    captured.current?.onOfflineReady?.()

    expect(messages()).toEqual([
      'the library reported a new build is ready',
      'service worker precached this build for offline use',
    ])
    expect(onNeedRefresh).toHaveBeenCalledOnce()
  })
})
