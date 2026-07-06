// apps/daemon/test/worker-compiled.bun.test.ts
//
// Regression guard for the standalone-binary worker crash: in a `bun build --compile` daemon,
// `new Worker(new URL('./discovery-worker.ts', import.meta.url))` is NOT auto-embedded (Bun
// 1.3.x), so the shipped binary died on every discovery tick with
//   [podium:daemon] discovery worker crashed: ModuleNotFound resolving
//   "/$bunfs/root/discovery-worker.ts" (entry point)
// The fix (scripts/build-bun.ts + discovery-worker-embed.ts + worker-client.ts) adds the worker
// as an explicit extra entrypoint and spawns it from its embedded path. Unit tests run from
// source and CANNOT catch this — only compiling a real binary and running it does. See the
// team rule: constructed CLI/binary invocations need a real-binary smoke.
//
// RUNNER: `bun test` only (imports bun:test; the *.bun.test.ts suffix is excluded from vitest).
// It compiles scripts/discovery-worker-smoke.ts + the worker with the SAME entrypoint geometry
// as the real daemon (both share the repo root as common ancestor), then runs the binary and
// asserts the worker loaded + returned a real result.

import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

describe('compiled daemon worker', () => {
  it('embeds + loads the discovery worker in a bun --compile binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-worker-compile-'))
    const bin = join(dir, 'worker-smoke')
    try {
      // Compile EXACTLY as scripts/build-bun.ts compiles the daemon: main entry + the worker
      // as an extra entrypoint, `--conditions=@podium/source`. No --define — worker-client
      // resolves the embedded path from the shared constant + its own /$bunfs module URL.
      execFileSync(
        'bun',
        [
          'build',
          '--compile',
          '--conditions=@podium/source',
          'scripts/discovery-worker-smoke.ts',
          'apps/daemon/src/discovery-worker.ts',
          '--outfile',
          bin,
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      )
      const out = execFileSync(bin, { encoding: 'utf8', timeout: 20_000 })
      // The worker must have loaded and returned the MemoryAttribution shape…
      expect(out).toContain('SMOKE_OK')
      // …and must NOT have hit the embed/load crash this test exists to catch.
      expect(out).not.toContain('crashed')
      expect(out).not.toContain('ModuleNotFound')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
