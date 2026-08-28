import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const timingScript = join(__dirname, 'release-build-timing.ts')

function timingEnv(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PODIUM_RELEASE_BUILD_TIMING: '1',
    PODIUM_RELEASE_TIMING_DIR: directory,
    PODIUM_RELEASE_CHANNEL: 'dev',
    PODIUM_RELEASE_TIMING_VERSION: 'dev-test',
    PODIUM_RELEASE_TIMING_SHA: 'abc1234',
  }
}

describe('release build timing command wrapper', () => {
  it('preserves a failing command status and records both boundaries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'podium-release-timing-'))
    try {
      const result = spawnSync(
        process.execPath,
        [
          timingScript,
          'run',
          '--phase',
          'artifact-publication',
          '--task',
          'describe-artifact',
          '--',
          process.execPath,
          '-e',
          'process.exit(7)',
        ],
        { env: timingEnv(directory), encoding: 'utf8' },
      )

      expect(result.status).toBe(7)
      const records = readFileSync(join(directory, 'dev-test.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { granularity: string; outcome: string })
      expect(records).toEqual([
        expect.objectContaining({ granularity: 'task', outcome: 'failure' }),
        expect.objectContaining({ granularity: 'phase', outcome: 'failure' }),
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves signal termination instead of converting it to exit 1', () => {
    const directory = mkdtempSync(join(tmpdir(), 'podium-release-timing-signal-'))
    try {
      const result = spawnSync(
        process.execPath,
        [
          timingScript,
          'run',
          '--phase',
          'headless-platform-build',
          '--',
          process.execPath,
          '-e',
          "process.kill(process.pid, 'SIGTERM')",
        ],
        { env: timingEnv(directory), encoding: 'utf8' },
      )

      expect(result.status).toBeNull()
      expect(result.signal).toBe('SIGTERM')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('creates no evidence when the opt-in flag is absent', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'podium-release-timing-off-')), 'evidence')
    const env: NodeJS.ProcessEnv = { ...process.env, PODIUM_RELEASE_TIMING_DIR: directory }
    delete env.PODIUM_RELEASE_BUILD_TIMING
    try {
      const result = spawnSync(
        process.execPath,
        [
          timingScript,
          'run',
          '--phase',
          'web-packaging',
          '--',
          process.execPath,
          '-e',
          'process.exit(0)',
        ],
        { env, encoding: 'utf8' },
      )

      expect(result.status).toBe(0)
      expect(existsSync(directory)).toBe(false)
      expect(result.stdout).not.toContain('[release-build-timing]')
    } finally {
      rmSync(join(directory, '..'), { recursive: true, force: true })
    }
  })
})
