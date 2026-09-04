import { describe, expect, it } from 'vitest'
import { reapInstanceSessionProcesses } from './instance-process-reaper'

const UUID = '11111111-1111-4111-8111-111111111111'
const OTHER_UUID = '22222222-2222-4222-8222-222222222222'

function fakeIo(overrides: Partial<{
  readCwd(pid: number): string | undefined
  readStartTime(pid: number): string | undefined
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  sleep(ms: number): Promise<void>
}> = {}) {
  const alive = new Map<number, boolean>([
    [42, true],
    [43, true],
  ])
  const signals: { pid: number; signal: 'SIGTERM' | 'SIGKILL' }[] = []
  return {
    alive,
    signals,
    listPids: () => [42, 43],
    readEnvironment: (pid: number) =>
      pid === 42
        ? { instanceUuid: UUID, sessionId: 'session-1' }
        : { instanceUuid: OTHER_UUID, sessionId: 'session-1' },
    readCwd: overrides.readCwd ?? (() => '/worktrees/session-1'),
    readStartTime: overrides.readStartTime ?? (() => '100'),
    bootId: () => 'boot-1',
    pidAlive: (pid: number) => alive.get(pid) === true,
    signal:
      overrides.signal ??
      ((pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
        signals.push({ pid, signal })
        if (signal === 'SIGKILL') alive.set(pid, false)
      }),
    sleep: overrides.sleep ?? (async () => {}),
  }
}

describe('reapInstanceSessionProcesses', () => {
  it('reaps only the exact UUID/session and escalates a surviving process', async () => {
    const io = fakeIo()
    const result = await reapInstanceSessionProcesses({
      instanceUuid: UUID,
      sessionId: 'session-1',
      io,
      termGraceMs: 0,
      killGraceMs: 0,
    })

    expect(result).toEqual({ examined: 1, termSignalled: 1, killSignalled: 1, remaining: 0 })
    expect(io.signals).toEqual([
      { pid: 42, signal: 'SIGTERM' },
      { pid: 42, signal: 'SIGKILL' },
    ])
  })

  it('does not signal a PID whose cwd changes before the first signal', async () => {
    let targetCwdReads = 0
    const io = fakeIo({
      readCwd: (pid) => {
        if (pid !== 42) return '/worktrees/other'
        targetCwdReads += 1
        return targetCwdReads === 2 ? '/worktrees/recycled' : '/worktrees/session-1'
      },
    })

    const result = await reapInstanceSessionProcesses({
      instanceUuid: UUID,
      sessionId: 'session-1',
      io,
    })

    expect(result).toEqual({ examined: 1, termSignalled: 0, killSignalled: 0, remaining: 0 })
    expect(io.signals).toEqual([])
  })

  it('does not escalate a PID that recycles during the TERM grace window', async () => {
    let startTime = '100'
    const io = fakeIo({
      readStartTime: () => startTime,
      signal: (pid, signal) => {
        io.signals.push({ pid, signal })
      },
      sleep: async () => {
        startTime = '999'
      },
    })

    const result = await reapInstanceSessionProcesses({
      instanceUuid: UUID,
      sessionId: 'session-1',
      io,
      termGraceMs: 500,
      killGraceMs: 0,
    })

    expect(result).toEqual({ examined: 1, termSignalled: 1, killSignalled: 0, remaining: 0 })
    expect(io.signals).toEqual([{ pid: 42, signal: 'SIGTERM' }])
  })
})
