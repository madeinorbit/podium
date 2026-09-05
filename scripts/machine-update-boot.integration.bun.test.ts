import { afterEach, describe, expect, it } from 'bun:test'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateGrantMessage, UpdateStatusMessage } from '@podium/protocol'
import {
  MachineUpdateExecutor,
  type MachineUpdateAdapter,
} from '../packages/runtime/src/machine-update'
import { requestMachineUpdate } from '../packages/runtime/src/machine-update-control'

const roots: string[] = []
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-boot-run-'))
  roots.push(dir)
  return dir
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const grant: UpdateGrantMessage = {
  type: 'updateGrant',
  grantId: 'boot-race',
  issuedAt: 100,
  target: { version: '2.0.0', critical: false, artifacts: {} },
}
function setup(overrides: Partial<MachineUpdateAdapter> = {}, runtimeDir = root()) {
  const calls = { prepare: 0, activate: 0, discard: 0, restart: 0 }
  const statuses: UpdateStatusMessage[] = []
  const executor = new MachineUpdateExecutor({
    runtimeDir,
    adapter: {
      runningVersion: () => '1.0.0',
      runningDigest: () => 'old',
      prepare: async () => {
        calls.prepare++
        return { digest: 'new' }
      },
      activate: async () => {
        calls.activate++
      },
      discard: async () => {
        calls.discard++
      },
      restart: async () => {
        calls.restart++
        return 'handover-pending'
      },
      ...overrides,
    },
    report: (status) => statuses.push(status),
  })
  return { executor, calls, runtimeDir, statuses }
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('boot confirmation shares grant execution ownership', () => {
  for (const wait of [false, true]) {
    it(`joins a grant admitted before boot completion (waitForCompletion=${wait})`, async () => {
      const held = deferred()
      const started = deferred()
      let prepares = 0
      const { executor, calls } = setup({
        prepare: async () => {
          prepares++
          started.resolve()
          await held.promise
          return { digest: 'new' }
        },
      })
      const accepted = executor.accept(grant, wait)
      const boot = executor.confirmBoot(true)
      await started.promise
      // This queues behind confirmation, proving it did not hold admission.
      expect(await executor.cancel('other')).toBe(false)
      expect(prepares).toBe(1)
      held.resolve()
      await Promise.all([accepted, boot])
      expect(calls.activate).toBe(1)
      expect(calls.restart).toBe(1)
      expect(executor.snapshot()?.phase).toBe('restarting')
    })
  }

  it('cancellation aborts the sole held preparation while boot waits, before newer staging starts', async () => {
    const held = deferred()
    let prepares = 0
    const aborted = deferred()
    const { executor, calls } = setup({
      prepare: async (_grant, abort) => {
        prepares++
        abort.addEventListener('abort', aborted.resolve, { once: true })
        if (prepares === 1) await held.promise
        return { digest: 'new' }
      },
    })
    await executor.accept(grant, false)
    const boot = executor.confirmBoot(true)
    const canceled = executor.cancel(grant.grantId)
    // Admission is ordered; allow cancel to acquire it without timing sleeps.
    const next = executor.accept({ ...grant, grantId: 'newer', issuedAt: 101 }, false, true)
    await aborted.promise
    expect(prepares).toBe(1)
    expect(calls.discard).toBe(0)
    held.resolve()
    expect(await canceled).toBe(true)
    await Promise.all([boot, next])
    await executor.confirmBoot(true)
    expect(prepares).toBe(2)
    expect(calls.discard).toBe(1)
    expect(calls.activate).toBe(0)
    expect(executor.snapshot()?.completed[grant.grantId]?.phase).toBe('canceled')
    expect(executor.snapshot()?.phase).toBe('prepared')
  })

  it('boot confirmation preserves held activation until an explicit activation command', async () => {
    const held = deferred()
    const started = deferred()
    let restarts = 0
    const { executor, calls } = setup({
      restart: async () => {
        restarts++
        started.resolve()
        await held.promise
        return 'handover-pending'
      },
    })
    await executor.accept(grant, true, true)
    await Promise.all([executor.confirmBoot(true), executor.confirmBoot(false)])
    expect(executor.snapshot()?.activationHeld).toBe(true)
    expect(calls.prepare).toBe(1)
    expect(calls.activate).toBe(0)
    await executor.activate(grant.grantId)
    await started.promise
    const boot = executor.confirmBoot(true)
    expect(await executor.cancel('other')).toBe(false)
    held.resolve()
    await boot
    expect(calls.activate).toBe(1)
    expect(restarts).toBe(1)
  })

  it('confirmation after cancellation cannot revive the canceled grant', async () => {
    const held = deferred()
    const { executor, calls } = setup({
      prepare: async (_grant, signal) => {
        signal.addEventListener('abort', held.resolve, { once: true })
        await held.promise
        return { digest: 'new' }
      },
    })
    await executor.accept(grant, false)
    const canceled = executor.cancel(grant.grantId)
    const boots = [executor.confirmBoot(true), executor.confirmBoot(false)]
    expect(await canceled).toBe(true)
    await Promise.all(boots)
    expect(executor.snapshot()?.phase).toBe('canceled')
    expect(calls.activate).toBe(0)
  })

  for (const phase of ['accepted', 'downloading', 'prepared'] as const) {
    it(`serializes concurrent durable ${phase} recovery and retains exact held authority`, async () => {
      const original = setup()
      await original.executor.accept(grant, true, true)
      const journal = original.executor.snapshot()!
      journal.phase = phase
      if (phase !== 'prepared') journal.prepared = undefined
      writeFileSync(join(original.runtimeDir, 'machine-update.json'), JSON.stringify(journal))
      const recovered = setup({}, original.runtimeDir)
      await Promise.all([
        recovered.executor.confirmBoot(true),
        recovered.executor.confirmBoot(true),
      ])
      expect(recovered.executor.snapshot()?.grant).toEqual(grant)
      expect(recovered.calls.prepare).toBe(phase === 'prepared' ? 0 : 1)
      expect(recovered.calls.activate).toBe(0)
      await recovered.executor.activate(grant.grantId)
      await recovered.executor.confirmBoot(true)
      expect(recovered.calls.activate).toBe(1)
    })
  }

  it('boot confirmation waits for interrupted activation recovery before restarting', async () => {
    const original = setup()
    await original.executor.accept(grant)
    const journal = original.executor.snapshot()!
    journal.phase = 'activating'
    writeFileSync(join(original.runtimeDir, 'machine-update.json'), JSON.stringify(journal))
    const held = deferred()
    const started = deferred()
    const recovered = setup(
      {
        recoverActivation: async () => {
          started.resolve()
          await held.promise
        },
      },
      original.runtimeDir,
    )
    const recovery = recovered.executor.recoverBeforeBoot()
    await started.promise
    const boot = recovered.executor.confirmBoot(true)
    expect(recovered.calls.activate).toBe(0)
    held.resolve()
    await Promise.all([recovery, boot])
    expect(recovered.calls.activate).toBe(1)
    expect(recovered.calls.restart).toBe(1)
  })

  it('recovery joins an active preparation without touching activation staging', async () => {
    const held = deferred()
    const started = deferred()
    let recoveries = 0
    const { executor, calls } = setup({
      prepare: async () => {
        started.resolve()
        await held.promise
        return { digest: 'new' }
      },
      recoverActivation: async () => {
        recoveries++
      },
    })
    const accepted = executor.accept(grant)
    await started.promise
    const recovery = executor.recoverBeforeBoot()
    const boot = executor.confirmBoot(true)
    expect(await executor.cancel('other')).toBe(false)
    expect(recoveries).toBe(0)
    held.resolve()
    await Promise.all([accepted, recovery, boot])
    expect(calls.activate).toBe(1)
    expect(calls.restart).toBe(1)
  })

  for (const matchingSuccessor of [true, false]) {
    it(`standalone concurrent confirmations own one async restart (matching=${matchingSuccessor})`, async () => {
      const original = setup()
      await original.executor.accept(grant)
      const held = deferred()
      const started = deferred()
      let restarted = false
      let restarts = 0
      const recovered = setup({
        runningVersion: () => (restarted && matchingSuccessor ? '2.0.0' : '1.0.0'),
        runningDigest: () => (restarted && matchingSuccessor ? 'new' : 'old'),
        restart: async () => {
          restarts++
          started.resolve()
          await held.promise
          restarted = true
        },
      }, original.runtimeDir)
      const first = recovered.executor.confirmBoot(true)
      await started.promise
      const second = recovered.executor.confirmBoot(true)
      const recovery = recovered.executor.recoverBeforeBoot()
      expect(await recovered.executor.cancel(grant.grantId)).toBe(false)
      expect(restarts).toBe(1)
      held.resolve()
      await Promise.all([first, second, recovery])
      expect(restarts).toBe(1)
      expect(recovered.calls.prepare).toBe(0)
      expect(recovered.calls.activate).toBe(0)
      expect(recovered.executor.snapshot()?.phase).toBe(matchingSuccessor ? 'current' : 'stuck')
      expect(recovered.statuses.at(-1)).toMatchObject({
        type: 'updateStatus',
        grantId: grant.grantId,
        targetVersion: '2.0.0',
        version: matchingSuccessor ? '2.0.0' : '1.0.0',
        state: matchingSuccessor ? 'current' : 'stuck',
        phaseDetail: matchingSuccessor ? 'current' : 'stuck',
      })
    })
  }

  it('internal restart confirmation does not await its own run and still requires exact healthy identity', async () => {
    const held = deferred()
    const started = deferred()
    const { executor } = setup({
      restart: async () => {
        started.resolve()
        await held.promise
      },
    })
    const accepted = executor.accept(grant)
    await started.promise
    const boot = executor.confirmBoot(true)
    expect(await executor.cancel(grant.grantId)).toBe(false)
    held.resolve()
    await Promise.all([accepted, boot])
    expect(executor.snapshot()?.phase).toBe('stuck')
    expect(executor.snapshot()?.detail).toContain('identity does not match')

    const successor = setup({ runningVersion: () => '2.0.0', runningDigest: () => 'new' })
    await successor.executor.accept(grant)
    await successor.executor.confirmBoot(false)
    expect(successor.executor.snapshot()?.phase).toBe('restarting')
    await successor.executor.confirmBoot(true)
    expect(successor.executor.snapshot()?.phase).toBe('current')
  })
})

for (const cancel of [true, false]) {
  it(`production headless staging survives boot confirmation with ${cancel ? 'cancellation' : 'activation'}`, async () => {
    const dir = root()
    const payload = join(dir, 'payload')
    const pack = join(dir, 'pack')
    mkdirSync(payload)
    writeFileSync(join(payload, 'VERSION'), '1.0.0\n')
    mkdirSync(join(pack, 'headless'), { recursive: true })
    writeFileSync(join(pack, 'headless', 'VERSION'), '2.0.0\n')
    writeFileSync(join(pack, 'headless', 'podium'), 'private signed test payload\n')
    const archive = join(dir, 'bundle.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', pack, 'headless'])
    const bytes = readFileSync(archive)
    const key = generateKeyPairSync('ed25519')
    writeFileSync(
      join(dir, 'update-key'),
      key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    )
    let downloads = 0
    const feed = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        downloads++
        return new Response(bytes)
      },
    })
    let child: ChildProcess | undefined
    const events: Array<{ event: string; id?: number }> = []
    let output = ''
    const until = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 10000
      while (!predicate()) {
        if (child?.exitCode !== null && child?.exitCode !== undefined)
          throw new Error(`child exited: ${output}`)
        if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(events)} ${output}`)
        await Bun.sleep(10)
      }
    }
    try {
      const env = { ...process.env }
      for (const name of Object.keys(env))
        if (
          name.startsWith('PODIUM_') ||
          ['NOTIFY_SOCKET', 'WATCHDOG_USEC', 'INVOCATION_ID', 'ABDUCO_SOCKET_DIR'].includes(name)
        )
          delete env[name]
      Object.assign(env, {
        PODIUM_INSTANCE: 'boot-run-proof',
        PODIUM_STATE_DIR: dir,
        PODIUM_NO_RELAY: '1',
        PODIUM_LOGGING_MODE: 'foreground',
      })
      child = spawn(
        process.execPath,
        [
          '--conditions=@podium/source',
          new URL('./fixtures/machine-update-boot.ts', import.meta.url).pathname,
          dir,
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      )
      child.stdout!.on('data', (data) => {
        output += data
      })
      child.stderr!.on('data', (data) => {
        output += data
      })
      child.on('message', (message) => {
        events.push(message as (typeof events)[number])
      })
      await until(() => events.some((event) => event.event === 'ready'), 'control ready')
      const exact: UpdateGrantMessage = {
        ...grant,
        target: {
          version: '2.0.0',
          critical: false,
          trust: 'instance',
          schema: { migrations: [] },
          artifacts: {
            headless: {
              delivery: 'feed',
              platforms: {
                'linux-x86_64': {
                  url: `http://127.0.0.1:${feed.port}/bundle`,
                  digest: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
                  signature: sign(null, bytes, key.privateKey).toString('base64'),
                },
              },
            },
          },
        },
      }
      const runtime = join(dir, 'runtime')
      await requestMachineUpdate(runtime, '/grant', exact)
      await until(
        () => events.some((event) => event.event === 'staged'),
        'real extraction finished',
      )
      const stagedVersion = join(`${payload}.prepared`, 'headless', 'VERSION')
      expect(readFileSync(stagedVersion, 'utf8')).toBe('2.0.0\n')
      for (let id = 0; id < 3; id++) child.send({ command: 'boot', id })
      await until(
        () => events.filter((event) => event.event === 'boot-admitted').length === 3,
        'boot confirmations admitted',
      )
      expect(downloads).toBe(1)
      expect(events.filter((event) => event.event === 'prepare')).toHaveLength(1)
      expect(readFileSync(stagedVersion, 'utf8')).toBe('2.0.0\n')
      if (cancel)
        expect(await requestMachineUpdate(runtime, '/cancel', { grantId: exact.grantId })).toEqual({
          canceled: true,
        })
      else child.send({ command: 'release', id: 4 })
      await until(
        () => events.filter((event) => event.event === 'boot-complete').length === 3,
        'all boot callers settled',
      )
      const journal = (await requestMachineUpdate(runtime, '/status')) as {
        phase: string
        grant: UpdateGrantMessage
      }
      expect(journal.phase).toBe(cancel ? 'canceled' : 'restarting')
      expect(journal.grant).toEqual(exact)
      expect(readFileSync(join(payload, 'VERSION'), 'utf8')).toBe(cancel ? '1.0.0\n' : '2.0.0\n')
      expect(existsSync(`${payload}.prepared`)).toBe(false)
      expect(events.filter((event) => event.event === 'restart')).toHaveLength(cancel ? 0 : 1)
      child.send({ command: 'close', id: 5 })
      await new Promise<void>((resolve) => child!.once('exit', () => resolve()))
      expect(child.exitCode).toBe(0)
    } finally {
      feed.stop(true)
      if (child && child.exitCode === null) {
        child.kill('SIGKILL')
        await new Promise<void>((resolve) => child!.once('exit', () => resolve()))
      }
    }
  }, 20000)
}
