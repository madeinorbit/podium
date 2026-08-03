import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reclaimStaleScope, type SystemctlRunner } from './abduco.js'
import { resolveAbducoBin } from './abduco-bin.js'

/**
 * Ported from main's packages/agent-bridge/src/abduco.reclaim.test.ts (114fb1f0)
 * after the rewrite moved abduco into @podium/pty and made reclaimStaleScope async.
 *
 * The property under test is an ABSENCE — "never runs a global abduco inventory" —
 * so it must not be able to pass vacuously. Two things make it able to say no:
 *   - the guarded path is asserted ENTERED (the second call must run the two
 *     systemctl reclaim commands), not merely "nothing happened";
 *   - the inventory is watched at the BINARY, not at the injected runner: any
 *     reintroduced `abduco` listing resolves the binary and execs it, and this
 *     fixture points $PODIUM_ABDUCO at a recorder that leaves a file behind.
 */
describe('reclaimStaleScope', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  it('guards spawn with the direct label socket and never runs a global abduco inventory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-abduco-reclaim-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))

    // A stand-in abduco that records every invocation. `-v` must succeed so
    // resolveAbducoBin accepts it; any other call (i.e. a bare `abduco` listing)
    // drops the marker this test forbids.
    const marker = join(root, 'abduco-invoked')
    const fakeAbduco = join(root, 'abduco-recorder')
    writeFileSync(
      fakeAbduco,
      `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "abduco-0.6-fake"; exit 0; fi\necho "$@" >> ${JSON.stringify(marker)}\nexit 0\n`,
    )
    chmodSync(fakeAbduco, 0o755)
    const prevBin = process.env.PODIUM_ABDUCO
    process.env.PODIUM_ABDUCO = fakeAbduco
    // resolveAbducoBin memoizes; re-locate onto the recorder and restore after.
    expect(resolveAbducoBin({ fresh: true })).toBe(fakeAbduco)
    cleanups.push(() => {
      if (prevBin === undefined) delete process.env.PODIUM_ABDUCO
      else process.env.PODIUM_ABDUCO = prevBin
      resolveAbducoBin({ fresh: true })
    })

    const dir = join(root, 'abduco', userInfo().username)
    mkdirSync(dir, { recursive: true })
    const socket = join(dir, 'podium-live@host')
    writeFileSync(socket, '')
    chmodSync(socket, 0o600)

    const run = vi.fn<SystemctlRunner>(async () => undefined)

    // A live master holds the label: the guard short-circuits, no scope is touched.
    await reclaimStaleScope('podium-live', { ABDUCO_SOCKET_DIR: root }, run)
    expect(run).not.toHaveBeenCalled()

    // A terminated socket (S_IXGRP) is not a live-master guard, so stale scope
    // cleanup runs: stop the old cgroup, then clear its unit state. This is the
    // non-vacuity anchor — the guarded path IS entered.
    chmodSync(socket, 0o610)
    await reclaimStaleScope('podium-live', { ABDUCO_SOCKET_DIR: root }, run)
    expect(run.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['systemctl', ['--user', 'stop', 'podium-live.scope']],
      ['systemctl', ['--user', 'reset-failed', 'podium-live.scope']],
    ])

    // Neither call may have shelled out to a global `abduco` inventory: listing
    // connects to every master in turn, so one wedged session would hang every
    // subsequent spawn forever.
    expect(existsSync(marker)).toBe(false)
  })
})
