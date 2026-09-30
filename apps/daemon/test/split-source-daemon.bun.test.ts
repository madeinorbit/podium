import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hermeticChildEnv } from '../../../test-hermetic-env'

/**
 * The documented split source recipe on a FRESH state dir (POD-4626).
 *
 * `scripts/daemon.ts` used to authenticate with the local shared secret; POD-4150
 * (6fd4f7221) deliberately removed that. With no enrolled machine key, no stored
 * token and no pending setup request the daemon has nothing to present: every socket
 * it opened failed with `daemon has no machine credential` and it retried forever.
 * It must instead stop at startup and name the missing step.
 *
 * A bare WebSocket listener stands in for the server: the credential is only chosen
 * once a socket opens, so without one the old daemon would fail on connection-refused
 * and never reach the defect.
 */
const repoRoot = resolve(import.meta.dir, '../../..')
const FAIL_FAST_BUDGET_MS = 30_000

describe('split source daemon on a fresh state dir', () => {
  it(
    'exits at startup naming the setup step instead of retrying forever',
    async () => {
      const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'split-daemon-'))
      const home = join(root, 'home')
      const state = join(root, 'state')
      mkdirSync(home, { recursive: true })
      mkdirSync(state, { recursive: true })
      let upgrades = 0
      const listener = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request, server) {
          upgrades += 1
          return server.upgrade(request)
            ? undefined
            : new Response('upgrade required', { status: 426 })
        },
        websocket: { message() {} },
      })
      const env = hermeticChildEnv({
        HOME: home,
        PODIUM_STATE_DIR: state,
        PODIUM_HOST: '127.0.0.1',
        PODIUM_PORT: String(listener.port),
        ABDUCO_SOCKET_DIR: join(root, 'abduco'),
        TMUX_TMPDIR: join(root, 'tmux'),
      })
      delete env.PODIUM_UNDER_PARENT
      delete env.PODIUM_SUPERVISOR_MACHINE_ID
      delete env.PODIUM_INSTANCE

      const child = spawn(process.execPath, ['--conditions=@podium/source', 'scripts/daemon.ts'], {
        cwd: repoRoot,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        output += String(chunk)
      })
      const exited = await new Promise<number | null | 'running'>((done) => {
        const timer = setTimeout(() => done('running'), FAIL_FAST_BUDGET_MS)
        child.once('exit', (code) => {
          clearTimeout(timer)
          done(code)
        })
      })
      if (exited === 'running' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      await listener.stop(true)

      expect({
        exited,
        retriedWithoutCredential: output.includes('no machine credential; pair it first'),
        dialed: upgrades > 0,
      }).toEqual({ exited: 1, retriedWithoutCredential: false, dialed: false })
      expect(output).toContain(state)
      expect(output).toContain('complete setup')
    },
    FAIL_FAST_BUDGET_MS + 10_000,
  )
})
