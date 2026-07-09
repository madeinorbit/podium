import { describe, expect, it, vi } from 'vitest'
import { type BootHandle, type BootProc, bootProcess } from './boot'

/** Spy seam: captures signal handlers, never touches the real process. */
function makeProc() {
  const handlers = new Map<string, () => void>()
  const stopWatchdog = vi.fn()
  const proc: BootProc = {
    exit: vi.fn(),
    onSignal: (signal, handler) => {
      handlers.set(signal, handler)
    },
    installSafetyNet: vi.fn(),
    startWatchdog: vi.fn(() => stopWatchdog),
    log: vi.fn(),
    error: vi.fn(),
    // Resolves immediately so bootProcess returns in tests (prod never resolves).
    stayAlive: () => Promise.resolve(),
  }
  return { proc, handlers, stopWatchdog }
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
      '[podium:daemon] boot did not complete within 10ms (host memory pressure?) — exiting for systemd to retry',
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
    expect(proc.log).toHaveBeenCalledWith('up on 1234')
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
