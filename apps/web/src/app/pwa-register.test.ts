import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { registeredOptions: captured } = await import('./pwa-register-virtual.vitest')
const { useRegisterSW } = await import('./pwa-register')

let logged: LogRecord[]

beforeEach(() => {
  resetLogging()
  logged = []
  setLogLevel('info')
  addSink({ name: 'capture', write: (record) => logged.push(record) })
  captured.current = undefined
  navigateReload.mockClear()
})

afterEach(() => {
  resetLogging()
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

  it('performs the navigation the library would have performed itself', () => {
    useRegisterSW()

    captured.current?.onNeedReload?.()

    expect(navigateReload).toHaveBeenCalledWith(
      'workbox-controlling',
      'a new worker took control of this page',
    )
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
