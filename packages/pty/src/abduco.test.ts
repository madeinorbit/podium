import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  abducoAttachArgv,
  abducoSocketHasSession,
  abducoSocketPath,
  attachAbducoAgent,
  parseAbducoList,
  waitForAbducoSocket,
} from './abduco.js'
import { resolveAbducoBin } from './abduco-bin.js'
import { createAltScreenStripper } from './alt-screen-stripper.js'
import type { PtyBackend, PtyProcess } from './backends/types.js'
import { abducoAdoptionAdapter } from './durable-process.js'

/**
 * The hermetic half of ADOPTING a running abduco session (POD-4986): nothing
 * here creates one. Every Podium release before POD-4986 ran its sessions on
 * abduco, and an upgraded daemon attaches to them, lists them and kills them;
 * the real-session half lives in `abduco-adoption.integration.test.ts`.
 *
 * The attach resolves its client binary even when a fake pty backend never
 * runs it, so this points $PODIUM_ABDUCO at a stub that answers the version
 * and feature probes: no compiler, no build, no managed cache.
 */
let stubRoot = ''
let savedAbduco: string | undefined

beforeAll(() => {
  stubRoot = mkdtempSync(join(tmpdir(), 'podium-abduco-stub-'))
  const stub = join(stubRoot, 'abduco')
  writeFileSync(
    stub,
    '#!/bin/sh\ncase "$1" in\n  -v) echo "abduco-0.6-stub"; exit 0 ;;\n  --podium-features) echo 2; exit 0 ;;\nesac\nexit 1\n',
  )
  chmodSync(stub, 0o755)
  savedAbduco = process.env.PODIUM_ABDUCO
  process.env.PODIUM_ABDUCO = stub
  expect(resolveAbducoBin({ fresh: true })).toBe(stub)
})

afterAll(() => {
  if (savedAbduco === undefined) delete process.env.PODIUM_ABDUCO
  else process.env.PODIUM_ABDUCO = savedAbduco
  resolveAbducoBin({ fresh: true })
  if (stubRoot) rmSync(stubRoot, { recursive: true, force: true })
})

describe('abduco command builders', () => {
  it('builds an attach command that remaps the detach key to a raw 0xff via printf', () => {
    const argv = abducoAttachArgv('podium-1')
    expect(argv[0]).toBe('sh')
    expect(argv[1]).toBe('-c')
    // The script must produce the raw byte through printf (node argv would UTF-8
    // encode \xff into 0xC3 0xBF, silently making the detach key 0xC3).
    expect(argv[2]).toContain("printf '\\377'")
    expect(argv[2]).toContain("exec 'abduco'")
    expect(argv[2]).toContain('-q')
    expect(argv[2]).toContain('-a "$0"')
    expect(argv[3]).toBe('podium-1')
  })

  it('shell-quotes a resolved binary path in the attach command', () => {
    const argv = abducoAttachArgv('podium-1', '/home/u/.podium/bin/abduco')
    expect(argv[2]).toContain("exec '/home/u/.podium/bin/abduco'")
  })

  it('passes an absolute socket path through unchanged for host-renamed sessions', () => {
    const socketPath = '/home/u/.abduco/podium-1@old-host'
    const calls: Array<{ file: string; args: string[] }> = []
    const proc: PtyProcess = {
      pid: 4242,
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
    const backend: PtyBackend = {
      name: 'bun-terminal',
      spawn(opts) {
        calls.push({ file: opts.file, args: opts.args })
        return proc
      },
    }

    const session = attachAbducoAgent({
      label: 'podium-1',
      socketPath,
      cols: 80,
      rows: 24,
      backend,
    })
    try {
      expect(calls[0]).toMatchObject({ file: 'sh' })
      expect(calls[0]?.args[2]).toBe(socketPath)
    } finally {
      session.dispose()
    }
  })
  it('an attach never nudges the program: a TUI gets nothing, a shell only its Ctrl-L (POD-4723)', () => {
    for (const hardRepaint of [false, true]) {
      const resizes: Array<{ cols: number; rows: number }> = []
      const writes: string[] = []
      const proc: PtyProcess = {
        pid: 4242,
        onData: () => {},
        onExit: () => {},
        write: (data: Uint8Array) => writes.push(Buffer.from(data).toString('hex')),
        resize: (cols, rows) => resizes.push({ cols, rows }),
        kill: () => {},
      }
      const session = attachAbducoAgent({
        label: 'podium-no-nudge',
        cols: 80,
        rows: 24,
        hardRepaint,
        backend: { name: 'bun-terminal', spawn: () => proc },
      })
      // No shrink-and-restore: the attach pty is born at its size, and that is all.
      expect(resizes).toEqual([])
      expect(writes).toEqual(hardRepaint ? ['0c'] : [])
      session.dispose()
    }
  })

  it('adopting a live master applies nothing and repaints nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-abduco-adopt-policy-'))
    const label = 'podium-adopt-policy'
    const socketPath = join(dir, `${label}@${hostname()}`)
    writeFileSync(socketPath, '')
    chmodSync(socketPath, 0o600)

    const resizes: Array<{ cols: number; rows: number }> = []
    const writes: string[] = []
    const proc: PtyProcess = {
      pid: 4242,
      onData: () => {},
      onExit: () => {},
      write: (data: Uint8Array) => writes.push(Buffer.from(data).toString('hex')),
      resize: (cols: number, rows: number) => resizes.push({ cols, rows }),
      kill: () => {},
    }
    const backend: PtyBackend = {
      name: 'bun-terminal',
      spawn: () => proc,
    }

    try {
      // The adoption adapter finds the master by its socket, exactly where an
      // older Podium's abduco left it...
      const located = await abducoAdoptionAdapter().socketPath(label, { ABDUCO_SOCKET_DIR: dir })
      expect(located).toBe(socketPath)
      // ...and attaches the way `abducoAdoptionAdapter().attach` does:
      // size-neutral, the last-known size only as the `-N`-less fallback.
      const adopted = attachAbducoAgent({
        label,
        socketPath: located as string,
        sizeNeutral: true,
        fallbackGeometry: { cols: 80, rows: 24 },
        backend,
      })
      expect(resizes).toEqual([])
      // The attach-time repaint is deferred to the client's first byte or a
      // fallback timer, and on this path it is nothing at all: adopting a live
      // master may not touch the program. Give the fallback time to prove it.
      await new Promise((r) => setTimeout(r, 1500))
      expect(writes).toEqual([])
      expect(resizes).toEqual([])

      // A viewer's ask is the one thing that moves it: exactly that resize, and
      // no nudge after it (POD-4723).
      adopted.resize(80, 24)
      expect(resizes).toEqual([{ cols: 80, rows: 24 }])
      expect(writes).toEqual([])
      adopted.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

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

describe('abduco session list parser', () => {
  // State chars per abduco 0.6 source: `+` = app terminated (dead), `*` = a client
  // is currently attached (alive), ` ` = detached and alive.
  const LISTING = [
    'Active sessions (on host podium-host)',
    '+ Thu\t 2026-06-11 09:10:11\t1111\tpodium-dead',
    '* Thu\t 2026-06-11 09:20:22\t2222\tpodium-attached',
    '  Thu\t 2026-06-11 09:30:33\t3333\tpodium-detached',
  ].join('\n')

  it('parses names, pids and liveness; attached (*) is alive, terminated (+) is not', () => {
    expect(parseAbducoList(LISTING)).toEqual([
      { name: 'podium-dead', pid: 1111, alive: false },
      { name: 'podium-attached', pid: 2222, alive: true },
      { name: 'podium-detached', pid: 3333, alive: true },
    ])
  })

  it('handles an empty listing (header only) and blank output', () => {
    expect(parseAbducoList('Active sessions (on host x)\n')).toEqual([])
    expect(parseAbducoList('')).toEqual([])
  })
})

describe('alt-screen chrome stripper', () => {
  const CHROME = '\x1b[?1049h\x1b[H'
  const enc = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
  const dec = (u: Uint8Array) => Buffer.from(u).toString('latin1')

  it('strips the exact one-time prefix and passes the rest through', () => {
    const strip = createAltScreenStripper()
    expect(dec(strip(enc(`${CHROME}hello`)))).toBe('hello')
    expect(dec(strip(enc(CHROME)))).toBe(CHROME) // later occurrences are app output
  })

  it('strips a prefix split across chunks', () => {
    const strip = createAltScreenStripper()
    expect(dec(strip(enc('\x1b[?10')))).toBe('')
    expect(dec(strip(enc('49h\x1b[Hworld')))).toBe('world')
  })

  it('flushes held bytes when the stream turns out not to start with the chrome', () => {
    const strip = createAltScreenStripper()
    expect(dec(strip(enc('\x1b[?10')))).toBe('')
    expect(dec(strip(enc('25h')))).toBe('\x1b[?1025h')
    expect(dec(strip(enc(CHROME)))).toBe(CHROME)
  })

  it('passes a chrome-less stream through unchanged', () => {
    const strip = createAltScreenStripper()
    expect(dec(strip(enc('plain')))).toBe('plain')
    expect(dec(strip(enc(CHROME)))).toBe(CHROME)
  })
})
