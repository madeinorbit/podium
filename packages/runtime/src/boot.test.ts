import { describe, expect, it, vi } from 'vitest'
import { type BootHandle, type BootProc, bootProcess } from './boot'

/** Spy seam: captures signal handlers, never touches the real process. */
function makeProc() {
  const handlers = new Map<string, () => void>()
  const stopWatchdog = vi.fn()
  const stopSupervisorWatch = vi.fn()
  /** Captured so a test can fire supervisor death without a real parent process. */
  let orphan: (() => void) | undefined
  // A fake sink handle. The real one registers a file sink under ~/.podium/logs;
  // a unit test must not write there, which is why configureLogging is a seam.
  const logging = {
    mode: 'detached' as const,
    sink: { name: 'fake', write: vi.fn() },
    destination: '/tmp/fake/server.ndjson',
    flush: vi.fn(async () => {}),
    close: vi.fn(),
  }
  const proc: BootProc = {
    exit: vi.fn(),
    onSignal: (signal, handler) => {
      handlers.set(signal, handler)
    },
    configureLogging: vi.fn(() => logging),
    installSafetyNet: vi.fn(),
    startWatchdog: vi.fn(() => stopWatchdog),
    watchSupervisor: vi.fn((onOrphaned: () => void) => {
      orphan = onOrphaned
      return stopSupervisorWatch
    }),
    log: vi.fn(),
    error: vi.fn(),
    // Resolves immediately so bootProcess returns in tests (prod never resolves).
    stayAlive: () => Promise.resolve(),
  }
  return {
    proc,
    handlers,
    stopWatchdog,
    stopSupervisorWatch,
    logging,
    orphanProcess: () => orphan?.(),
  }
}

describe('bootProcess', () => {
  it('boot watchdog fires when start never resolves: logs the message and exits 1', async () => {
    const { proc } = makeProc()
    void bootProcess(
      { name: 'daemon', bootTimeoutMs: 10, start: () => new Promise<BootHandle>(() => {}) },
      proc,
    )
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(1))
    expect(proc.error).toHaveBeenCalledWith(
      'boot did not complete in time (host memory pressure?) — exiting for systemd to retry',
      { role: 'daemon', bootTimeoutMs: 10 },
    )
  })

  it('successful start clears the boot watchdog, installs the crash net, pets systemd, logs ready', async () => {
    const { proc } = makeProc()
    await bootProcess(
      {
        name: 'server',
        bootTimeoutMs: 10,
        start: async () => ({ port: 1234, close: () => {} }),
        readyMessage: (h) => `up on ${h.port}`,
      },
      proc,
    )
    // Wait past the boot timeout: a cleared watchdog must never fire.
    await new Promise((r) => setTimeout(r, 40))
    expect(proc.exit).not.toHaveBeenCalled()
    expect(proc.installSafetyNet).toHaveBeenCalledWith('server')
    expect(proc.startWatchdog).toHaveBeenCalledTimes(1)
    expect(proc.log).toHaveBeenCalledWith('up on 1234', {
      role: 'server',
      logs: '/tmp/fake/server.ndjson',
    })
  })

  it('registers the log sink BEFORE the crash net, so a survived crash has somewhere to go', async () => {
    const { proc } = makeProc()
    const order: string[] = []
    vi.mocked(proc.configureLogging).mockImplementation(() => {
      order.push('logging')
      return undefined
    })
    vi.mocked(proc.installSafetyNet).mockImplementation(() => {
      order.push('safety-net')
    })
    await bootProcess(
      { name: 'server', bootTimeoutMs: null, start: async () => ({ close: () => {} }) },
      proc,
    )
    expect(proc.configureLogging).toHaveBeenCalledWith('server')
    expect(order).toEqual(['logging', 'safety-net'])
  })

  it('logging: false opts out, and the shutdown drain tolerates having no handle', async () => {
    const { proc, handlers } = makeProc()
    await bootProcess(
      {
        name: 'host',
        logging: false,
        bootTimeoutMs: null,
        start: async () => ({ close: () => {} }),
      },
      proc,
    )
    expect(proc.configureLogging).not.toHaveBeenCalled()
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
  })

  it('drains the log sink on shutdown, after close() and before exit', async () => {
    const { proc, handlers, logging } = makeProc()
    const closed: string[] = []
    await bootProcess(
      {
        name: 'server',
        bootTimeoutMs: null,
        start: async () => ({
          close: () => {
            closed.push('handle')
          },
        }),
      },
      proc,
    )
    vi.mocked(proc.exit).mockImplementation(() => {
      closed.push('exit')
    })
    logging.flush.mockImplementation(async () => {
      closed.push('flush')
    })
    logging.close.mockImplementation(async () => {
      closed.push('close')
    })
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
    // The last records of a clean shutdown must be durable before the process
    // goes away — and the handle's own close() has to have run first, so
    // anything it logged is included.
    expect(closed).toEqual(['handle', 'flush', 'close', 'exit'])
  })

  it('a sink that cannot be drained still exits 0 — logging never blocks a SIGTERM', async () => {
    const { proc, handlers, logging } = makeProc()
    logging.flush.mockRejectedValue(new Error('disk gone'))
    logging.close.mockImplementation(() => {
      throw new Error('fd gone')
    })
    await bootProcess(
      { name: 'server', bootTimeoutMs: null, start: async () => ({ close: () => {} }) },
      proc,
    )
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
  })

  it('shutdown is bounded: a close() that never resolves still exits 0 within closeTimeoutMs', async () => {
    const { proc, handlers, stopWatchdog } = makeProc()
    await bootProcess(
      {
        name: 'daemon',
        bootTimeoutMs: null,
        closeTimeoutMs: 20,
        start: async () => ({ close: () => new Promise<void>(() => {}) }),
      },
      proc,
    )
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
    expect(stopWatchdog).toHaveBeenCalledTimes(1)
  })

  it('a dead supervisor shuts down exactly like a SIGTERM: close(), then exit 0', async () => {
    const { proc, stopWatchdog, stopSupervisorWatch, orphanProcess } = makeProc()
    const close = vi.fn()
    await bootProcess({ name: 'server', bootTimeoutMs: null, start: async () => ({ close }) }, proc)
    orphanProcess()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
    expect(close).toHaveBeenCalledTimes(1)
    expect(stopWatchdog).toHaveBeenCalledTimes(1)
    expect(stopSupervisorWatch).toHaveBeenCalledTimes(1)
  })

  it('supervisor death and a SIGTERM together shut down once, not twice', async () => {
    const { proc, handlers, orphanProcess } = makeProc()
    const close = vi.fn()
    await bootProcess({ name: 'server', bootTimeoutMs: null, start: async () => ({ close }) }, proc)
    orphanProcess()
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
    expect(close).toHaveBeenCalledTimes(1)
    expect(proc.exit).toHaveBeenCalledTimes(1)
  })

  it('shutdown is idempotent: a second signal neither re-closes nor re-exits', async () => {
    const { proc, handlers } = makeProc()
    const close = vi.fn()
    await bootProcess({ name: 'server', bootTimeoutMs: null, start: async () => ({ close }) }, proc)
    handlers.get('SIGINT')?.()
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
    expect(close).toHaveBeenCalledTimes(1)
    expect(proc.exit).toHaveBeenCalledTimes(1)
  })

  it('shutdown still exits 0 when close() rejects (exit lives in finally)', async () => {
    const { proc, handlers } = makeProc()
    await bootProcess(
      {
        name: 'server',
        bootTimeoutMs: null,
        start: async () => ({ close: () => Promise.reject(new Error('bind gone')) }),
      },
      proc,
    )
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
    expect(proc.error).toHaveBeenCalledWith('close() failed during shutdown', {
      role: 'server',
      err: expect.objectContaining({ message: 'bind gone' }),
    })
  })

  it('shutdown still exits 0 when close() throws synchronously', async () => {
    const { proc, handlers } = makeProc()
    await bootProcess(
      {
        name: 'server',
        bootTimeoutMs: null,
        start: async () => ({
          close: () => {
            throw new Error('sync boom')
          },
        }),
      },
      proc,
    )
    handlers.get('SIGINT')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
  })

  it('start() rejection exits 1, clears the boot watchdog, and never logs a late timeout', async () => {
    const { proc } = makeProc()
    await bootProcess(
      {
        name: 'daemon',
        bootTimeoutMs: 10,
        start: () => Promise.reject(new Error('no socket')),
      },
      proc,
    )
    expect(proc.exit).toHaveBeenCalledWith(1)
    // The error travels as a FIELD, not interpolated into the message: the
    // logger's serializer owns flattening it to {name, message, stack}.
    expect(proc.error).toHaveBeenCalledWith('boot failed', {
      role: 'daemon',
      err: expect.objectContaining({ message: 'no socket' }),
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(proc.error).not.toHaveBeenCalledWith(
      expect.stringContaining('did not complete'),
      expect.anything(),
    )
    expect(proc.exit).toHaveBeenCalledTimes(1)
  })

  it('boot timeout is terminal: a late-resolving start() must not reach readiness or exit 0', async () => {
    const { proc } = makeProc()
    let resolveStart: (h: BootHandle) => void = () => {}
    const done = bootProcess(
      {
        name: 'daemon',
        bootTimeoutMs: 10,
        start: () => new Promise<BootHandle>((r) => (resolveStart = r)),
        readyMessage: () => 'should never log',
      },
      proc,
    )
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(1))
    void done
    resolveStart({ close: () => {} })
    await new Promise((r) => setTimeout(r, 20))
    expect(proc.log).not.toHaveBeenCalled()
    expect(proc.exit).toHaveBeenCalledTimes(1)
    expect(proc.startWatchdog).not.toHaveBeenCalled()
  })

  it('safetyNet: false and watchdog: false opt out of the respective installs', async () => {
    const { proc } = makeProc()
    await bootProcess(
      {
        name: 'host',
        safetyNet: false,
        watchdog: false,
        bootTimeoutMs: null,
        start: async () => ({ close: () => {} }),
      },
      proc,
    )
    expect(proc.installSafetyNet).not.toHaveBeenCalled()
    expect(proc.startWatchdog).not.toHaveBeenCalled()
  })
})

describe('shutdown hardening (Codex round-2)', () => {
  it('a throwing stopWatchdog still closes and exits 0', async () => {
    const handlers = new Map<string, () => void>()
    const close = vi.fn()
    const proc: BootProc = {
      exit: vi.fn(),
      onSignal: (signal, handler) => {
        handlers.set(signal, handler)
      },
      configureLogging: vi.fn(() => undefined),
      installSafetyNet: vi.fn(),
      startWatchdog: vi.fn(() => () => {
        throw new Error('cleanup boom')
      }),
      watchSupervisor: vi.fn(() => undefined),
      log: vi.fn(),
      error: vi.fn(),
      stayAlive: () => Promise.resolve(),
    }
    await bootProcess({ name: 'server', bootTimeoutMs: null, start: async () => ({ close }) }, proc)
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
  })
})
