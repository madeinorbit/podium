import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { restartAsServer, retireTargetDaemonAfterAcknowledgement } from './transfer-lifecycle'

function child(): ChildProcess & { emitExit(code: number | null): void } {
  const events = new EventEmitter()
  return Object.assign(events, {
    pid: 100,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
    unref: vi.fn(),
    emitExit(code: number | null) {
      events.emit('exit', code, null)
    },
  }) as unknown as ChildProcess & { emitExit(code: number | null): void }
}

describe('target transfer lifecycle process seam', () => {
  it('retains the target daemon so a lost promotion reply can retry the same transfer', async () => {
    const firstPromote = child()
    const retryPromote = child()
    const calls: Array<{ args: string[]; options: { detached?: boolean } }> = []
    const spawnProcess = vi.fn((_: string, args: readonly string[], options: object) => {
      calls.push({
        args: [...args],
        options: options as { detached?: boolean },
      })
      return calls.length === 1 ? firstPromote : retryPromote
    }) as unknown as typeof spawn

    const input = { transferId: '11111111-1111-4111-8111-111111111111' }
    const running = restartAsServer(input, { spawnProcess })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toContain('server-transfer-promote')
    expect(calls[0]?.args).toContain(input.transferId)

    firstPromote.emitExit(0)
    await running
    expect(calls).toHaveLength(1)
    expect(firstPromote.kill).not.toHaveBeenCalled()

    const retry = restartAsServer(input, { spawnProcess })
    retryPromote.emitExit(0)
    await retry
    expect(calls).toHaveLength(2)
    expect(calls[1]?.args).toContain('server-transfer-promote')
    expect(calls[1]?.args).toContain(input.transferId)
    expect(calls.every((call) => call.options.detached !== true)).toBe(true)
  })

  it('does not retire the in-flight daemon when promotion proof fails', async () => {
    const promote = child()
    const spawnProcess = vi.fn(() => promote) as unknown as typeof spawn

    const running = restartAsServer(
      { transferId: '11111111-1111-4111-8111-111111111111' },
      { spawnProcess },
    )
    promote.emitExit(2)

    await expect(running).rejects.toThrow(/exited 2/)
    expect(spawnProcess).toHaveBeenCalledOnce()
  })

  it('schedules the retirement worker only from an explicit acknowledgement callback', () => {
    const retire = child()
    const calls: Array<{ args: string[]; options: object }> = []
    const spawnProcess = vi.fn((_: string, args: readonly string[], options: object) => {
      calls.push({ args: [...args], options })
      return retire
    }) as unknown as typeof spawn
    let scheduled: (() => void) | undefined
    const schedule = vi.fn((callback: () => void, delayMs: number) => {
      expect(delayMs).toBe(50)
      scheduled = callback
    })

    retireTargetDaemonAfterAcknowledgement({ spawnProcess, schedule })

    expect(spawnProcess).not.toHaveBeenCalled()
    expect(scheduled).toBeTypeOf('function')
    scheduled?.()
    expect(spawnProcess).toHaveBeenCalledOnce()
    expect(calls[0]?.args).toContain('server-transfer-retire-daemon')
    expect(calls[0]?.options).toMatchObject({ detached: true })
    expect(retire.unref).toHaveBeenCalledOnce()
    expect(() => retire.emit('error', new Error('retirement unavailable'))).not.toThrow()
  })
})
