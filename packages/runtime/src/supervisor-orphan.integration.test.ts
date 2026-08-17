/**
 * The bug this file exists for (POD-1228): the desktop shell reaps its backend from Tauri's exit
 * handlers, so a shell that CRASHES reaps nothing and leaves a live server holding the fixed
 * hook-ingest port. The next launch then fails on the conflict.
 *
 * Unit tests cover the decision (`supervisor.test.ts`); this one covers the syscalls it rests on —
 * a real spawn, a real SIGKILL, a real reparent — because the whole mechanism is "notice something
 * the kernel did", and a mocked kernel cannot be wrong about it in the same way.
 *
 * Shape: a stand-in "shell" spawns a stand-in "backend" that runs the real `watchSupervisor`, then
 * the shell is SIGKILLed — a signal it cannot handle, so none of its own exit code runs, exactly as
 * in a crash. The backend must then be gone on its own.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isAlive } from './run-registry'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const supervisorModule = fileURLToPath(new URL('./supervisor.ts', import.meta.url))

/**
 * The stand-in backend: pidfile first (so the test can always find it), then the REAL watch, then
 * an idle timer standing in for a server that would otherwise run forever.
 */
const backendSource = (pidFile: string) => `
  import { writeFileSync } from 'node:fs'
  import { watchSupervisor } from ${JSON.stringify(supervisorModule)}
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
  watchSupervisor(() => process.exit(0), { intervalMs: 50 })
  setInterval(() => {}, 1000)
`

/** The stand-in shell: spawns the backend as a DIRECT child, exports its own PID, then idles. */
const shellSource = (backend: string) => `
  import { spawn } from 'node:child_process'
  spawn(process.execPath, ['-e', ${JSON.stringify(backend)}], {
    stdio: 'inherit',
    env: { ...process.env, PODIUM_SUPERVISOR_PID: String(process.pid) },
  })
  setInterval(() => {}, 1000)
`

async function waitFor<T>(read: () => Promise<T | undefined>, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${budgetMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('a supervised backend outliving its shell', () => {
  it.skipIf(process.platform === 'win32')(
    'exits on its own when the shell is SIGKILLed, so the next launch finds its ports free',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'podium-supervisor-'))
      roots.push(root)
      const pidFile = join(root, 'backend.pid')

      const shell = spawn(process.execPath, ['-e', shellSource(backendSource(pidFile))], {
        stdio: 'inherit',
      })
      let backendPid: number | undefined
      try {
        backendPid = await waitFor(async () => {
          const pid = Number(await readFile(pidFile, 'utf8').catch(() => Number.NaN))
          return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
        }, 20_000)

        // Positive control. Without it, "the backend is dead" would also pass for a backend that
        // never started — which is the failure mode a test like this is most likely to have.
        expect(isAlive(backendPid)).toBe(true)

        shell.kill('SIGKILL')
        await waitFor(async () => (isAlive(backendPid as number) ? undefined : true), 10_000)
      } finally {
        shell.kill('SIGKILL')
        // A FAILING run is the run that leaves an orphan behind — the very thing under test — so
        // the cleanup has to reach the backend directly rather than through the dead shell.
        if (backendPid !== undefined && isAlive(backendPid)) {
          try {
            process.kill(backendPid, 'SIGKILL')
          } catch {
            // Already gone between the check and the signal.
          }
        }
      }
    },
    45_000,
  )
})
