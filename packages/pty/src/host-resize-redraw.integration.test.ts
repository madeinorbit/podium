/**
 * POD-4723: a viewer resize immediately followed by a redraw — the order the
 * daemon issues them in on every control transfer (`resize`, then `redraw`,
 * whose handler re-applies the viewer size and then nudges) — must leave the
 * CHILD's pty at the viewer size. Driven through the real adapter against a
 * real podium-host; the child reports its own TIOCGWINSZ, and the host's SIZE
 * request reads the kernel.
 *
 * Integration lane (a C compile, real processes, real ptys); never the unit lane.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveHostBin } from './host-bin.js'
import { type HostDurableAttachment, killHostSession, spawnHostAgent } from './host.js'

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

const WINSIZE_FIXTURE = fileURLToPath(new URL('../test/fixtures/winsize-log.mjs', import.meta.url))
/** A child that never writes a byte after startup: no frame will ever restore a nudge. */
const SILENT_ARGS = ['-e', 'setInterval(() => {}, 3600_000)']

let root = ''
const saved: Record<string, string | undefined> = {}
const labels: string[] = []
let serial = 0
const sessions: HostDurableAttachment[] = []

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function label(tag: string): string {
  // Short: the socket path must fit a unix socket's ~108 bytes.
  const l = `rr-${process.pid}-${tag}-${++serial}`
  labels.push(l)
  return l
}

async function spawn(tag: string, args: string[], cols = 80, rows = 24): Promise<HostDurableAttachment> {
  const s = await spawnHostAgent({ label: label(tag), cmd: process.execPath, args, cols, rows })
  sessions.push(s)
  await s.ready
  return s
}

beforeAll(() => {
  if (!hasCompiler) return
  root = mkdtempSync(join(tmpdir(), 'pod-rr-'))
  for (const k of ['PODIUM_STATE_DIR', 'PODIUM_HOST_SOCKET_DIR', 'PODIUM_NO_SCOPE', 'PODIUM_HOST_BIN']) {
    saved[k] = process.env[k]
  }
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = join(root, 's')
  process.env.PODIUM_NO_SCOPE = '1'
  delete process.env.PODIUM_HOST_BIN
  resolveHostBin({ fresh: true })
})

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    try {
      s.dispose()
    } catch {
      // already gone
    }
  }
  for (const l of labels.splice(0)) {
    try {
      await killHostSession(l)
    } catch {
      // already gone
    }
  }
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resolveHostBin({ fresh: true })
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!hasCompiler)('podium-host adapter: resize then redraw (POD-4723)', () => {
  it('a redraw issued before the resize is acknowledged nudges around the NEW size, and the pty ends there', async () => {
    const s = await spawn('race', [WINSIZE_FIXTURE])
    // Exactly the daemon's order on a control transfer: resize, the redraw
    // handler's size-first re-apply, then the nudge — all in one tick, so no
    // RESIZED has come back when the nudge reads the size.
    s.resize(122, 39)
    s.resize(122, 39)
    s.redraw()
    // Let the shrink, the child's SIGWINCH answer and the restore all land.
    await wait(1500)
    expect(await s.connection.size()).toEqual({ cols: 122, rows: 39 })
    expect(s.appliedGeometry).toEqual({ cols: 122, rows: 39 })

    // And a second ask on the same attachment (the 122x38 that followed on the host).
    s.resize(122, 38)
    s.redraw()
    await wait(1500)
    expect(await s.connection.size()).toEqual({ cols: 122, rows: 38 })
    expect(s.appliedGeometry).toEqual({ cols: 122, rows: 38 })
  }, 30_000)

  it('a redraw nudge on a child that emits no frame does not strand the pty one row short', async () => {
    const s = await spawn('silent', SILENT_ARGS, 100, 30)
    await wait(300)
    s.redraw()
    await wait(3000)
    expect(await s.connection.size()).toEqual({ cols: 100, rows: 30 })
    expect(s.appliedGeometry).toEqual({ cols: 100, rows: 30 })
  }, 30_000)
})
