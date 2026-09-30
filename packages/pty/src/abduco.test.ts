import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { abducoSocketHasSession, abducoSocketPath, waitForAbducoSocket } from './abduco.js'

describe('abducoSocketHasSession', () => {
  it('checks one configured socket without walking every abduco master', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-abduco-sockets-'))
    const dir = join(root, 'abduco', 'tester')
    mkdirSync(dir, { recursive: true })
    const socket = join(dir, 'podium-live@host')
    writeFileSync(socket, '')
    try {
      chmodSync(socket, 0o600)
      expect(abducoSocketPath('podium-live', { ABDUCO_SOCKET_DIR: root }, 'tester')).toBe(socket)
      expect(abducoSocketHasSession('podium-live', { ABDUCO_SOCKET_DIR: root }, 'tester')).toBe(
        true,
      )
      // abduco marks a terminated application's socket with S_IXGRP.
      chmodSync(socket, 0o610)
      expect(abducoSocketHasSession('podium-live', { ABDUCO_SOCKET_DIR: root }, 'tester')).toBe(
        false,
      )
      expect(abducoSocketPath('podium-live', { ABDUCO_SOCKET_DIR: root }, 'tester')).toBeUndefined()
      expect(abducoSocketHasSession('podium-other', { ABDUCO_SOCKET_DIR: root }, 'tester')).toBe(
        false,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('waitForAbducoSocket', () => {
  it('waits for a master to publish its socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-abduco-ready-'))
    const dir = join(root, 'abduco', 'tester')
    mkdirSync(dir, { recursive: true })
    const label = 'podium-ready'
    try {
      const pending = waitForAbducoSocket(
        label,
        { ABDUCO_SOCKET_DIR: root },
        { username: 'tester', timeoutMs: 200, pollMs: 2 },
      )
      await new Promise((resolve) => setTimeout(resolve, 15))
      const socket = join(dir, label + '@old-host')
      writeFileSync(socket, '')
      expect(await pending).toBe(socket)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
