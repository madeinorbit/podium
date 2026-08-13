import type { LogsCrashInput, LogsForwardInput } from '@podium/commands'
import { addSink, clearSinks, createLogger, type LogRecord, resetLogging } from '@podium/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appVersion,
  type CaptureScope,
  createFetchLogTransport,
  installGlobalErrorCapture,
  installMobileLogging,
  mobileLogging,
} from './logging'

afterEach(() => {
  mobileLogging()?.dispose()
  clearSinks()
  resetLogging()
})

function handlerSpies() {
  return { onUncaught: vi.fn(), onUnhandledRejection: vi.fn() }
}

/** An ErrorUtils stand-in that hands the installed handler back to the test. */
function errorUtilsScope(previous?: (error: unknown, isFatal?: boolean) => void) {
  let current = previous
  const scope: CaptureScope = {
    ErrorUtils: {
      setGlobalHandler: (handler) => {
        current = handler
      },
      getGlobalHandler: () => current,
    },
  }
  return { scope, fire: (error: unknown, isFatal?: boolean) => current?.(error, isFatal) }
}

/** A Hermes stand-in that hands the tracker's two callbacks back to the test. */
function hermesScope() {
  let unhandled: ((id: number, reason: unknown) => void) | undefined
  let handled: ((id: number) => void) | undefined
  const scope: CaptureScope & {
    unhandled(id: number, reason: unknown): void
    handled(id: number): void
  } = {
    HermesInternal: {
      enablePromiseRejectionTracker: (opts) => {
        expect(opts.allRejections).toBe(true)
        unhandled = opts.onUnhandled
        handled = opts.onHandled
      },
    },
    unhandled: (id, reason) => unhandled?.(id, reason),
    handled: (id) => handled?.(id),
  }
  return scope
}

describe('installGlobalErrorCapture', () => {
  it('routes an uncaught error through the logger AND still calls the previous handler', () => {
    // The chain is the property under test: React Native's own handler is what
    // shows the red box and reports the fatal. Replacing it would trade a
    // visible crash for a logged one.
    const previous = vi.fn()
    const { scope, fire } = errorUtilsScope(previous)
    const handlers = handlerSpies()
    const installed = installGlobalErrorCapture(scope, handlers)
    expect(installed.uncaught).toBe(true)

    const boom = new Error('boom')
    fire(boom, true)
    expect(handlers.onUncaught).toHaveBeenCalledWith(boom, true)
    expect(previous).toHaveBeenCalledWith(boom, true)
  })

  it('records the error BEFORE handing on to a handler that may end the process', () => {
    const order: string[] = []
    const { scope, fire } = errorUtilsScope(() => order.push('previous'))
    installGlobalErrorCapture(scope, {
      onUncaught: () => order.push('captured'),
      onUnhandledRejection: () => undefined,
    })
    fire(new Error('x'), true)
    expect(order).toEqual(['captured', 'previous'])
  })

  it('a throwing capture cannot swallow the app’s own error handling', () => {
    const previous = vi.fn()
    const { scope, fire } = errorUtilsScope(previous)
    installGlobalErrorCapture(scope, {
      onUncaught: () => {
        throw new Error('the reporter itself failed')
      },
      onUnhandledRejection: () => undefined,
    })
    expect(() => fire(new Error('app error'), true)).not.toThrow()
    expect(previous).toHaveBeenCalled()
  })

  it('uses the unhandledrejection EVENT when the build has one', () => {
    const listeners = new Map<string, (event: unknown) => void>()
    const scope: CaptureScope = {
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type) => listeners.delete(type),
    }
    const handlers = handlerSpies()
    const installed = installGlobalErrorCapture(scope, handlers)
    expect(installed.rejection).toBe('event-target')

    const reason = new Error('rejected')
    listeners.get('unhandledrejection')?.({ reason })
    expect(handlers.onUnhandledRejection).toHaveBeenCalledWith(reason)

    installed.uninstall()
    expect(listeners.has('unhandledrejection')).toBe(false)
  })

  it('falls back to Hermes’ rejection tracker on a build with no event target', () => {
    // Bare Hermes has no `unhandledrejection` event at all. Without this branch
    // a released iOS/Android build captures no rejections and nothing says so.
    vi.useFakeTimers()
    const scope = hermesScope()
    const handlers = handlerSpies()
    const installed = installGlobalErrorCapture(scope, handlers, { rejectionGraceMs: 10 })
    expect(installed.rejection).toBe('hermes')

    const reason = new Error('hermes rejection')
    scope.unhandled(1, reason)
    vi.advanceTimersByTime(10)
    expect(handlers.onUnhandledRejection).toHaveBeenCalledWith(reason)
    vi.useRealTimers()
  })

  it('does not file a crash for a rejection that is handled a tick late', () => {
    // `allRejections: true` reports every rejection, including ones handled
    // later — `const p = work(); …; await p` is the ordinary shape. A crash
    // report cannot be retracted once posted, and ten of them exhaust the
    // reporter's per-session budget on things that were never crashes.
    vi.useFakeTimers()
    const scope = hermesScope()
    const handlers = handlerSpies()
    installGlobalErrorCapture(scope, handlers, { rejectionGraceMs: 10 })

    scope.unhandled(7, new Error('awaited one tick later'))
    vi.advanceTimersByTime(5)
    scope.handled(7)
    vi.advanceTimersByTime(100)

    expect(handlers.onUnhandledRejection).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('prefers Hermes’ tracker over an addEventListener that may never fire', () => {
    // An event-target polyfill from any dependency accepts the listener and then
    // never dispatches `unhandledrejection` on a Hermes build — capture silently
    // off, while the boot line reported `event-target` and looked healthy.
    vi.useFakeTimers()
    const scope = hermesScope()
    let listenerAdded = false
    scope.addEventListener = () => {
      listenerAdded = true
    }
    const handlers = handlerSpies()
    const installed = installGlobalErrorCapture(scope, handlers, { rejectionGraceMs: 10 })

    expect(installed.rejection).toBe('hermes')
    expect(listenerAdded).toBe(false)
    scope.unhandled(1, new Error('still captured'))
    vi.advanceTimersByTime(10)
    expect(handlers.onUnhandledRejection).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('drops a held rejection report on uninstall rather than firing it later', () => {
    vi.useFakeTimers()
    const scope = hermesScope()
    const handlers = handlerSpies()
    const installed = installGlobalErrorCapture(scope, handlers, { rejectionGraceMs: 10 })

    scope.unhandled(3, new Error('in flight when the app tore logging down'))
    installed.uninstall()
    vi.advanceTimersByTime(100)

    expect(handlers.onUnhandledRejection).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('reports "none" rather than pretending, when neither surface exists', () => {
    const installed = installGlobalErrorCapture({}, handlerSpies())
    expect(installed).toMatchObject({ rejection: 'none', uncaught: false })
  })
})

describe('createFetchLogTransport', () => {
  it('posts the tRPC input verbatim with the session cookie', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch
    const transport = createFetchLogTransport({
      httpOrigin: () => 'http://127.0.0.1:18787',
      fetchImpl,
    })

    const batch: LogsForwardInput = {
      origin: { role: 'mobile', v: '1.2.3' },
      records: [{ ts: '2026-08-11T14:03:22.847Z', level: 'warn', ns: 'mobile:x', msg: 'hi' }],
    }
    await transport.forward(batch)
    expect(calls[0]?.url).toBe('http://127.0.0.1:18787/trpc/logs.forward')
    expect(calls[0]?.init.credentials).toBe('include')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(batch)
  })

  it('rejects on a non-2xx so the sink keeps the records and retries', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch
    const transport = createFetchLogTransport({ httpOrigin: () => 'http://h', fetchImpl })
    const crash: LogsCrashInput = {
      origin: { role: 'mobile' },
      err: { name: 'E', message: 'm' },
      snapshot: [],
    }
    await expect(transport.crash(crash)).rejects.toThrow('503')
  })

  it('attaches the current native bearer without putting it in the URL', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200 }) as Response,
    )
    const transport = createFetchLogTransport({
      httpOrigin: () => 'https://podium.example',
      bearer: () => 'mobile-secret',
      credentials: 'omit',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.forward({ origin: { role: 'mobile' }, records: [] })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://podium.example/trpc/logs.forward')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer mobile-secret')
    expect(init?.credentials).toBe('omit')
  })

  it('rejects rather than posting nowhere when no server is paired yet', async () => {
    const fetchImpl = vi.fn()
    const transport = createFetchLogTransport({
      httpOrigin: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(transport.forward({ origin: { role: 'mobile' }, records: [] })).rejects.toThrow(
      'no server origin',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('installMobileLogging', () => {
  function collectingTransport() {
    const forwarded: LogsForwardInput[] = []
    const crashes: LogsCrashInput[] = []
    return {
      forwarded,
      crashes,
      transport: {
        forward: async (input: LogsForwardInput) => {
          forwarded.push(input)
        },
        crash: async (input: LogsCrashInput) => {
          crashes.push(input)
        },
      },
    }
  }

  it('files the phone under role mobile and ships a crash carrying the ring buffer', async () => {
    const { crashes, transport } = collectingTransport()
    const { scope, fire } = errorUtilsScope()
    installMobileLogging({ transport, scope, version: '9.9.9', platform: 'ios', console: false })

    // Below the forwarding threshold, and that is the point: the ring buffer
    // keeps it anyway, so the crash report carries the context nobody would
    // have chosen to forward.
    createLogger('mobile:test').debug('the thing that happened first', { step: 1 })

    fire(new Error('fatal'), true)
    await Promise.resolve()
    await Promise.resolve()

    expect(crashes).toHaveLength(1)
    const report = crashes[0]
    expect(report?.origin).toMatchObject({ role: 'mobile', v: '9.9.9' })
    expect(report?.err).toMatchObject({ name: 'Error', message: 'fatal' })
    expect(report?.context).toMatchObject({ source: 'ErrorUtils', isFatal: true })
    const messages = report?.snapshot.map((r) => r.msg) ?? []
    expect(messages).toContain('the thing that happened first')
    // The crash is logged before the snapshot is taken, so the payload ends on it.
    expect(messages.at(-1)).toBe('fatal')
    // Process context rides on every record, so a forwarded line can be read
    // against the build that produced it.
    expect(report?.snapshot.at(-1)).toMatchObject({ role: 'mobile', v: '9.9.9', platform: 'ios' })
  })

  it('forwards warnings and NOT debug at the default level — one knob, not two', async () => {
    // The forwarding sink pins no threshold of its own; it follows the
    // namespace level that boot set to `warn`. This asserts both halves: what
    // the default excludes, and that raising the ONE knob includes it.
    const { forwarded, transport } = collectingTransport()
    const logging = installMobileLogging({
      transport,
      scope: {},
      console: false,
      batchSize: 1,
    })
    const log = createLogger('mobile:test')
    log.debug('not forwarded at warn')
    log.warn('forwarded')
    await logging.flush()

    const messages = forwarded.flatMap((batch) => batch.records.map((r) => r.msg))
    expect(messages).toContain('forwarded')
    expect(messages).not.toContain('not forwarded at warn')
  })

  it('raising the single level knob raises the forwarded stream with it', async () => {
    const { forwarded, transport } = collectingTransport()
    const logging = installMobileLogging({
      transport,
      scope: {},
      console: false,
      batchSize: 1,
      level: 'debug',
    })
    createLogger('mobile:test').debug('now forwarded')
    await logging.flush()
    expect(forwarded.flatMap((b) => b.records.map((r) => r.msg))).toContain('now forwarded')
  })

  it('keeps the boot line out of the forwarded stream and inside the crash snapshot', async () => {
    // The boot line is `info` under the `warn` default, so at the real boot
    // level it is RING-ONLY — by design, and this is the assertion that says so
    // rather than a comment. It costs nothing per launch and is there in the one
    // payload that answers "was capture even installed when this died?".
    const { forwarded, crashes, transport } = collectingTransport()
    const { scope, fire } = errorUtilsScope()
    const logging = installMobileLogging({ transport, scope, console: false, batchSize: 1 })

    fire(new Error('died'), true)
    await Promise.resolve()
    await Promise.resolve()
    await logging.flush()

    expect(forwarded.flatMap((b) => b.records.map((r) => r.msg))).not.toContain(
      'log capture installed',
    )
    expect(crashes[0]?.snapshot.map((r) => r.msg)).toContain('log capture installed')
  })

  it('records the capture surfaces it actually installed', () => {
    // A crash that never arrived is indistinguishable from a handler that was
    // never installed, unless the boot line says which surfaces exist.
    const captured: LogRecord[] = []
    addSink({
      name: 'capture',
      write: (record) => {
        captured.push(record)
      },
    })
    const { transport } = collectingTransport()
    const { scope } = errorUtilsScope()
    installMobileLogging({ transport, scope, console: false, level: 'info' })
    const boot = captured.find((r) => r.msg === 'log capture installed')
    expect(boot).toMatchObject({
      ns: 'mobile:boot',
      rejectionCapture: 'none',
      uncaughtCapture: true,
    })
  })

  it('is idempotent — a second call does not stack a second set of handlers', () => {
    let installs = 0
    const scope: CaptureScope = {
      ErrorUtils: {
        setGlobalHandler: () => {
          installs += 1
        },
      },
    }
    const { transport } = collectingTransport()
    const first = installMobileLogging({ transport, scope, console: false })
    const second = installMobileLogging({ transport, scope, console: false })
    expect(second).toBe(first)
    expect(installs).toBe(1)
  })
})

describe('appVersion', () => {
  it('says dev rather than inventing a version', () => {
    // EXPO_PUBLIC_APP_VERSION is a build-time inline; unset in a test run.
    expect(appVersion()).toBe('dev')
  })
})
