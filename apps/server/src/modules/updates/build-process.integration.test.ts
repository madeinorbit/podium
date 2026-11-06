import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BuildCommandTimeoutError, runBuildCommand } from './build-process'
import { canScopeDevBuild, runLowTierBuild } from './build-scope'

const env = { ...process.env }
const opts = { env, timeoutMs: 2_000, label: 'Fixture build', stdio: 'pipe' as const }

describe('bounded development build processes', () => {
  it('preserves command diagnostics and exit failures', async () => {
    await expect(
      runBuildCommand(
        process.execPath,
        ['-e', 'console.log("built"); console.error("diagnostic")'],
        opts,
      ),
    ).resolves.toEqual({ stdout: 'built\n', stderr: 'diagnostic\n' })
    await expect(
      runBuildCommand(
        process.execPath,
        ['-e', 'console.error("compile refused"); process.exit(7)'],
        opts,
      ),
    ).rejects.toMatchObject({ status: 7, stderr: 'compile refused\n' })
  })

  it('reports spawn errors without leaving its timeout armed', async () => {
    await expect(runBuildCommand('/no-such-podium-build-command', [], opts)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects oversized captured output instead of using partial source evidence', async () => {
    await expect(
      runBuildCommand(
        process.execPath,
        ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(() => {}, 1_000)'],
        opts,
      ),
    ).rejects.toThrow(/output exceeded 1 MiB/)
  })

  it('terminates a command that ignores SIGTERM within its deadline', async () => {
    await expect(
      runBuildCommand(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)'],
        { ...opts, timeoutMs: 100 },
      ),
    ).rejects.toThrow(BuildCommandTimeoutError)
  })

  it.skipIf(process.platform !== 'linux')(
    'kills descendants retaining output pipes after their parent exits',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'podium-build-timeout-'))
      const pidFile = join(dir, 'child.pid')
      let pid: number | undefined
      try {
        const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)`
        const script = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] }); child.unref(); setTimeout(() => process.exit(0), 100)`
        const result = runBuildCommand(process.execPath, ['-e', script], {
          ...opts,
          timeoutMs: 1_500,
        }).catch((error) => error)
        await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 1_200 })
        pid = Number(readFileSync(pidFile, 'utf8'))
        expect(await result).toBeInstanceOf(BuildCommandTimeoutError)
        await vi.waitFor(() => {
          // An orphan can briefly be a zombie until init reaps it.
          const stat = `/proc/${pid}/stat`
          if (existsSync(stat))
            expect(readFileSync(stat, 'utf8').split(') ')[1]?.startsWith('Z')).toBe(true)
        })
      } finally {
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'linux')('bounds a real systemd build scope', async ({ skip }) => {
    if (!canScopeDevBuild()) skip()
    await expect(
      runLowTierBuild({
        unit: `podium-test-build-timeout-${process.pid}.scope`,
        slice: `podium-test-build-timeout-${process.pid}.slice`,
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1_000)'],
        cwd: tmpdir(),
        env,
        timeoutMs: 1_250,
      }),
    ).rejects.toThrow(/timed out after 2s/)
  })
})
