// apps/daemon/test/control-compiled.bun.test.ts
//
// RUNNER: bun test only. Compiles a tiny daemon harness into a standalone binary and
// verifies the installed/runtime websocket path processes control frames sent right
// after the peer acknowledgement.
import { describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hermeticChildEnv } from '../../../test-hermetic-env'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

describe('compiled daemon control websocket', () => {
  it('processes control frames sent immediately after peerHelloOk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-control-compile-'))
    const bin = join(dir, 'control-smoke')
    try {
      execFileSync(
        'bun',
        [
          'build',
          '--compile',
          '--conditions=@podium/source',
          '--define=process.env.PODIUM_APP_VERSION="0.0.0-test"',
          'scripts/daemon-control-smoke.ts',
          'apps/daemon/src/discovery-worker.ts',
          '--outfile',
          bin,
        ],
        { cwd: repoRoot, env: hermeticChildEnv(), stdio: 'pipe' },
      )
      const result = spawnSync(bin, {
        cwd: repoRoot,
        env: hermeticChildEnv(),
        encoding: 'utf8',
        timeout: 20_000,
      })
      if (result.error) throw result.error
      const out = result.stdout
      expect(result.status, `${out}\n${result.stderr}`).toBe(0)
      expect(out).toContain('SMOKE_OK')
      expect(out).not.toContain('SMOKE_FAILED')
      expect(out).not.toContain('dropped malformed inbound control frame')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
