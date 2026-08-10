import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateGrantMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { startServer } from '../../server/src/server'
import { startDaemon } from './daemon'
import { readPendingGrant } from './pending-grant'

function git(cwd: string | undefined, args: string[]): string {
  return execFileSync('git', cwd ? ['-C', cwd, ...args] : args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for daemon grant convergence'))
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })
}

describe('daemon update grant over the live server socket', () => {
  it('checks out a granted git revision and reports the restarting state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-grant-e2e-'))
    const stateDir = join(root, 'state')
    const runtimeDir = join(root, 'runtime')
    const identityDir = join(root, 'identity')
    const origin = join(root, 'origin.git')
    const producer = join(root, 'producer')
    const checkout = join(root, 'checkout')
    const priorStateDir = process.env.PODIUM_STATE_DIR
    const priorAppVersion = process.env.PODIUM_APP_VERSION
    const priorPodiumHome = process.env.PODIUM_HOME
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
    let markerAtRestart: ReturnType<typeof readPendingGrant> = null

    try {
      process.env.PODIUM_STATE_DIR = stateDir
      process.env.PODIUM_APP_VERSION = 'dev'
      delete process.env.PODIUM_HOME

      git(undefined, ['init', '--bare', origin])
      git(undefined, ['clone', origin, producer])
      git(producer, ['config', 'user.email', 'podium-e2e@example.test'])
      git(producer, ['config', 'user.name', 'Podium E2E'])
      writeFileSync(join(producer, 'version.txt'), 'first\n')
      git(producer, ['add', 'version.txt'])
      git(producer, ['commit', '-m', 'first'])
      git(producer, ['branch', '-M', 'main'])
      git(producer, ['push', '-u', 'origin', 'main'])
      const firstSha = git(producer, ['rev-parse', 'HEAD'])

      git(undefined, ['clone', origin, checkout])
      writeFileSync(join(producer, 'version.txt'), 'target\n')
      git(producer, ['add', 'version.txt'])
      git(producer, ['commit', '-m', 'target'])
      git(producer, ['push'])
      const targetSha = git(producer, ['rev-parse', 'HEAD'])
      git(checkout, ['checkout', '--detach', firstSha])
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(firstSha)

      server = await startServer({ port: 0 })
      const machineId = server.registry.sessionStore.hostMachineId
      daemon = await startDaemon({
        serverUrl: `ws://127.0.0.1:${server.port}`,
        bootstrapToken: server.bootstrapToken,
        machineId,
        identityDir,
        hooks: { port: 0, settingsDir: runtimeDir },
        agentRelay: { port: 0 },
        tmux: false,
        discovery: { background: false, cachePath: ':memory:' },
        metrics: { background: false },
        restartAfterUpdate: () => {
          markerAtRestart = readPendingGrant(runtimeDir)
        },
      })

      await waitFor(() =>
        server?.registry.modules.machines
          .listMachines()
          .some(
            (machine) => machine.id === machineId && machine.online && machine.appVersion === 'dev',
          )
          ? true
          : false,
      )

      const target: UpdateGrantMessage['target'] = {
        version: 'dev+target',
        critical: false,
        artifacts: {
          headless: {
            delivery: 'bundle',
            platforms: {
              'linux-x86_64': {
                url: 'https://server.test/dev-bundle',
                digest: 'unused',
                signature: 'unused',
              },
            },
          },
          headlessAlternatives: [{ delivery: 'git', repo: checkout, sha: targetSha }],
        },
      }
      const updates = server.registry.modules.updates
      updates.setTarget(target)
      expect(updates.tick()).toEqual([machineId])

      await waitFor(() => git(checkout, ['rev-parse', 'HEAD']) === targetSha)
      await waitFor(() => typeof markerAtRestart?.grantId === 'string')
      await waitFor(
        () => updates.fleet().find((machine) => machine.id === machineId)?.state === 'restarting',
      )

      expect(markerAtRestart).toMatchObject({
        targetVersion: 'dev+target',
        previousVersion: 'dev',
        attempts: 1,
      })
      expect(readFileSync(join(checkout, 'version.txt'), 'utf8')).toBe('target\n')
      expect(updates.fleet().find((machine) => machine.id === machineId)).toMatchObject({
        state: 'restarting',
        version: 'dev',
      })
    } finally {
      await daemon?.close()
      await server?.close()
      if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = priorStateDir
      if (priorAppVersion === undefined) delete process.env.PODIUM_APP_VERSION
      else process.env.PODIUM_APP_VERSION = priorAppVersion
      if (priorPodiumHome === undefined) delete process.env.PODIUM_HOME
      else process.env.PODIUM_HOME = priorPodiumHome
      rmSync(root, { recursive: true, force: true })
    }
  })
})
