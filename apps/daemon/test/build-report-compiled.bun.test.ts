import { describe, expect, it } from 'bun:test'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../../server/src/server'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const installedVersion = '0.1.2-edge.1'
const targetVersion = '0.1.3-edge.1'

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ])
  if (!graceful) {
    child.kill('SIGKILL')
    await exited
  }
}

describe('compiled installed daemon build report', () => {
  it('reports its baked release and is behind a newer server target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-build-report-compile-'))
    const serverState = join(dir, 'server-state')
    const daemonState = join(dir, 'daemon-state')
    const installDir = join(dir, 'installed')
    const bin = join(installDir, 'podium')
    const originalStateDir = process.env.PODIUM_STATE_DIR
    const originalAppVersion = process.env.PODIUM_APP_VERSION
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    let child: ChildProcess | undefined
    let stdout = ''
    let stderr = ''

    try {
      mkdirSync(installDir, { recursive: true })
      process.env.PODIUM_STATE_DIR = serverState
      process.env.PODIUM_APP_VERSION = targetVersion
      server = await startServer({ port: 0 })

      execFileSync(
        'bun',
        [
          'build',
          '--compile',
          '--conditions=@podium/source',
          '--define',
          `process.env.PODIUM_APP_VERSION=${JSON.stringify(installedVersion)}`,
          'apps/daemon/test/fixtures/build-report-compiled.ts',
          'apps/daemon/src/discovery-worker.ts',
          'apps/server/src/modules/sessions/publish-worker.ts',
          '--outfile',
          bin,
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      )

      const childEnv = {
        ...process.env,
        PODIUM_HOME: installDir,
        PODIUM_STATE_DIR: daemonState,
      }
      delete childEnv.PODIUM_APP_VERSION
      const startedChild = spawn(
        bin,
        [`ws://127.0.0.1:${server.port}`, server.bootstrapToken, join(dir, 'daemon-hooks')],
        { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      child = startedChild
      startedChild.stdout.setEncoding('utf8')
      startedChild.stderr.setEncoding('utf8')
      startedChild.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      startedChild.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      const started = Date.now()
      let installed = server.registry.modules.machines
        .listMachines()
        .find((machine) => machine.installKind === 'installed')
      while (!installed || !stdout.includes('DAEMON_READY')) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`compiled daemon exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`)
        }
        if (Date.now() - started > 10_000) {
          throw new Error(
            `compiled daemon did not report in time\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
        installed = server.registry.modules.machines
          .listMachines()
          .find((machine) => machine.installKind === 'installed')
      }

      expect(stdout).toContain('DAEMON_READY')
      expect(installed).toMatchObject({
        appVersion: installedVersion,
        installKind: 'installed',
        deliveryCaps: ['update.delivery.feed', 'update.delivery.bundle'],
        versionState: 'behind',
      })
    } finally {
      if (child) await stop(child)
      await server?.close()
      if (originalStateDir === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = originalStateDir
      if (originalAppVersion === undefined) delete process.env.PODIUM_APP_VERSION
      else process.env.PODIUM_APP_VERSION = originalAppVersion
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
