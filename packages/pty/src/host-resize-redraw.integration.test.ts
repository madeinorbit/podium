/**
 * POD-4723 (design rev 3): the host adapter's size is the KERNEL's.
 *
 * `size()` and the `onSize` event are written only by the host's WELCOME and
 * RESIZED, so after any burst of asks they equal the child's real tty — read
 * from OUTSIDE the system under test (`stty -F` on the child's pts) — and a
 * refused ask moves neither. This is the adapter half of the armed base; the
 * daemon half is `apps/daemon/src/control/headed-resize-ack.integration.test.ts`.
 * It must fail with the size written from the ask ("dispatch = applied").
 *
 * The file name is historical: it began as the repro of the redraw nudge that
 * restored a stale size (resize then redraw in one tick left the pty at
 * 80x24). The nudge is deleted; the adapter has no redraw at all.
 *
 * Integration lane (a C compile, real processes, real ptys); never the unit lane.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  connectHost,
  type HostDurableAttachment,
  HostErr,
  hostSocketPath,
  killHostSession,
  spawnHostAgent,
} from './host.js'
import { resolveHostBin } from './host-bin.js'

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

const WINSIZE_FIXTURE = fileURLToPath(new URL('../test/fixtures/winsize-log.mjs', import.meta.url))

let root = ''
const saved: Record<string, string | undefined> = {}
const labels: string[] = []
let serial = 0
const sessions: HostDurableAttachment[] = []

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

function label(tag: string): string {
  // Short: the socket path must fit a unix socket's ~108 bytes.
  const l = `rr-${process.pid}-${tag}-${++serial}`
  labels.push(l)
  return l
}

async function spawn(
  tag: string,
  args: string[],
  cols = 80,
  rows = 24,
): Promise<HostDurableAttachment> {
  const s = await spawnHostAgent({ label: label(tag), cmd: process.execPath, args, cols, rows })
  sessions.push(s)
  await s.ready
  return s
}

beforeAll(() => {
  if (!hasCompiler) return
  root = mkdtempSync(join(tmpdir(), 'pod-rr-'))
  for (const k of [
    'PODIUM_STATE_DIR',
    'PODIUM_HOST_SOCKET_DIR',
    'PODIUM_NO_SCOPE',
    'PODIUM_HOST_BIN',
  ]) {
    saved[k] = process.env[k]
  }
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = join(root, 's')
  process.env.PODIUM_NO_SCOPE = '1'
  delete process.env.PODIUM_HOST_BIN
  resolveHostBin({ fresh: true })
}, 120_000)

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
}, 120_000)

describe.skipIf(!hasCompiler)("podium-host adapter: the size is the kernel's (POD-4723)", () => {
  it('WELCOME states the birth size; a burst of asks ends with size() == the child tty == the last ask', async () => {
    const s = await spawn('burst', [WINSIZE_FIXTURE])
    const events: Array<{ cols: number; rows: number }> = []
    s.onSize?.((g) => events.push({ ...g }))
    expect(s.size?.()).toEqual({ cols: 80, rows: 24 })
    expect(childTty(s.pid)).toEqual({ cols: 80, rows: 24 })

    // Back to back in one tick, exactly as a control transfer arrives.
    void s.resize(122, 39)
    void s.resize(122, 39)
    void s.resize(122, 38)
    await expect.poll(() => events.length, { timeout: 15_000 }).toBe(3)
    expect(events).toEqual([
      { cols: 122, rows: 39 },
      { cols: 122, rows: 39 },
      { cols: 122, rows: 38 },
    ])
    await wait(1500)
    expect(s.size?.()).toEqual({ cols: 122, rows: 38 })
    expect(childTty(s.pid)).toEqual({ cols: 122, rows: 38 })
  }, 30_000)

  it('a refused ask rejects with the host error and moves nothing', async () => {
    const s = await spawn('refused', [WINSIZE_FIXTURE])
    const events: Array<{ cols: number; rows: number }> = []
    s.onSize?.((g) => events.push({ ...g }))
    const thief = connectHost(hostSocketPath(labels.at(-1) as string), { mode: 'writer' })
    try {
      await thief.welcome
      await thief.steal()
      await expect(s.resize(122, 39)).rejects.toMatchObject({ code: HostErr.NOT_WRITER })
      await wait(500)
      expect(events).toEqual([])
      expect(s.size?.()).toEqual({ cols: 80, rows: 24 })
      expect(childTty(s.pid)).toEqual({ cols: 80, rows: 24 })
    } finally {
      thief.detach()
    }
  }, 30_000)
})
