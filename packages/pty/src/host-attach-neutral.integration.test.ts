/**
 * ATTACH IS NOT A RESIZE — the host half of the matrix (SPEC-6 item 12).
 *
 * `abduco-attach-neutral.integration.test.ts` pins what a client attach does to a
 * running program under abduco, where a `-N` client is what keeps a reconnect
 * silent and the master still signals on every resize packet. The same rows,
 * driven through `spawnHostAgent`/`attachHostAgent` against podium-host, carry
 * the host's STRONGER claims: no attach of any kind reaches the program, and a
 * same-size ask costs zero signals rather than one.
 *
 * Integration lane (a C compile, real processes, real ptys); never the unit lane.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { attachHostAgent, connectHost, hostSocketPath, killHostSession, spawnHostAgent } from './host.js'
import { resolveHostBin } from './host-bin.js'
import type { AgentSession } from './session.js'

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

const FIXTURE_SRC = `
const size = () => {
  const [cols, rows] = process.stdout.getWindowSize?.() ?? [0, 0]
  return \`cols=\${cols} rows=\${rows}\`
}
process.stdout.write(\`WINSZ \${size()}\\n\`)
let n = 0
process.on('SIGWINCH', () => {
  n += 1
  process.stdout.write(\`SIGWINCH#\${n} \${size()}\\n\`)
})
setInterval(() => {}, 3600_000)
`
const CHATTY_FIXTURE_SRC = FIXTURE_SRC.replace(
  'setInterval(() => {}, 3600_000)',
  "setInterval(() => process.stdout.write('.'), 200)",
)

let root = ''
let fixture = ''
let chattyFixture = ''
const saved: Record<string, string | undefined> = {}
const labels: string[] = []
const sessions: AgentSession[] = []

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await wait(20)
  }
}
const signals = (text: string): string[] => text.match(/SIGWINCH#\d+ cols=\d+ rows=\d+/g) ?? []
const startup = (text: string): string =>
  (text.match(/WINSZ (cols=\d+ rows=\d+)/) as RegExpMatchArray)[1] as string

function label(tag: string): string {
  const l = `phn-${process.pid}-${tag}${labels.length}`
  labels.push(l)
  return l
}
function reader(s: AgentSession): { text: () => string } {
  let buf = ''
  s.onFrame((f) => {
    buf += Buffer.from(f.data).toString('utf8')
  })
  return { text: () => buf }
}

/** A witness that never disturbs what it is watching: a reader HELLO from the tail. */
async function observe(l: string): Promise<{ text: () => string; close: () => void }> {
  const c = connectHost(hostSocketPath(l), { mode: 'reader', fromSeq: 0n })
  let buf = ''
  c.onData((_seq, d) => {
    buf += d.toString('utf8')
  })
  await c.welcome
  await waitFor(() => /WINSZ /.test(buf), 'the agent to report its startup size')
  return { text: () => buf, close: () => c.destroy() }
}

beforeAll(() => {
  if (!hasCompiler) return
  root = mkdtempSync(join(tmpdir(), 'phn-'))
  for (const k of ['PODIUM_STATE_DIR', 'PODIUM_HOST_SOCKET_DIR', 'PODIUM_NO_SCOPE', 'PODIUM_HOST_BIN']) {
    saved[k] = process.env[k]
  }
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = join(root, 'sock')
  process.env.PODIUM_NO_SCOPE = '1'
  delete process.env.PODIUM_HOST_BIN
  expect(resolveHostBin({ fresh: true })).toBeDefined()
  fixture = join(root, 'winsize-log.mjs')
  writeFileSync(fixture, FIXTURE_SRC)
  chattyFixture = join(root, 'winsize-log-chatty.mjs')
  writeFileSync(chattyFixture, CHATTY_FIXTURE_SRC)
})

afterEach(async () => {
  for (const s of sessions.splice(0)) s.dispose()
  for (const l of labels.splice(0)) await killHostSession(l)
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resolveHostBin({ fresh: true })
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!hasCompiler)('attach x host matrix (podium-host)', () => {
  it('a writer attach at ANY size: no packet, no signal, no resize — and the size is settable afterwards', async () => {
    const l = label('writer')
    const born = await spawnHostAgent({ label: l, cmd: process.execPath, args: [fixture], cols: 80, rows: 24 })
    sessions.push(born)
    born.dispose() // the lease goes with it
    const o = await observe(l)
    try {
      const startedAt = startup(o.text())
      expect(startedAt).toBe('cols=80 rows=24')
      expect(signals(o.text())).toHaveLength(0)

      // The daemon-shaped attach: HELLO carries no size at all.
      const c = attachHostAgent({ label: l, fromSeq: 'tail' })
      sessions.push(c)
      const w = await c.ready
      expect(w.lease).toBe(true)
      await wait(700)
      expect(signals(o.text())).toHaveLength(0)

      c.resize(133, 44)
      await waitFor(() => signals(o.text()).length > 0, 'the explicit resize to reach the agent')
      expect(signals(o.text()).at(-1)).toContain('cols=133 rows=44')
      expect(signals(o.text())).toHaveLength(1)
      await waitFor(() => c.appliedGeometry?.cols === 133, 'RESIZED to be acknowledged')
      expect(c.appliedGeometry).toEqual({ cols: 133, rows: 44 })
    } finally {
      o.close()
    }
  }, 30000)

  it('a reader attach at another size: neither half happens; the size a viewer set survives a writer that leaves', async () => {
    const l = label('reader')
    const born = await spawnHostAgent({ label: l, cmd: process.execPath, args: [fixture], cols: 80, rows: 24 })
    sessions.push(born)
    const o = await observe(l)
    try {
      born.resize(121, 41)
      await waitFor(() => signals(o.text()).length === 1, 'the head writer to set a size')
      const reader2 = connectHost(hostSocketPath(l), { mode: 'reader' })
      await reader2.welcome
      await wait(500)
      reader2.destroy()
      await wait(300)
      expect(signals(o.text())).toHaveLength(1)

      // The writer goes; nothing asks the program for anything (abduco's master
      // would have asked the next client for ITS size here).
      born.dispose()
      await wait(700)
      expect(signals(o.text())).toHaveLength(1)
      expect(signals(o.text())[0]).toContain('cols=121 rows=41')
    } finally {
      o.close()
    }
  }, 30000)

  it('a reconnect at a stale size neither moves nor signals the agent (spawn adopts the live host)', async () => {
    const l = label('adopt')
    const first = await spawnHostAgent({ label: l, cmd: process.execPath, args: [chattyFixture], cols: 137, rows: 43 })
    sessions.push(first)
    const t = reader(first)
    await waitFor(() => /WINSZ cols=137 rows=43/.test(t.text()), 'the agent to be born at the spawn size', 12000)
    await wait(500)
    const settled = signals(t.text()).length

    // A reconnect whose last-known geometry is WRONG — a stale belief, which is
    // exactly what survives a daemon restart.
    const again = await spawnHostAgent({ label: l, cmd: process.execPath, args: [chattyFixture], cols: 90, rows: 20 })
    sessions.push(again)
    expect(again.adopted).toBe(true)
    // The adopting attach reads the REAL size back; it does not report the belief.
    expect(again.appliedGeometry).toEqual({ cols: 137, rows: 43 })
    await wait(1500)
    expect(signals(t.text())).toHaveLength(settled)
    expect(t.text()).not.toContain('cols=90')
  }, 40000)

  it('the first ask after an attach: for the size the agent already has costs ZERO signals; for a new size exactly one, no reflow', async () => {
    const l = label('ask')
    const born = await spawnHostAgent({ label: l, cmd: process.execPath, args: [fixture], cols: 111, rows: 37 })
    sessions.push(born)
    const o = await observe(l)
    try {
      born.dispose()
      await wait(300)
      const session = attachHostAgent({ label: l, fromSeq: 'tail' })
      sessions.push(session)
      await session.ready
      await wait(500)
      expect(signals(o.text())).toHaveLength(0) // the attach itself: silent

      session.resize(111, 37) // the ask a daemon restart produces: for what the agent already is
      await waitFor(() => session.appliedGeometry?.cols === 111, 'the same-size ask to be acknowledged')
      await wait(600)
      expect(signals(o.text())).toHaveLength(0) // abduco: exactly one; the host: none

      session.resize(112, 38)
      await waitFor(() => signals(o.text()).length > 0, 'the new size to reach the agent')
      await wait(600)
      expect(signals(o.text())).toHaveLength(1)
      expect(signals(o.text())[0]).toContain('cols=112 rows=38')
      expect(o.text()).not.toContain('rows=36') // never a row short
    } finally {
      o.close()
    }
  }, 40000)

  it('the birth size has a producer: a spawned agent starts at the geometry podium asked for, unsignalled', async () => {
    const l = label('birth')
    const s = await spawnHostAgent({ label: l, cmd: process.execPath, args: [fixture], cols: 137, rows: 43 })
    sessions.push(s)
    const t = reader(s)
    await waitFor(() => /WINSZ cols=137 rows=43/.test(t.text()), 'the spawned agent to be born at the requested size', 12000)
    await wait(300)
    // Unlike abduco, whose master forks its pty at 80x25 and whose first attach
    // moves the program, the host forks the pty AT the requested size.
    expect(signals(t.text())).toHaveLength(0)
    expect(s.appliedGeometry).toEqual({ cols: 137, rows: 43 })
  }, 30000)
})
