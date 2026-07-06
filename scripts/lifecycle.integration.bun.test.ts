// scripts/lifecycle.integration.bun.test.ts
//
// Real-process smoke for the detached split (#98): spawns `podium server` + `podium daemon`
// as two independent processes (from source), asserts the run registry shows BOTH up with
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
  const reg = await import('../packages/core/src/run-registry')
  for (const role of ['server', 'daemon'] as const) {
    try {
      await reg.reclaim(role)
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
  for (const k of ['PODIUM_STATE_DIR', 'PODIUM_PORT', 'PODIUM_WEB_DIR']) delete process.env[k]
})

describe('detached split lifecycle', () => {
  it('runs server + daemon as two processes, then stops both', async () => {
    const spawn = await import('./cli-spawn')
    const reg = await import('../packages/core/src/run-registry')

    const { serverUp } = await spawn.startDetachedStack('all-in-one', PORT)
    expect(serverUp).toBe(true)

    // Give the --local daemon a moment to connect + write its pidfile.
    for (let i = 0; i < 40 && !reg.liveRecord('daemon'); i++) {
      await new Promise((r) => setTimeout(r, 250))
    }

    const server = reg.liveRecord('server')
    const daemon = reg.liveRecord('daemon')
    expect(server?.pid).toBeGreaterThan(0)
    expect(daemon?.pid).toBeGreaterThan(0)
    expect(server?.pid).not.toBe(daemon?.pid) // two distinct, isolated processes

    await reg.reclaim('server')
    await reg.reclaim('daemon')
    expect(reg.liveRecord('server')).toBeUndefined()
    expect(reg.liveRecord('daemon')).toBeUndefined()
  }, 60_000)
})
