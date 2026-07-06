// Compile-harness fixture for apps/daemon/test/worker-compiled.bun.test.ts. It exercises the
// REAL DiscoveryWorkerClient → discovery-worker round-trip, and is compiled into a standalone
// binary by that test to prove the worker embeds + loads under `bun build --compile` (the exact
// path that broke with `ModuleNotFound resolving "/$bunfs/root/discovery-worker.ts"`).
//
// LOCATION MATTERS: this fixture lives in scripts/ — a top-level sibling of apps/ — on purpose.
// Bun embeds an extra entrypoint at its path relative to the common ancestor of all entrypoints;
// with this fixture and apps/daemon/src/discovery-worker.ts the common ancestor is the repo root,
// exactly matching the real daemon (whose entry is scripts/daemon-compiled.ts). Moving it under
// apps/ would change the embedded path and make the test lie about the shipped geometry.
import { DiscoveryWorkerClient } from '../apps/daemon/src/worker-client.js'

const client = new DiscoveryWorkerClient({
  timeoutMs: 8000,
  // A "crashed" log means the worker failed to load (the bug this guards against).
  log: (m) => console.log(m),
})
try {
  const res = (await client.runJob('memoryBreakdown', {
    sessions: [],
    roots: [],
    selfPid: process.pid,
  })) as { agents: unknown[]; projects: unknown[] }
  // The MemoryAttribution shape proves the worker actually ran, not a stub.
  if (Array.isArray(res.agents) && Array.isArray(res.projects)) console.log('SMOKE_OK')
  else console.log('SMOKE_BAD_SHAPE')
} catch (err) {
  console.log(`SMOKE_REJECTED ${(err as Error).message}`)
} finally {
  client.stop()
}
process.exit(0)
