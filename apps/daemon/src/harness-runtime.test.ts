import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoginProbeExec, ProbeExec, ResolvedHarnessInventory } from '@podium/harness'
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
  it('joins an in-flight inventory wave instead of suppressing its result', async () => {
    const build = deferred<ResolvedHarnessInventory>()
    let builds = 0
    const runtime = new DaemonHarnessRuntime({
      buildSnapshot: async () => {
        builds += 1
        return build.promise
      },
    })

    const initial = runtime.current()
    const periodic = runtime.reprobe()
    const serverRequested = runtime.reprobe()
    expect(periodic).toBe(initial)
    expect(serverRequested).toBe(initial)
    expect(builds).toBe(1)

    const snapshot = testHarnessSnapshot({ 'claude-code': '/home/user/.local/bin/claude' }, 0)
    build.resolve(snapshot)
    await expect(initial).resolves.toBe(snapshot)
    expect(runtime.isCurrent(snapshot)).toBe(true)
  })

  it('discards a generation that finishes after its replacement', async () => {
    const builds = [deferred<ResolvedHarnessInventory>(), deferred<ResolvedHarnessInventory>()]
    const runtime = new DaemonHarnessRuntime({
      buildSnapshot: (generation) => builds[generation]!.promise,
    })
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

  it('reprobe reuses the command environment and injectable login runner', async () => {
    const machineHome = mkdtempSync(join(tmpdir(), 'harness-runtime-login-'))
    try {
      const claudePath = join(machineHome, 'claude')
      writeFileSync(claudePath, '')
      chmodSync(claudePath, 0o755)
      const probeEnvironments: Array<Readonly<Record<string, string>>> = []
      const versionExec: ProbeExec = async () => '2.1.50'
      const loginExec: LoginProbeExec = async (_argv, _timeoutMs, env) => {
        probeEnvironments.push(env)
        return {
          stdout: JSON.stringify({ loggedIn: false }),
          stderr: '',
          exitCode: 1,
          timedOut: false,
        }
      }
      const runtime = new DaemonHarnessRuntime({
        machineHome,
        credentialHome: machineHome,
        env: {
          HOME: machineHome,
          PATH: machineHome,
          CLAUDE_CONFIG_DIR: '',
          CLAUDE_SECURESTORAGE_CONFIG_DIR: '/secure/storage',
        },
        exec: versionExec,
        loginExec,
      })

      const first = await runtime.current()
      const second = await runtime.reprobe()
      expect(probeEnvironments).toHaveLength(2)
      // THE REUSE IS THE `toBe` ON THE SNAPSHOT: `reprobe()` threads the previous
      // snapshot's commandEnvironment through instead of resolving the machine's
      // command environment again, and identity is the only thing that says so.
      expect(second.commandEnvironment).toBe(first.commandEnvironment)
      // The probe's env is DERIVED from it, not the same object — `fix(harness):
      // answer login reads for the instance's own home` routes every login read
      // through `harnessLoginReadEnv`, which composes a fresh record (instance
      // HOME forced on, this harness's foreign credentials and inherited parent
      // controls taken out) so the readout names the same account the child will
      // run as. Both probes must still see one env built from the one snapshot.
      expect(probeEnvironments[0]).not.toBe(first.commandEnvironment.env)
      expect(probeEnvironments[0]).toEqual(probeEnvironments[1])
      expect(probeEnvironments[1]).toHaveProperty('CLAUDE_CONFIG_DIR', '')
      expect(probeEnvironments[1]).toHaveProperty(
        'CLAUDE_SECURESTORAGE_CONFIG_DIR',
        '/secure/storage',
      )
    } finally {
      rmSync(machineHome, { recursive: true, force: true })
    }
  })
})
