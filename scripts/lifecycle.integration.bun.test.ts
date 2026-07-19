// scripts/lifecycle.integration.bun.test.ts
//
// Real-process smoke for the detached split (#98): spawns server + janitor + daemon
// as three independent processes (from source), asserts the run registry shows all three up with
// distinct PIDs (proving isolation + that the `--local` daemon authenticated to the local
// server), then stops them. Complements the unit tests (which mock processes) and the manual
// compiled-binary verification. Only the run-registry + spawn plumbing is exercised here; the
// compiled selfInvocation branch is covered by the manual real-binary check.
//
// RUNNER: `bun test --conditions=@podium/source scripts/lifecycle.integration.bun.test.ts`
// (imports bun:test; the *.bun.test.ts suffix is excluded from vitest). Boots a full server, so
// it needs a free port + a few seconds.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 59833
const dir = mkdtempSync(join(tmpdir(), 'podium-lifecycle-'))

beforeAll(() => {
  process.env.PODIUM_STATE_DIR = dir
  process.env.PODIUM_PORT = String(PORT) // override any inherited PODIUM_PORT (e.g. a dev daemon's)
  mkdirSync(join(dir, 'web'), { recursive: true })
  process.env.PODIUM_WEB_DIR = join(dir, 'web')
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ mode: 'all-in-one', persistence: 'detached', port: PORT }),
  )
})

afterAll(async () => {
  const reg = await import('../packages/runtime/src/run-registry')
  for (const role of ['server', 'janitor', 'daemon'] as const) {
    try {
      await reg.reclaim(role)
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
  for (const k of ['PODIUM_STATE_DIR', 'PODIUM_PORT', 'PODIUM_WEB_DIR']) delete process.env[k]
})

describe('detached split lifecycle', () => {
  it('runs server + janitor + daemon as three processes, then stops all', async () => {
    const spawn = await import('../apps/cli/src/cli-spawn')
    const reg = await import('../packages/runtime/src/run-registry')

    const { serverUp } = await spawn.startDetachedStack('all-in-one', PORT)
    expect(serverUp).toBe(true)

    // Give the --local daemon a moment to connect + write its pidfile.
    for (let i = 0; i < 40 && (!reg.liveRecord('janitor') || !reg.liveRecord('daemon')); i++) {
      await new Promise((r) => setTimeout(r, 250))
    }

    const server = reg.liveRecord('server')
    const janitor = reg.liveRecord('janitor')
    const daemon = reg.liveRecord('daemon')
    expect(server?.pid).toBeGreaterThan(0)
    expect(janitor?.pid).toBeGreaterThan(0)
    expect(daemon?.pid).toBeGreaterThan(0)
    expect(new Set([server?.pid, janitor?.pid, daemon?.pid]).size).toBe(3)

    await reg.reclaim('server')
    await reg.reclaim('janitor')
    await reg.reclaim('daemon')
    expect(reg.liveRecord('server')).toBeUndefined()
    expect(reg.liveRecord('janitor')).toBeUndefined()
    expect(reg.liveRecord('daemon')).toBeUndefined()
  }, 60_000)
})
