// Run ONLY under `bun test`. Proves the ADOPTION path for an abduco session an
// older Podium started (POD-4986: nothing creates one any more) — the
// `sh -c 'exec abduco -a'` attach, alt-screen chrome strip, OSC title, input
// round-trip, detach-survive, reattach repaint, kill — works when the attach
// client's PTY is Bun.Terminal, matching the shipped daemon. Each master is
// created the way those releases did, `abduco -n`, with the external legacy fixture in a
// private short ABDUCO_SOCKET_DIR, never the user's own.

import { afterAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  abducoHasSession,
  attachAbducoAgent,
  killAbducoSession,
  reapAbducoTestSessions,
  waitForAbducoSocket,
} from '../../src/abduco'
import { hasLegacyAbduco, legacyAbducoBin } from '../../src/legacy-abduco-fixture'

const FIXTURE = fileURLToPath(new URL('../fixtures/echo-title.mjs', import.meta.url))
const TUI_FIXTURE = fileURLToPath(new URL('../fixtures/fixture-tui.mjs', import.meta.url))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// SHORT on purpose: abduco composes `<dir>/abduco/<user>/<label>@<host>` into a
// 108-byte sun_path. It exists, so abduco never falls through to $HOME/.abduco.
const root = hasLegacyAbduco ? mkdtempSync('/tmp/pab-') : ''
// No compiler, no build: the suite skips (bun:test has no describe.skipIf).
const bin = root ? legacyAbducoBin : undefined
const ENV_KEYS = ['HOME', 'ABDUCO_SOCKET_DIR', 'PODIUM_NO_SCOPE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}
for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
if (bin) {
  process.env.HOME = join(root, 'home')
  process.env.ABDUCO_SOCKET_DIR = root
  process.env.PODIUM_NO_SCOPE = '1'
  }
const d = bin ? describe : describe.skip

// POD-107: the in-test kills sit on the happy path — a failed assertion leaks the
// detached master. Sweep this file's labels for this pid and for dead prior runs.
afterAll(async () => {
  if (bin) await reapAbducoTestSessions([/^podium-abduco-bun(?:-repaint)?-(\d+)$/])
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
    if (root) rmSync(root, { recursive: true, force: true })
})

/**
 * A master created the way an older Podium did, and that release's create
 * attach — not size-neutral, since its resize packet is what moved the program
 * off abduco's own 80x25. Bun's execFileSync ignores mid-process env changes
 * unless handed the env, so it is passed explicitly.
 */
async function createAndAttach(label: string, script: string) {
  execFileSync(bin as string, ['-n', label, process.execPath, script], {
    stdio: 'ignore',
    env: { ...process.env, TERM: 'xterm-256color' },
  })
  const socketPath = await waitForAbducoSocket(label, { ABDUCO_SOCKET_DIR: root })
  return attachAbducoAgent({ label, socketPath, cols: 80, rows: 24 })
}

d('adopting an abduco session [bun-terminal]', () => {
  it('streams frames, surfaces the OSC title, strips chrome, round-trips input, reattaches, kills', async () => {
    const label = `podium-abduco-bun-${process.pid}`
    await killAbducoSession(label)
    const session = await createAndAttach(label, FIXTURE)
    let out = ''
    let title = ''
    session.onFrame((f) => {
      out += Buffer.from(f.data).toString('utf8')
    })
    session.onTitle((t) => {
      title = t
    })
    await wait(900)
    expect(out).toContain('READY') // byte-transparency through the Bun.Terminal attach client
    expect(out).not.toContain('\x1b[?1049h') // the shell produces no alternate-screen bytes
    expect(title).toContain('FIXTURE-TITLE') // OSC title surfaces through the durable chain

    session.write(Buffer.from('hi\r', 'utf8').toString('base64'))
    await wait(600)
    expect(out).toContain('ECHO[6869') // input reached the agent (CR flushes the canonical line)

    // dispose() kills the attach client; the master + agent survive.
    session.dispose()
    await wait(400)
    expect(await abducoHasSession(label)).toBe(true)

    // Reattach via a fresh Bun.Terminal client; prove liveness with a new round-trip.
    const re = attachAbducoAgent({ label, cols: 80, rows: 24 })
    let out2 = ''
    re.onFrame((f) => {
      out2 += Buffer.from(f.data).toString('utf8')
    })
    await wait(600)
    re.write(Buffer.from('yo\r', 'utf8').toString('base64'))
    await wait(600)
    expect(out2).toContain('ECHO[796f')
    expect(out2).not.toContain('\x1b[?1049h')
    re.dispose()

    await killAbducoSession(label)
    await wait(400)
    expect(await abducoHasSession(label)).toBe(false)
  }, 20000)

  it('size-neutral reattach leaves the TUI alone; an explicit viewer resize repaints', async () => {
    // The vendored master SIGWINCHes the program on every resize packet, even
    // one that changes nothing, so a same-size reattach still repaints a TUI.
    const label = `podium-abduco-bun-repaint-${process.pid}`
    await killAbducoSession(label)
    const session = await createAndAttach(label, TUI_FIXTURE)
    await wait(900)
    session.dispose()
    await wait(400)

    const re = attachAbducoAgent({ label, sizeNeutral: true })
    let out = ''
    re.onFrame((f) => {
      out += Buffer.from(f.data).toString('utf8')
    })
    await wait(1400)
    expect(out).toBe('')
    re.resize(120, 40)
    const repaintDeadline = Date.now() + 5000
    while (!out.includes('rows=40') && Date.now() < repaintDeadline) await wait(20)
    expect(out).toContain('PODIUM-FIXTURE')
    expect(out).toContain('rows=40')
    re.dispose()
    await killAbducoSession(label)
  }, 20000)
})
