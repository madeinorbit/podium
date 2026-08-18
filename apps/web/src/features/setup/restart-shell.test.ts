// @vitest-environment happy-dom
import { addSink, type LogRecord, resetLogging } from '@podium/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restartPodiumShell } from './restart-shell'

type RestartHook = { __PODIUM_RESTART__?: () => unknown }

/** A real sink following config, so "it was reported" is a claim about the
 *  shipping mechanism rather than about a spy. */
function capture(): LogRecord[] {
  const records: LogRecord[] = []
  addSink({ name: 'capture', write: (record) => void records.push(record) })
  return records
}

afterEach(() => {
  delete (window as unknown as RestartHook).__PODIUM_RESTART__
  resetLogging()
  vi.restoreAllMocks()
})

describe('shell restart', () => {
  it('never throws when the native hook refuses, and records why', async () => {
    // POD-1292: this rejection used to propagate into a caller that had already
    // saved the user's connection, where it read as a failed connection.
    const records = capture()
    ;(window as unknown as RestartHook).__PODIUM_RESTART__ = () =>
      Promise.reject(new Error('process.restart not allowed'))

    await expect(restartPodiumShell()).resolves.toBe('unavailable')
    const refusal = records.find((record) => record.level === 'error')
    expect(refusal?.msg).toBe('native restart hook refused')
    expect(refusal?.reason).toBe('process.restart not allowed')
  })

  it('treats a hook that returns with the page still alive as a refusal', async () => {
    // The native hook replaces the process, so returning means the shell stayed.
    ;(window as unknown as RestartHook).__PODIUM_RESTART__ = () => undefined
    await expect(restartPodiumShell()).resolves.toBe('unavailable')
  })

  it('reloads a plain browser, which has no shell process to re-exec', async () => {
    const reload = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload,
    } as unknown as Location)

    await expect(restartPodiumShell()).resolves.toBe('started')
    expect(reload).toHaveBeenCalledOnce()
  })
})
