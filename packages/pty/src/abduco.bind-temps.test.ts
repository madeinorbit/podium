import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { abducoSocketPath, reapStaleAbducoBindTemps } from './abduco.js'

/**
 * Hermetic coverage of leftover `.abduco-<pid>` bind probes. Kept out of
 * `abduco.test.ts` so the unit lane (which excludes that file for real PTY
 * / abduco spawns) still runs the keep/drop cases.
 */
describe('reapStaleAbducoBindTemps', () => {
  const deadPid = 2 ** 30 // beyond pid_max — guaranteed not alive

  it('unlinks a bind temp whose pid is gone and leaves a live bind and real sockets', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-abduco-bind-temps-'))
    const dir = join(root, 'abduco', 'tester')
    mkdirSync(dir, { recursive: true })
    const socket = join(dir, 'podium-live@host')
    const deadTemp = join(dir, `.abduco-${deadPid}`)
    const liveTemp = join(dir, `.abduco-${process.pid}`)
    const otherDot = join(dir, '.abduco-not-a-pid')
    writeFileSync(socket, '')
    writeFileSync(deadTemp, '')
    writeFileSync(liveTemp, '')
    writeFileSync(otherDot, '')
    chmodSync(socket, 0o600)
    try {
      expect(reapStaleAbducoBindTemps({ ABDUCO_SOCKET_DIR: root }, 'tester')).toEqual([deadTemp])
      expect(existsSync(deadTemp)).toBe(false)
      expect(existsSync(liveTemp)).toBe(true)
      expect(existsSync(otherDot)).toBe(true)
      expect(existsSync(socket)).toBe(true)
      expect(abducoSocketPath('podium-live', { ABDUCO_SOCKET_DIR: root }, 'tester')).toBe(socket)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('sweeps $HOME/.abduco when ABDUCO_SOCKET_DIR is unset', () => {
    const home = mkdtempSync(join(tmpdir(), 'podium-abduco-home-temps-'))
    const dir = join(home, '.abduco')
    mkdirSync(dir)
    const deadTemp = join(dir, `.abduco-${deadPid}`)
    const liveTemp = join(dir, `.abduco-${process.pid}`)
    writeFileSync(deadTemp, '')
    writeFileSync(liveTemp, '')
    try {
      expect(reapStaleAbducoBindTemps({ HOME: home })).toEqual([deadTemp])
      expect(existsSync(deadTemp)).toBe(false)
      expect(existsSync(liveTemp)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('walks every ABDUCO_SOCKET_DIR candidate, not only the user subdirectory', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-abduco-bind-dirs-'))
    const userDir = join(root, 'abduco', 'tester')
    const parentDir = join(root, 'abduco')
    mkdirSync(userDir, { recursive: true })
    const inUser = join(userDir, `.abduco-${deadPid}`)
    const inParent = join(parentDir, `.abduco-${deadPid}`)
    const inRoot = join(root, `.abduco-${deadPid}`)
    writeFileSync(inUser, '')
    writeFileSync(inParent, '')
    writeFileSync(inRoot, '')
    try {
      expect(reapStaleAbducoBindTemps({ ABDUCO_SOCKET_DIR: root }, 'tester').sort()).toEqual(
        [inRoot, inParent, inUser].sort(),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
