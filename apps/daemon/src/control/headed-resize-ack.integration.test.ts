/**
 * POD-4723: THE REPORTED SIZE IS THE CHILD'S SIZE.
 *
 * A generic-pty (claude-code) session on a real podium-host, driven through the
 * daemon's own construction site (`wireBridge`) and its own `resize`/`redraw`
 * handlers in the order the server sends them on a control transfer: `resize`,
 * then `redraw`. The last `geometryApplied` the daemon sends must equal what the
 * CHILD's tty says (`stty -F <its pts> size`), on a fresh spawn and on a daemon
 * restart that re-adopts the live host.
 *
 * Before the fix the daemon reported the viewer's size while the redraw nudge —
 * reading the host's last acknowledged size, still the birth size — shrank and
 * restored the pty back to 80x24 (80x23 when the child emitted nothing).
 *
 * Integration lane (a C compile, real processes, real ptys).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import {
  connectHost,
  hostSocketPath,
  killHostSession,
  resolveHostBin,
  spawnHostAgent,
} from '@podium/process/durable'
import type { DurableAttachment } from '@podium/process/screen'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forgetSessionScreen } from '../session-screens'
import { testSessions } from '../session/testing.js'
import type { DaemonContext } from './context'
import { sessionHandlers, wireBridge } from './session'

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

/** A TUI stand-in: repaints (writes a frame) on every SIGWINCH, like Claude does. */
const REPAINTING = `
const draw = () => process.stdout.write('\\x1b[2J\\x1b[HTUI ' + process.stdout.columns + 'x' + process.stdout.rows)
process.on('SIGWINCH', draw)
draw()
setInterval(() => {}, 3600_000)
`

const keys = ['PODIUM_HOST_SOCKET_DIR', 'PODIUM_STATE_DIR', 'PODIUM_NO_SCOPE', 'PODIUM_HOST_BIN'] as const
const saved = keys.map((k) => process.env[k])
let root = ''
let fixture = ''
let serial = 0

beforeAll(() => {
  if (!hasCompiler) return
  root = mkdtempSync(join(tmpdir(), 'pod-hra-'))
  process.env.PODIUM_HOST_SOCKET_DIR = join(root, 's')
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_NO_SCOPE = '1'
  delete process.env.PODIUM_HOST_BIN
  resolveHostBin({ fresh: true })
  fixture = join(root, 'tui.mjs')
  writeFileSync(fixture, REPAINTING)
})

afterAll(() => {
  keys.forEach((k, i) => {
    const v = saved[i]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  })
  resolveHostBin({ fresh: true })
  if (root) rmSync(root, { recursive: true, force: true })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** What the CHILD's tty says: `stty size` on the pts its stdin is. */
function childTty(pid: number): { cols: number; rows: number } {
  const pts = readlinkSync(`/proc/${pid}/fd/0`)
  const [rows, cols] = execFileSync('stty', ['-F', pts, 'size'], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
    .map(Number)
  return { cols: cols as number, rows: rows as number }
}

function daemonContext(sent: DaemonMessage[]): DaemonContext {
  return {
    backend: 'host',
    settingsDir: join(root, 'settings'),
    sessions: testSessions(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: { enqueue: () => {}, remove: () => {}, flushNow: () => {}, priorityOf: () => 1 },
    observers: { onResize: () => {}, clearSession: () => {} },
    sessionCwdTracker: { clear: () => {} },
    primeInjector: { reset: () => {} },
    send: (msg: DaemonMessage) => sent.push(msg),
  } as unknown as DaemonContext
}

function reports(sent: DaemonMessage[], sessionId: SessionId): Array<{ cols: number; rows: number }> {
  return sent.flatMap((m) =>
    m.type === 'geometryApplied' && m.sessionId === sessionId
      ? [{ cols: m.geometry.cols, rows: m.geometry.rows }]
      : [],
  )
}

/** The server's control-transfer pair, then enough time for nudge + restore to land. */
async function viewerAsks(ctx: DaemonContext, sessionId: SessionId, cols: number, rows: number) {
  sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols, rows })
  sessionHandlers.redraw(ctx, { type: 'redraw', sessionId })
  await wait(2000)
}

describe.skipIf(!hasCompiler)('headed resize on a real podium-host (POD-4723)', () => {
  it('fresh spawn, then viewer asks: the last report equals the child tty, both times', async () => {
    const sessionId = asSessionId(`hra-${process.pid}-${++serial}`)
    const label = `podium-${sessionId}`
    const sent: DaemonMessage[] = []
    const ctx = daemonContext(sent)
    let attachment: DurableAttachment | undefined
    try {
      attachment = await spawnHostAgent({ label, cmd: process.execPath, args: [fixture], cols: 80, rows: 24 })
      wireBridge(ctx, sessionId, attachment, 'claude-code', label, { cols: 80, rows: 24 })
      await wait(300)
      expect(childTty(attachment.pid)).toEqual({ cols: 80, rows: 24 })

      await viewerAsks(ctx, sessionId, 122, 39)
      expect(childTty(attachment.pid)).toEqual({ cols: 122, rows: 39 })
      expect(reports(sent, sessionId).at(-1)).toEqual(childTty(attachment.pid))

      await viewerAsks(ctx, sessionId, 122, 38)
      expect(childTty(attachment.pid)).toEqual({ cols: 122, rows: 38 })
      expect(reports(sent, sessionId).at(-1)).toEqual(childTty(attachment.pid))
    } finally {
      for (const [, owned] of ctx.sessions.entries()) owned.park()
      forgetSessionScreen(ctx, sessionId)
      await killHostSession(label).catch(() => {})
    }
  }, 60_000)

  it('daemon restart re-adopts the live host, then viewer asks: the last report equals the child tty', async () => {
    const sessionId = asSessionId(`hra-${process.pid}-${++serial}`)
    const label = `podium-${sessionId}`
    const firstSent: DaemonMessage[] = []
    const first = daemonContext(firstSent)
    const sent: DaemonMessage[] = []
    const ctx = daemonContext(sent)
    try {
      const born = await spawnHostAgent({ label, cmd: process.execPath, args: [fixture], cols: 80, rows: 24 })
      wireBridge(first, sessionId, born, 'claude-code', label, { cols: 80, rows: 24 })
      await viewerAsks(first, sessionId, 100, 30)
      // The old daemon dies: its surface detaches, the host and child live on.
      for (const [, owned] of first.sessions.entries()) owned.park()
      forgetSessionScreen(first, sessionId)

      // The new daemon adopts the live host and reattaches size-neutrally, then
      // nudges a repaint (redrawOnReattach), exactly as the reattach path does.
      const adopted = await spawnHostAgent({ label, cmd: process.execPath, args: [fixture], cols: 80, rows: 24 })
      expect(adopted.adopted).toBe(true)
      wireBridge(ctx, sessionId, adopted, 'claude-code', label, undefined)
      ctx.sessions.get(sessionId)?.terminal?.redraw()
      await wait(1500)
      const pid = adopted.pid
      expect(childTty(pid)).toEqual({ cols: 100, rows: 30 })

      await viewerAsks(ctx, sessionId, 122, 39)
      expect(childTty(pid)).toEqual({ cols: 122, rows: 39 })
      expect(reports(sent, sessionId).at(-1)).toEqual(childTty(pid))
    } finally {
      for (const [, owned] of [...first.sessions.entries(), ...ctx.sessions.entries()]) owned.park()
      forgetSessionScreen(ctx, sessionId)
      await killHostSession(label).catch(() => {})
    }
  }, 60_000)

  it('a resize the host refuses (lease stolen) is never reported and is held', async () => {
    const sessionId = asSessionId(`hra-${process.pid}-${++serial}`)
    const label = `podium-${sessionId}`
    const sent: DaemonMessage[] = []
    const ctx = daemonContext(sent)
    const thief = { conn: undefined as ReturnType<typeof connectHost> | undefined }
    try {
      const attachment = await spawnHostAgent({ label, cmd: process.execPath, args: [fixture], cols: 80, rows: 24 })
      wireBridge(ctx, sessionId, attachment, 'claude-code', label, { cols: 80, rows: 24 })
      const before = reports(sent, sessionId).length
      // Another writer takes the lease: this daemon's RESIZE now answers ERR NOT_WRITER.
      thief.conn = connectHost(hostSocketPath(label), { mode: 'writer' })
      await thief.conn.welcome
      await thief.conn.steal()

      sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
      await wait(1000)
      expect(reports(sent, sessionId)).toHaveLength(before)
      expect(childTty(attachment.pid)).toEqual({ cols: 80, rows: 24 })
      expect(ctx.sessions.get(sessionId)?.pendingResize).toEqual({ cols: 122, rows: 39 })
    } finally {
      thief.conn?.detach()
      for (const [, owned] of ctx.sessions.entries()) owned.park()
      forgetSessionScreen(ctx, sessionId)
      await killHostSession(label).catch(() => {})
    }
  }, 60_000)
})
