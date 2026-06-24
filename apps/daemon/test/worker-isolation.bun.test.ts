// apps/daemon/test/worker-isolation.bun.test.ts
//
// Headline regression test: a heavy /proc walk runs on the discovery worker
// thread and must NOT block the daemon's main event loop. This is the FIRST
// test that spawns the REAL worker (../src/discovery-worker.ts) — it validates
// that the `.ts` worker actually loads under the runtime the live daemon uses (Bun).
//
// RUNNER: this file MUST run under Bun, the same runtime the live daemon uses:
//   bun test --conditions=@podium/source apps/daemon/test/worker-isolation.bun.test.ts
// The `--conditions=@podium/source` flag is REQUIRED: the spawned worker resolves
// `@podium/agent-bridge` from source (mirroring the live daemon's launch, which
// runs with `--conditions=@podium/source`); without it that import fails to resolve.
// Node-based vitest cannot spawn the `.ts` worker (inside the spawned Worker the
// bare `./discovery-jobs` import has no TS loader, so the worker exits 1). The
// `*.bun.test.ts` suffix is excluded from the vitest config on purpose, so vitest
// never collects this — it is run only via `bun test`, never silently skipped.
// It lives in test/ (outside the daemon tsconfig `include: ["src"]`) so `tsc`
// never typechecks the bun:test import — matching the repo's other *.bun.test.ts.
import { describe, expect, it } from 'bun:test'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DiscoveryWorkerClient } from '../src/worker-client.js'

describe('worker isolation', () => {
  it(
    'keeps the main event loop responsive while a heavy /proc walk runs',
    async () => {
      const c = new DiscoveryWorkerClient()
      const h = monitorEventLoopDelay({ resolution: 5 })
      h.enable()
      // Real /proc walk on this host (~hundreds of ms of work) — on the worker.
      const result = (await c.runJob('memoryBreakdown', {
        sessions: [],
        roots: [],
        selfPid: process.pid,
      })) as { agents: unknown[]; projects: unknown[] }
      // Meanwhile the main loop kept ticking; read its max lag now the job landed.
      const maxMs = h.max / 1e6
      h.disable()
      c.stop()
      // Prove the real worker actually ran the /proc walk (not a no-op):
      // the shape it returns must be the MemoryAttribution result object.
      expect(Array.isArray(result.agents)).toBe(true)
      expect(Array.isArray(result.projects)).toBe(true)
      // eslint-disable-next-line no-console
      console.log(`[worker-isolation] main-loop max lag while worker ran: ${maxMs.toFixed(2)}ms`)
      expect(maxMs).toBeLessThan(100) // main loop never blocked >100ms
    },
    20_000,
  )
})
