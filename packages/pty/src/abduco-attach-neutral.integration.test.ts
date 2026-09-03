/**
 * ATTACH IS NOT A RESIZE — the client x master compatibility matrix [spec:SP-6144].
 *
 * abduco's client announces its size the moment it connects, and the master
 * SIGWINCHes the running program on EVERY resize packet, even one that does not
 * change the size and even one from a read-only client (the `kill(-server.pid,
 * SIGWINCH)` sits outside the readonly/head guard in `vendor/abduco/server.c`).
 * So every reconnect repaints the agent, and a stale last-known size re-sizes it
 * wrongly. `-N` removes the announcement.
 *
 * Only the agent can answer whether it was signalled, so this runs real abduco
 * masters with a real child that logs its own TIOCGWINSZ and every SIGWINCH.
 * Both ends are built from the one vendored source: at feature level 1 podium's
 * patch is compiled out (an "old" abduco that rejects -N), at level 2 it is in.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { attachAbducoAgent, killAbducoSession, spawnAbducoAgent } from './abduco.js'
import { ABDUCO_FEATURES, buildVendoredAbduco } from './abduco-bin.js'
import { bunTerminalBackend } from './backends/index.js'
import type { PtyBackend, PtyProcess } from './backends/types.js'

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

const backend = bunTerminalBackend()
let dir = ''
let oldBin = '' // feature level 1: podium's -N patch compiled out
let newBin = '' // feature level 2: the shipped build
let fixture = ''
let chattyFixture = ''
let savedExplicit: string | undefined

/**
 * The only witness that can answer the question: it reports its own live
 * TIOCGWINSZ at startup and on every SIGWINCH, numbered so "signalled again" is
 * distinguishable from "the same line arrived twice".
 */
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

/**
 * The same witness, but talking. The repaint nudge restores the attach pty's size
 * on the child's NEXT FRAME, so a silent child hides the leak that a busy one
 * exposes — which is what makes a reconnect to a working agent the risky case.
 */
const CHATTY_FIXTURE_SRC = FIXTURE_SRC.replace(
  'setInterval(() => {}, 3600_000)',
  "setInterval(() => process.stdout.write('.'), 200)",
)

beforeAll(() => {
  if (!hasCompiler) return
  dir = mkdtempSync(join(tmpdir(), 'podium-attach-neutral-'))
  fixture = join(dir, 'winsize-log.mjs')
  writeFileSync(fixture, FIXTURE_SRC)
  chattyFixture = join(dir, 'winsize-log-chatty.mjs')
  writeFileSync(chattyFixture, CHATTY_FIXTURE_SRC)
  oldBin = buildVendoredAbduco(join(dir, 'old', 'abduco'), { features: 1 }) as string
  newBin = buildVendoredAbduco(join(dir, 'new', 'abduco'), { features: 2 }) as string
  savedExplicit = process.env.PODIUM_ABDUCO
  process.env.PODIUM_ABDUCO = newBin
})

afterAll(() => {
  if (savedExplicit === undefined) delete process.env.PODIUM_ABDUCO
  else process.env.PODIUM_ABDUCO = savedExplicit
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await wait(20)
  }
}

const labels: string[] = []
const clients: PtyProcess[] = []

function createSession(masterBin: string, cols = 0, rows = 0): string {
  const label = `podium-attach-neutral-${process.pid}-${labels.length}`
  labels.push(label)
  // `-n` daemonizes the master and returns. It has no controlling tty, so the
  // master's own pty is forked at abduco's 80x25 default whatever we pass.
  execFileSync(masterBin, ['-n', label, process.execPath, fixture], {
    stdio: 'ignore',
    env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) },
  })
  return label
}

/** Attach a client of a chosen build, and capture what the agent says. */
function attach(
  bin: string,
  label: string,
  cols: number,
  rows: number,
  flags: string[] = [],
): { text: () => string; proc: PtyProcess } {
  const proc = backend.spawn({
    file: 'sh',
    args: ['-c', `exec ${bin} -q ${flags.join(' ')} -a "$0"`, label],
    cols,
    rows,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })
  clients.push(proc)
  let buf = ''
  proc.onData((d) => {
    buf += Buffer.from(d).toString('utf8')
  })
  return { text: () => buf, proc }
}

/** A witness that never disturbs what it is watching: -N, so its own attach is silent. */
async function observe(label: string): Promise<{ text: () => string; proc: PtyProcess }> {
  const o = attach(newBin, label, 100, 30, ['-N'])
  await waitFor(() => /WINSZ /.test(o.text()), 'the agent to report its startup size')
  return o
}

const signals = (text: string): string[] => text.match(/SIGWINCH#\d+ cols=\d+ rows=\d+/g) ?? []
const startup = (text: string): string =>
  (text.match(/WINSZ (cols=\d+ rows=\d+)/) as RegExpMatchArray)[1] as string

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      c.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const l of labels.splice(0)) {
    try {
      await killAbducoSession(l)
    } catch {
      // the master may already have exited
    }
  }
})

describe.skipIf(!hasCompiler)('attach x master compatibility matrix', () => {
  it('the shipped build is the feature level -N needs', () => {
    expect(ABDUCO_FEATURES).toBeGreaterThanOrEqual(2)
    // The "old" end really is old: it does not know -N at all.
    expect(() =>
      execFileSync(oldBin, ['-N', '-a', 'nope'], { stdio: ['ignore', 'ignore', 'ignore'] }),
    ).toThrow()
  })

  for (const [masterName, master] of [
    ['old master', () => oldBin],
    ['new master', () => newBin],
  ] as const) {
    it(`${masterName} + old client: attaching resizes AND signals the agent (today)`, async () => {
      const label = createSession(master())
      const o = await observe(label)
      const born = startup(o.text())
      expect(signals(o.text())).toHaveLength(0)

      attach(master(), label, 121, 41)
      await waitFor(() => signals(o.text()).length > 0, 'the attach to signal the agent')
      expect(signals(o.text())[0]).toContain('cols=121 rows=41')
      expect(born).not.toContain('cols=121')
    }, 30000)

    it(`${masterName} + new client with -N: no packet, no signal, no resize`, async () => {
      const label = createSession(master())
      const o = await observe(label)
      const born = startup(o.text())

      const c = attach(newBin, label, 121, 41, ['-N'])
      await wait(700) // an initial packet, if one were sent, would have landed
      expect(signals(o.text())).toHaveLength(0)

      // ...and the size is still settable afterwards: a viewer asking resizes the
      // attach pty, the client SIGWINCHes, and the master applies and signals.
      c.proc.resize(133, 44)
      await waitFor(() => signals(o.text()).length > 0, 'the explicit resize to reach the agent')
      expect(signals(o.text()).at(-1)).toContain('cols=133 rows=44')
      expect(born).not.toContain('cols=133')
    }, 30000)
  }

  it('a read-only attach signals the agent without resizing it — unless it is -N', async () => {
    const label = createSession(newBin)
    const o = await observe(label)
    const born = startup(o.text())

    // -r alone: the master declines the dimensions (readonly) but SIGWINCHes the
    // agent's process group anyway. This is today's behaviour, and the reason a
    // read-only viewer is not a silent one.
    attach(newBin, label, 121, 41, ['-r'])
    await waitFor(() => signals(o.text()).length > 0, 'the read-only attach to signal the agent')
    expect(signals(o.text())[0]).toContain(born) // signalled, but the size did not move
    const after = signals(o.text()).length

    // -r -N: neither half happens.
    attach(newBin, label, 122, 42, ['-r', '-N'])
    await wait(700)
    expect(signals(o.text())).toHaveLength(after)
  }, 30000)

  it('the size a viewer asked for still survives a client that leaves', async () => {
    // When the head client goes, the master asks the next one for its size. A -N
    // client stays silent, so the agent keeps the size the departing viewer set
    // rather than being moved to a stale attach pty's dimensions.
    const label = createSession(newBin)
    const o = await observe(label)

    const head = attach(newBin, label, 121, 41)
    await waitFor(() => signals(o.text()).length > 0, 'the head client to set a size')
    const settled = signals(o.text()).length
    head.proc.kill('SIGKILL')
    await wait(700)
    expect(signals(o.text())).toHaveLength(settled)
  }, 30000)
})

describe.skipIf(!hasCompiler)('reconnecting to a running agent', () => {
  /**
   * The whole point, end to end through podium's own spawn path: a daemon that
   * comes back believing a size the agent never had must not impose it. Both the
   * attach itself AND the attach-time repaint have to stay off the agent's size —
   * the repaint nudge is a real resize of the attach pty, and the attach client
   * forwards it like any other.
   */
  for (const [name, preserveReplayOnAdopt] of [
    ['with the attach-time repaint', false],
    ['without it', true],
  ] as const) {
    it(`${name}, a reconnect at a stale size neither moves nor signals the agent`, async () => {
      const label = `podium-attach-neutral-adopt-${process.pid}-${preserveReplayOnAdopt}`
      labels.push(label)
      const first = await spawnAbducoAgent({
        label,
        cmd: process.execPath,
        args: [chattyFixture],
        cols: 137,
        rows: 43,
      })
      let buf = ''
      first.onFrame((f) => {
        buf += Buffer.from(f.data).toString('utf8')
      })
      await waitFor(() => /cols=137 rows=43/.test(buf), 'the agent to reach the spawn size', 12000)
      await wait(500)
      const settled = signals(buf).length

      // A reconnect whose last-known geometry is WRONG — a stale belief, which is
      // exactly what survives a daemon restart.
      const again = await spawnAbducoAgent({
        label,
        cmd: process.execPath,
        args: [chattyFixture],
        cols: 90,
        rows: 20,
        preserveReplayOnAdopt,
      })
      expect(again.adopted).toBe(true)
      await wait(1500) // the nudge restores on the agent's next frame; it is chatty

      expect(signals(buf)).toHaveLength(settled)
      expect(buf).not.toContain('cols=90')
      again.dispose()
      first.dispose()
    }, 40000)
  }
})

describe.skipIf(!hasCompiler)('the first ask after a size-neutral attach', () => {
  it('costs exactly one SIGWINCH and no reflow, even when it asks for the size the agent already has', async () => {
    // The case a daemon restart actually produces: the server's last-known size
    // IS the agent's size, so the viewer's first ask asks for exactly that. It
    // must still reach the agent — the master signals on every packet, so the ask
    // is also the repaint — and it must not cost a row of reflow on the way. That
    // is why a size-neutral attach opens its pty at a sentinel rather than at the
    // caller's geometry [spec:SP-6144].
    const label = createSession(newBin)
    labels.push(label)
    const o = await observe(label)

    // Put the agent at a known size the way a viewer would, then let that client go.
    const mover = attach(newBin, label, 111, 37)
    await waitFor(() => signals(o.text()).length > 0, 'the agent to reach a known size')
    expect(signals(o.text()).at(-1)).toContain('cols=111 rows=37')
    mover.proc.kill('SIGKILL')
    await wait(400)
    const settled = signals(o.text()).length

    // The daemon-shaped reattach: size-neutral, carrying the size it believes.
    const session = attachAbducoAgent({ label, cols: 111, rows: 37, sizeNeutral: true })
    try {
      await wait(800)
      expect(signals(o.text())).toHaveLength(settled) // the attach itself: silent

      session.resize(111, 37) // the viewer asks — for what the agent already is
      await waitFor(() => signals(o.text()).length > settled, 'the ask to reach the agent')
      await wait(600) // a shrink-and-restore would land its second signal by now

      expect(signals(o.text())).toHaveLength(settled + 1)
      expect(signals(o.text()).at(-1)).toContain('cols=111 rows=37')
      // Never a row short: no size but the one asked for ever reached the agent.
      expect(o.text()).not.toContain('rows=36')
    } finally {
      session.dispose()
    }
  }, 40000)
})

describe.skipIf(!hasCompiler)('what a size-neutral attach does to its own pty', () => {
  /**
   * The agent-visible half of this is in the test above, but it can only say
   * "one SIGWINCH": abduco's client coalesces resizes behind a flag, so a
   * shrink-and-restore issued back-to-back usually reaches the agent as a single
   * packet at the final size. Usually — the client is a separate process, and if
   * its loop runs between the two, the agent reflows at the short size. The seam
   * is where that race is decided, so pin it here: one ask, one resize.
   */
  it('opens at the sentinel and turns one ask into exactly one resize', () => {
    const resizes: Array<[number, number]> = []
    const proc: PtyProcess = {
      pid: 99,
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: (c, r) => {
        resizes.push([c, r])
      },
      kill: () => {},
    }
    const spawns: Array<{ cols: number; rows: number }> = []
    const backend: PtyBackend = {
      name: 'bun-terminal',
      spawn: (o) => {
        spawns.push({ cols: o.cols, rows: o.rows })
        return proc
      },
    }

    const session = attachAbducoAgent({
      label: 'podium-attach-neutral-seam',
      cols: 111,
      rows: 37,
      sizeNeutral: true,
      backend,
    })
    try {
      // Not the caller's geometry: a size nobody can ask for.
      expect(spawns).toEqual([{ cols: 1, rows: 1 }])
      expect(resizes).toEqual([])

      // The ask a daemon restart produces: for exactly the size the agent is at.
      session.resize(111, 37)
      expect(resizes).toEqual([[111, 37]])
    } finally {
      session.dispose()
    }
  })
})

describe.skipIf(!hasCompiler)('the birth size still has a producer', () => {
  it('a spawned agent starts at the geometry podium asked for', async () => {
    const label = `podium-attach-neutral-birth-${process.pid}`
    labels.push(label)
    const session = await spawnAbducoAgent({
      label,
      cmd: process.execPath,
      args: [fixture],
      cols: 137,
      rows: 43,
    })
    let buf = ''
    session.onFrame((f) => {
      buf += Buffer.from(f.data).toString('utf8')
    })
    // The master's pty is forked at abduco's own default — the CREATE attach's
    // resize packet is what moves the agent to the requested size, so that attach
    // must NOT be size-neutral.
    await waitFor(
      () => /cols=137 rows=43/.test(buf),
      'the spawned agent to reach the requested size',
      12000,
    )
    session.dispose()
  }, 30000)
})
