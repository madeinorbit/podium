import type { ResolvedHarnessInventory } from '@podium/harness'
import { describe, expect, it } from 'vitest'
import { DaemonHarnessRuntime } from './harness-runtime'
import { testHarnessSnapshot } from './test-support/harness-snapshot'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('DaemonHarnessRuntime', () => {
  it('discards a generation that finishes after its replacement', async () => {
    const builds = [deferred<ResolvedHarnessInventory>(), deferred<ResolvedHarnessInventory>()]
    const runtime = new DaemonHarnessRuntime({ buildSnapshot: (generation) => builds[generation]!.promise })
    const oldPending = runtime.current()
    const nextPending = runtime.refresh()
    const next = testHarnessSnapshot({}, 1)
    builds[1]!.resolve(next)
    await expect(nextPending).resolves.toBe(next)
    const old = testHarnessSnapshot({}, 0)
    builds[0]!.resolve(old)
    await expect(oldPending).resolves.toBe(old)
    expect(runtime.isCurrent(old)).toBe(false)
    expect(runtime.isCurrent(next)).toBe(true)
    await expect(runtime.current()).resolves.toBe(next)
  })

  it('launches the exact executable and PATH captured by its snapshot', async () => {
    const snapshot = testHarnessSnapshot({ codex: '/home/user/.brew/bin/codex' }, 4)
    const runtime = new DaemonHarnessRuntime({ buildSnapshot: async () => snapshot })
    const launch = await runtime.launch('codex', { cwd: '/repo' })
    expect(launch.cmd).toBe('/home/user/.brew/bin/codex')
    expect(launch.env?.PATH).toBe(snapshot.commandEnvironment.env.PATH)
  })
})
