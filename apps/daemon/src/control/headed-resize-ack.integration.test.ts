/**
 * POD-4723 (design rev 3): THE REPORTED SIZE IS THE CHILD'S SIZE.
 *
 * A generic-pty (claude-code) session on a real podium-host, driven through the
 * daemon's own construction site (`wireBridge`) and its own `resize`/`redraw`
 * handlers in the order the server sends them on a control transfer: `resize`,
 * then `redraw`. The child's tty is read from OUTSIDE the system under test
 * (`stty -F` on its pts), and the child counts its own SIGWINCHes.
 *
 * The invariant, after every step: child tty == the daemon's last report ==
 * what a bind would carry. And a redraw never signals the child.
 *
 * ARMED against the two ways it was broken:
 * - the redraw nudge (shrink one row, restore on the next frame, from the
 *   last ACKNOWLEDGED size): on the base the child ended at 80x24 while the
 *   daemon reported 122x39 — the live PDM-107-D pair;
 * - a report written from the ask ("dispatch = applied"): the refused-ask case
 *   would report a size the child never got.
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
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testSessions } from '../session/testing.js'
import { forgetSessionScreen } from '../session-screens'
import type { DaemonContext } from './context'
import { sessionHandlers, sessionSize, wireBridge } from './session'

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

/**
 * A TUI stand-in that reports on itself: its birth size, every SIGWINCH with a
 * counter (so a repeated line is never mistaken for a new signal), and every
 * input byte it receives.
 */
const FIXTURE = `
const sz = () => { const [c, r] = process.stdout.getWindowSize(); return c + 'x' + r }
let n = 0
process.stdout.write('BORN ' + sz() + '\\n')
process.on('SIGWINCH', () => { n += 1; process.stdout.write('WINCH#' + n + ' ' + sz() + '\\n') })
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => process.stdout.write('IN ' + d.toString('hex') + '\\n'))
setInterval(() => {}, 3600_000)
`

const keys = [
  'PODIUM_HOST_SOCKET_DIR',
  'PODIUM_STATE_DIR',
  'PODIUM_NO_SCOPE',
  'PODIUM_HOST_BIN',
] as const
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
  writeFileSync(fixture, FIXTURE)
}, 120_000)

afterAll(() => {
  keys.forEach((k, i) => {
    const v = saved[i]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  })
  resolveHostBin({ fresh: true })
  if (root) rmSync(root, { recursive: true, force: true })
}, 120_000)

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

interface Harness {
  ctx: DaemonContext
  sent: DaemonMessage[]
  /** Everything the session printed, as the daemon relayed it. */
  output: () => string
}

function daemonContext(): Harness {
  const sent: DaemonMessage[] = []
  let out = ''
  const ctx = {
    backend: 'host',
    settingsDir: join(root, 'settings'),
    sessions: testSessions(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: {
      enqueue: (_id: SessionId, data: Uint8Array) => {
        out += Buffer.from(data).toString('latin1')
      },
      remove: () => {},
      flushNow: () => {},
      priorityOf: () => 1,
    },
    observers: { onResize: () => {}, clearSession: () => {} },
    sessionCwdTracker: { clear: () => {} },
    primeInjector: { reset: () => {} },
    send: (msg: DaemonMessage) => sent.push(msg),
  } as unknown as DaemonContext
  return { ctx, sent, output: () => out }
}

function reports(
  sent: DaemonMessage[],
  sessionId: SessionId,
): Array<{ cols: number; rows: number }> {
  return sent.flatMap((m) =>
    m.type === 'geometryApplied' && m.sessionId === sessionId
      ? [{ cols: m.geometry.cols, rows: m.geometry.rows }]
      : [],
  )
}

const winches = (text: string): number => [...text.matchAll(/WINCH#\d+/g)].length

/** The server's control-transfer pair: `resize`, then `redraw`. */
function viewerAsks(ctx: DaemonContext, sessionId: SessionId, cols: number, rows: number): void {
  sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols, rows })
  sessionHandlers.redraw(ctx, { type: 'redraw', sessionId })
}

/**
 * The child tty reaches the size and STAYS there — a transient pass on the way
 * back to an old size is the bug, not a green — and the daemon's last report
 * and a bind both say the same size.
 */
async function settlesAt(
  h: Harness,
  sessionId: SessionId,
  pid: number,
  want: { cols: number; rows: number },
): Promise<void> {
  await expect.poll(() => childTty(pid), { timeout: 15_000 }).toEqual(want)
  await wait(2500)
  expect(childTty(pid)).toEqual(want)
  await expect.poll(() => reports(h.sent, sessionId).at(-1), { timeout: 15_000 }).toEqual(want)
  expect(sessionSize(h.ctx, sessionId)).toEqual(want)
}

function cleanup(h: Harness, sessionId: SessionId): void {
  for (const [, owned] of h.ctx.sessions.entries()) owned.park()
  forgetSessionScreen(h.ctx, sessionId)
}

describe.skipIf(!hasCompiler)('headed sizing on a real podium-host (POD-4723)', () => {
  it('fresh spawn, then viewer asks: child tty == last report == bind size, one SIGWINCH per real change', async () => {
    const sessionId = asSessionId(`hra-${process.pid}-${++serial}`)
    const label = `podium-${sessionId}`
    const h = daemonContext()
    try {
      const attachment = await spawnHostAgent({
        label,
        cmd: process.execPath,
        args: [fixture],
        cols: 80,
        rows: 24,
      })
      wireBridge(h.ctx, sessionId, attachment, 'claude-code', label)
      // WELCOME states the birth size through the size event.
      expect(reports(h.sent, sessionId)).toEqual([{ cols: 80, rows: 24 }])
      await expect.poll(() => h.output(), { timeout: 15_000 }).toContain('BORN 80x24')

      viewerAsks(h.ctx, sessionId, 122, 39)
      await settlesAt(h, sessionId, attachment.pid, { cols: 122, rows: 39 })
      expect(winches(h.output())).toBe(1) // the resize; the redraw signalled nothing

      viewerAsks(h.ctx, sessionId, 122, 38)
      await settlesAt(h, sessionId, attachment.pid, { cols: 122, rows: 38 })
      expect(winches(h.output())).toBe(2)
    } finally {
      cleanup(h, sessionId)
      await killHostSession(label).catch(() => {})
    }
  }, 90_000)

  it('daemon restart re-adopts the live host: the WELCOME size is reported and bound; the next ask lands', async () => {
    const sessionId = asSessionId(`hra-${process.pid}-${++serial}`)
    const label = `podium-${sessionId}`
    const first = daemonContext()
    const h = daemonContext()
    try {
      const born = await spawnHostAgent({
        label,
        cmd: process.execPath,
        args: [fixture],
        cols: 80,
        rows: 24,
      })
      wireBridge(first.ctx, sessionId, born, 'claude-code', label)
      viewerAsks(first.ctx, sessionId, 100, 30)
      await settlesAt(first, sessionId, born.pid, { cols: 100, rows: 30 })
      // The old daemon dies: its surface detaches, the host and child live on.
      cleanup(first, sessionId)

      // The new daemon adopts the live host and reattaches; it resizes nothing.
      const adopted = await spawnHostAgent({
        label,
        cmd: process.execPath,
        args: [fixture],
        cols: 80,
        rows: 24,
      })
      expect(adopted.adopted).toBe(true)
      wireBridge(h.ctx, sessionId, adopted, 'claude-code', label)
      const pid = adopted.pid
      expect(reports(h.sent, sessionId)).toEqual([{ cols: 100, rows: 30 }])
      expect(sessionSize(h.ctx, sessionId)).toEqual({ cols: 100, rows: 30 })
      await wait(1000)
      expect(childTty(pid)).toEqual({ cols: 100, rows: 30 })

      viewerAsks(h.ctx, sessionId, 122, 39)
      await settlesAt(h, sessionId, pid, { cols: 122, rows: 39 })
    } finally {
      cleanup(first, sessionId)
      cleanup(h, sessionId)
      await killHostSession(label).catch(() => {})
    }
  }, 90_000)

  it('a resize the host refuses (lease stolen) is never reported and moves nothing', async () => {
    const sessionId = asSessionId(`hra-${process.pid}-${++serial}`)
    const label = `podium-${sessionId}`
    const h = daemonContext()
    const thief = { conn: undefined as ReturnType<typeof connectHost> | undefined }
    try {
      const attachment = await spawnHostAgent({
        label,
        cmd: process.execPath,
        args: [fixture],
        cols: 80,
        rows: 24,
      })
      wireBridge(h.ctx, sessionId, attachment, 'claude-code', label)
      const before = reports(h.sent, sessionId).length
      // Another writer takes the lease: this daemon's RESIZE now answers ERR NOT_WRITER.
      thief.conn = connectHost(hostSocketPath(label), { mode: 'writer' })
      await thief.conn.welcome
      await thief.conn.steal()

      sessionHandlers.resize(h.ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
      await wait(1000)
      expect(reports(h.sent, sessionId)).toHaveLength(before)
      expect(childTty(attachment.pid)).toEqual({ cols: 80, rows: 24 })
      expect(sessionSize(h.ctx, sessionId)).toEqual({ cols: 80, rows: 24 })
    } finally {
      thief.conn?.detach()
      cleanup(h, sessionId)
      await killHostSession(label).catch(() => {})
    }
  }, 60_000)

  it("a redraw never signals the child; only the user's hard redraw reaches it, as one Ctrl-L", async () => {
    const sessionId = asSessionId(`hra-${process.pid}-${++serial}`)
    const label = `podium-${sessionId}`
    const h = daemonContext()
    try {
      const attachment = await spawnHostAgent({
        label,
        cmd: process.execPath,
        args: [fixture],
        cols: 90,
        rows: 30,
      })
      wireBridge(h.ctx, sessionId, attachment, 'claude-code', label)
      await expect.poll(() => h.output(), { timeout: 15_000 }).toContain('BORN 90x30')

      sessionHandlers.redraw(h.ctx, { type: 'redraw', sessionId })
      sessionHandlers.redraw(h.ctx, { type: 'redraw', sessionId, replayRequired: true })
      await wait(2000)
      expect(winches(h.output())).toBe(0)
      expect(h.output()).not.toContain('IN ')
      expect(childTty(attachment.pid)).toEqual({ cols: 90, rows: 30 })

      sessionHandlers.redraw(h.ctx, { type: 'redraw', sessionId, hard: true })
      await expect.poll(() => h.output(), { timeout: 15_000 }).toContain('IN 0c')
      expect(winches(h.output())).toBe(0)
      expect(childTty(attachment.pid)).toEqual({ cols: 90, rows: 30 })
    } finally {
      cleanup(h, sessionId)
      await killHostSession(label).catch(() => {})
    }
  }, 60_000)
})
