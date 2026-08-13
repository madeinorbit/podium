import { asMachineId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdatesService } from './service'
import { restartCoordinatorAfterDevelopmentFleet, waitForServedWebDigest } from './trpc'

/**
 * The coordinator may only restart once the development fleet has actually
 * booted at the target, and it must stop waiting on exactly the same rule the
 * grants use — inactivity — rather than an absolute clock of its own. An
 * earlier absolute deadline would abandon an update the service still considers
 * healthy; no deadline at all would hold the coordinator on the old build
 * forever with nothing failing anywhere.
 */
describe('restartCoordinatorAfterDevelopmentFleet', () => {
  const target = { version: '0.4.2', critical: false, artifacts: {} } as never
  const POLL_MS = 250
  const SILENCE_MS = 60_000

  let clock = 0
  let machines: { id: string; version: string; state: string; online: boolean; busy: boolean }[]

  const build = () => {
    const service = new UpdatesService({
      machines: () => machines as never,
      send: vi.fn(),
      now: () => clock,
      nextGrantId: () => 'g1',
      concurrency: 3,
      grantDeadlineMs: SILENCE_MS,
    })
    service.setTarget(target)
    service.authorize()
    return service
  }

  /** Advance both the fake clock and the timer queue together. */
  const advance = async (ms: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += POLL_MS) {
      clock += POLL_MS
      await vi.advanceTimersByTimeAsync(POLL_MS)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    clock = 0
    machines = [{ id: 'a', version: '0.4.1', state: 'current', online: true, busy: false }]
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restarts once the machine has really booted at the target', async () => {
    const service = build()
    const restart = vi.fn()
    restartCoordinatorAfterDevelopmentFleet(service, '0.4.2', [asMachineId('a')], restart, POLL_MS)

    await advance(1_000)
    expect(restart).not.toHaveBeenCalled()

    const machine = machines[0]
    if (!machine) throw new Error('fixture missing')
    machine.version = '0.4.2'
    await advance(POLL_MS * 2)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting through a slow update that is still reporting progress', async () => {
    const service = build()
    const restart = vi.fn()
    restartCoordinatorAfterDevelopmentFleet(service, '0.4.2', [asMachineId('a')], restart, POLL_MS)

    // Well past the silence deadline in total elapsed time, but never silent.
    for (let round = 0; round < 4; round++) {
      await advance(SILENCE_MS - 10_000)
      service.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        state: 'restarting',
        version: '0.4.1',
      })
      expect(service.fleet()[0]).toMatchObject({ state: 'restarting' })
    }

    expect(restart).not.toHaveBeenCalled()

    const machine = machines[0]
    if (!machine) throw new Error('fixture missing')
    machine.version = '0.4.2'
    await advance(POLL_MS * 2)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('stops without restarting once silence turns the machine into a visible failure', async () => {
    const service = build()
    const restart = vi.fn()
    restartCoordinatorAfterDevelopmentFleet(service, '0.4.2', [asMachineId('a')], restart, POLL_MS)

    await advance(SILENCE_MS + POLL_MS * 2)

    expect(restart).not.toHaveBeenCalled()
    expect(service.fleet()[0]).toMatchObject({
      state: 'stuck',
      detail: 'The machine stopped reporting progress while updating.',
    })

    // The wait is OVER, not merely quiet: no poll remains scheduled.
    expect(vi.getTimerCount()).toBe(0)
    await advance(SILENCE_MS)
    expect(restart).not.toHaveBeenCalled()
  })
})

describe('waitForServedWebDigest', () => {
  it('returns as soon as the served stamp matches', async () => {
    await expect(waitForServedWebDigest('47a01e3', () => '47a01e3', 10, 50)).resolves.toBeUndefined()
  })

  it('gives up when the website never catches up', async () => {
    await expect(waitForServedWebDigest('47a01e3', () => 'aaaaaaa', 5, 20)).rejects.toThrow(
      'The website did not finish rebuilding in time.',
    )
  })
})
