import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killAbducoSession, listLiveAbducoLabels, type SystemctlRunner } from './abduco.js'
import { resolveAbducoBin } from './abduco-bin.js'

/**
 * POD-1953. A park flips the session row before the kill is even on the wire, so
 * a reap that silently does nothing does not read as a slow park — it reads as a
 * finished one, over an agent that is still running. Two of these leaked on one
 * host in a single afternoon and sat 'hibernated' for hours with live masters.
 *
 * The reap has two halves and the scope sweep is the half that always works: it
 * signals the whole cgroup by unit name and needs nothing from `abduco`. It used
 * to be reachable only THROUGH the global listing's `await`, and that listing had
 * no timeout — so one wedged master took the reliable half down with it.
 */
describe('killAbducoSession', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  /** Point abduco at a script that never returns, and restore the memoized bin. */
  function useHangingAbduco(root: string): void {
    const fakeAbduco = join(root, 'abduco-hang')
    writeFileSync(
      fakeAbduco,
      `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "abduco-0.6-fake"; exit 0; fi\nsleep 300\n`,
    )
    chmodSync(fakeAbduco, 0o755)
    const prevBin = process.env.PODIUM_ABDUCO
    process.env.PODIUM_ABDUCO = fakeAbduco
    expect(resolveAbducoBin({ fresh: true })).toBe(fakeAbduco)
    cleanups.push(() => {
      if (prevBin === undefined) delete process.env.PODIUM_ABDUCO
      else process.env.PODIUM_ABDUCO = prevBin
      resolveAbducoBin({ fresh: true })
    })
  }

  it('sweeps the scope while the global listing is still hanging', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-abduco-kill-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    useHangingAbduco(root)

    const run = vi.fn<SystemctlRunner>(async () => undefined)
    const kill = killAbducoSession('podium-wedged', run)
    // No await on `kill` — that is the whole point. The listing is wedged for
    // five minutes; the scope sweep must not be queued behind it.
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2), { timeout: 2000 })
    expect(run.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['systemctl', ['--user', 'stop', 'podium-wedged.scope']],
      ['systemctl', ['--user', 'reset-failed', 'podium-wedged.scope']],
    ])

    // And the call itself still finishes: the listing is bounded, so a caller
    // that awaits the reap before reporting its outcome gets an answer.
    await expect(kill).resolves.toBeUndefined()
  }, 20000)
})

/**
 * The census the daemon pushes on connect (POD-1953) — the re-ask for kills this
 * server never saw the end of. Read from the socket index, never from a global
 * `abduco` listing, for the same reason as above.
 */
describe('listLiveAbducoLabels', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  it('reports live masters by label and skips terminated ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-abduco-census-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'abduco', userInfo().username)
    mkdirSync(dir, { recursive: true })

    // Relative names are stored `<label>@<hostname>`; a bare name is legal too.
    for (const [name, mode] of [
      ['podium-live@host', 0o600],
      ['podium-bare', 0o600],
      // S_IXGRP: the app exited and the master lingers holding its exit status.
      // It owns the NAME but there is no agent behind it, so a row parked over
      // this one is telling the truth and must not be revived.
      ['podium-terminated@host', 0o610],
    ] as const) {
      const socket = join(dir, name)
      writeFileSync(socket, '')
      chmodSync(socket, mode)
    }

    expect(listLiveAbducoLabels({ ABDUCO_SOCKET_DIR: root }).sort()).toEqual([
      'podium-bare',
      'podium-live',
    ])
  })

  // The first cut asked abducoSocketPath per label, and THAT re-reads the whole
  // directory for every entry in it. On a box with 7032 sockets the census took
  // 30 seconds and hung the daemon's connect behind it. A timing assertion could
  // not catch the regression at fixture scale, so pin the shape instead: one
  // directory read, however many sessions the host holds.
  it('reads each socket directory exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-abduco-census-n2-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'abduco', userInfo().username)
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 50; i++) {
      const socket = join(dir, `podium-s${i}@host`)
      writeFileSync(socket, '')
      chmodSync(socket, 0o600)
    }

    const readdir = vi.fn((dir: string) => readdirSync(dir))

    expect(listLiveAbducoLabels({ ABDUCO_SOCKET_DIR: root }, readdir)).toHaveLength(50)
    // Able to say NO: the seam is on the path, so a per-label re-read would show
    // up here as fifty calls rather than three.
    expect(readdir.mock.calls.length).toBeGreaterThan(0)
    // One read per candidate root, never one per entry.
    expect(readdir.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('is empty rather than throwing when the socket dir does not exist', () => {
    expect(listLiveAbducoLabels({ ABDUCO_SOCKET_DIR: join(tmpdir(), 'podium-no-such-dir') })).toEqual(
      [],
    )
  })
})
