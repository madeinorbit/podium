import type { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { reclaimStaleScope } from './abduco.js'

describe('reclaimStaleScope', () => {
  it('guards spawn with the direct label socket and never runs a global abduco inventory', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-abduco-reclaim-'))
    const dir = join(root, 'abduco', userInfo().username)
    mkdirSync(dir, { recursive: true })
    const socket = join(dir, 'podium-live@host')
    writeFileSync(socket, '')
    chmodSync(socket, 0o600)
    const run = vi.fn()
    try {
      reclaimStaleScope(
        'podium-live',
        { ABDUCO_SOCKET_DIR: root },
        run as unknown as typeof spawnSync,
      )
      expect(run).not.toHaveBeenCalled()

      // A terminated socket is not a live-master guard, so stale scope cleanup
      // remains unchanged: stop the old cgroup, then clear its unit state.
      chmodSync(socket, 0o610)
      reclaimStaleScope(
        'podium-live',
        { ABDUCO_SOCKET_DIR: root },
        run as unknown as typeof spawnSync,
      )
      expect(run.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        ['systemctl', ['--user', 'stop', 'podium-live.scope']],
        ['systemctl', ['--user', 'reset-failed', 'podium-live.scope']],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})