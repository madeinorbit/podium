import { describe, expect, it, vi } from 'vitest'
import {
  type IntervalScheduler,
  readSupervisorPid,
  SUPERVISOR_PID_ENV,
  SUPERVISOR_SHUTDOWN_FILE_ENV,
  type SupervisorProbe,
  supervisorGone,
  unsupervisedEnv,
  watchSupervisor,
} from './supervisor'

/** A fake /proc: `ppid` and the set of live PIDs, both mutable mid-test. */
function makeProbe(
  ppid: number,
  live: number[],
): SupervisorProbe & {
  die: (pid: number) => void
  requestShutdown: (path: string) => void
} {
  const alive = new Set(live)
  const shutdownFiles = new Set<string>()
  let parent = ppid
  return {
    ppid: () => parent,
    alive: (pid) => alive.has(pid),
    shutdownRequested: (path) => shutdownFiles.has(path),
    die: (pid) => {
      alive.delete(pid)
      // The kernel reparents an orphan the moment its parent dies.
      if (parent === pid) parent = 1
    },
    requestShutdown: (path) => shutdownFiles.add(path),
  }
}

/** Drives the watch by hand: no timers, no real clock. */
function makeTimer() {
  let tick: (() => void) | undefined
  const cleared = vi.fn()
  const scheduler: IntervalScheduler = {
    every: (_ms, callback) => {
      tick = callback
      return cleared
    },
  }
  return { options: { scheduler }, tick: () => tick?.(), cleared }
}

describe('readSupervisorPid', () => {
  it('reads the shell PID the desktop exported', () => {
    expect(readSupervisorPid({ [SUPERVISOR_PID_ENV]: '4242' }, 99)).toBe(4242)
  })

  it('is undefined when unsupervised — the CLI, systemd, and every test run', () => {
    expect(readSupervisorPid({}, 99)).toBeUndefined()
    expect(readSupervisorPid({ [SUPERVISOR_PID_ENV]: '' }, 99)).toBeUndefined()
  })

  it('rejects a value that cannot name a supervisor', () => {
    // Garbage, a negative pid, and init: none of them is a shell that can die.
    expect(readSupervisorPid({ [SUPERVISOR_PID_ENV]: 'nope' }, 99)).toBeUndefined()
    expect(readSupervisorPid({ [SUPERVISOR_PID_ENV]: '-3' }, 99)).toBeUndefined()
    expect(readSupervisorPid({ [SUPERVISOR_PID_ENV]: '1' }, 99)).toBeUndefined()
  })

  it('rejects our own PID: waiting for ourselves to die never ends', () => {
    expect(readSupervisorPid({ [SUPERVISOR_PID_ENV]: '99' }, 99)).toBeUndefined()
  })
})

describe('supervisorGone', () => {
  it('a direct child notices reparenting even if the PID is immediately recycled', () => {
    // The desktop (pid 500) dies and an unrelated process takes pid 500 before the
    // next poll — a liveness check alone would say "still supervised" forever.
    const probe = makeProbe(1, [500])
    expect(supervisorGone(500, true, probe)).toBe(true)
  })

  it('an indirect child falls back to liveness, since its ppid was never the supervisor', () => {
    const probe = makeProbe(300, [500])
    expect(supervisorGone(500, false, probe)).toBe(false)
    probe.die(500)
    expect(supervisorGone(500, false, probe)).toBe(true)
  })

  it('a live supervisor that is still our parent is not gone', () => {
    expect(supervisorGone(500, true, makeProbe(500, [500]))).toBe(false)
  })
})

describe('watchSupervisor', () => {
  it('does nothing when unsupervised, so callers can `?.()` the result', () => {
    expect(watchSupervisor(vi.fn(), { env: {} })).toBeUndefined()
  })

  it('shuts the process down when the shell dies — the orphan case (POD-1228)', () => {
    const probe = makeProbe(500, [500])
    const timer = makeTimer()
    const onOrphaned = vi.fn()
    watchSupervisor(onOrphaned, { env: { [SUPERVISOR_PID_ENV]: '500' }, probe, ...timer.options })

    timer.tick()
    expect(onOrphaned).not.toHaveBeenCalled()

    probe.die(500)
    timer.tick()
    expect(onOrphaned).toHaveBeenCalledWith(500)
  })

  it('uses the same graceful shutdown when the live shell writes its marker', () => {
    const probe = makeProbe(500, [500])
    const timer = makeTimer()
    const onOrphaned = vi.fn()
    const env = {
      [SUPERVISOR_PID_ENV]: '500',
      [SUPERVISOR_SHUTDOWN_FILE_ENV]: '/state/desktop.shutdown',
    }
    watchSupervisor(onOrphaned, { env, probe, ...timer.options })

    probe.requestShutdown('/state/desktop.shutdown')
    timer.tick()

    expect(onOrphaned).toHaveBeenCalledWith(500)
    expect(probe.alive(500)).toBe(true)
  })

  it('fires once and stops polling: shutdown must not be re-entered every second', () => {
    const probe = makeProbe(500, [500])
    const timer = makeTimer()
    const onOrphaned = vi.fn()
    watchSupervisor(onOrphaned, { env: { [SUPERVISOR_PID_ENV]: '500' }, probe, ...timer.options })

    probe.die(500)
    timer.tick()
    timer.tick()
    expect(onOrphaned).toHaveBeenCalledTimes(1)
    expect(timer.cleared).toHaveBeenCalled()
  })

  it('a shell that died during our boot is caught immediately, not a poll later', () => {
    const timer = makeTimer()
    const onOrphaned = vi.fn()
    // ppid 1 and pid 500 already gone: we were orphaned before the watch started.
    watchSupervisor(onOrphaned, {
      env: { [SUPERVISOR_PID_ENV]: '500' },
      probe: makeProbe(1, []),
      ...timer.options,
    })
    expect(onOrphaned).toHaveBeenCalledWith(500)
  })

  it('stop() ends the watch — an ordinary SIGTERM shutdown must not leave a timer running', () => {
    const timer = makeTimer()
    const stop = watchSupervisor(vi.fn(), {
      env: { [SUPERVISOR_PID_ENV]: '500' },
      probe: makeProbe(500, [500]),
      ...timer.options,
    })
    stop?.()
    expect(timer.cleared).toHaveBeenCalled()
  })
})

describe('unsupervisedEnv', () => {
  it('drops the supervisor PID so a deliberately detached spawn outlives the shell', () => {
    const env = unsupervisedEnv({
      [SUPERVISOR_PID_ENV]: '500',
      [SUPERVISOR_SHUTDOWN_FILE_ENV]: '/state/desktop.shutdown',
      PODIUM_PORT: '18787',
    })
    expect(env[SUPERVISOR_PID_ENV]).toBeUndefined()
    expect(env[SUPERVISOR_SHUTDOWN_FILE_ENV]).toBeUndefined()
    expect(env.PODIUM_PORT).toBe('18787')
  })

  it('keeps PODIUM_DESKTOP_SUPERVISED: it describes the machine, not a pid to die with', () => {
    expect(unsupervisedEnv({ PODIUM_DESKTOP_SUPERVISED: '1' }).PODIUM_DESKTOP_SUPERVISED).toBe('1')
  })

  it('does not mutate the caller — process.env must survive being passed in', () => {
    const source = { [SUPERVISOR_PID_ENV]: '500' }
    unsupervisedEnv(source)
    expect(source[SUPERVISOR_PID_ENV]).toBe('500')
  })
})
