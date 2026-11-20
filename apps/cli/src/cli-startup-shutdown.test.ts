import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./test-support/startup.test.fixture.ts', import.meta.url))

describe.skipIf(process.platform === 'win32')(
  'CLI shutdown while server startup is pending',
  () => {
    it.each([
      'SIGTERM',
      'SIGINT',
    ] as const)('%s waits for the current boot step, closes once, and never announces readiness', async (signal) => {
      const dir = mkdtempSync(join(tmpdir(), 'podium-startup-stop-'))
      const child = spawn('bun', ['--conditions=@podium/source', fixture, 'server', '--takeover'], {
        env: { ...process.env, PODIUM_STATE_DIR: dir, PODIUM_MODE: 'server' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        output += chunk.toString()
      })
      const exited = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code, signal) => resolve({ code, signal }))
        },
      )
      try {
        await expect.poll(() => output).toContain('fixture:starting')
        expect(child.kill(signal)).toBe(true)
        child.stdin.write('ping\n')
        await expect.poll(() => output).toContain('fixture:alive')
        expect(output).not.toContain('fixture:server-closed')
        // Another stop during the same boot must retain the one close.
        child.kill(signal)
        child.stdin.write('resume\n')
        await expect(exited).resolves.toEqual({ code: 0, signal: null })
        expect(output.match(/fixture:server-closed/g)).toHaveLength(1)
        expect(output.indexOf('fixture:boot-step-finished')).toBeLessThan(
          output.indexOf('fixture:server-closed'),
        )
        expect(output).not.toContain('podium server up on ')
      } finally {
        child.kill('SIGKILL')
        await exited
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)
  },
)
