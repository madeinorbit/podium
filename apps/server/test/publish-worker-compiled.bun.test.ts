// Real-binary guard for Bun's non-auto-embedded Worker(URL) behavior.
// RUNNER: bun test only; *.bun.test.ts is excluded from Vitest.
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

describe('compiled publish worker', () => {
  it('embeds, loads, and answers from the bun --compile binary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'podium-publish-worker-compile-'))
    const binary = join(directory, 'publish-worker-smoke')
    try {
      execFileSync(
        'bun',
        [
          'build',
          '--compile',
          '--conditions=@podium/source',
          'scripts/publish-worker-smoke.ts',
          'apps/server/src/modules/sessions/publish-worker.ts',
          '--outfile',
          binary,
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      )
      const output = execFileSync(binary, { encoding: 'utf8', timeout: 20_000 })
      expect(output).toContain('PUBLISH_WORKER_SMOKE_OK')
      expect(output).not.toContain('ModuleNotFound')
      expect(output).not.toContain('crashed')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
