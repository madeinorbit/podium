/**
 * C14 — THE ATTACH BOUNDARY, EXERCISED FOR REAL (POD-3235, SPEC-0b.md rev 2).
 *
 * The terminal-sizing model (POD-3190 MODEL.md) rests on what abduco actually
 * does to the agent's winsize when a client attaches. Reading the vendored
 * source is not enough — MODEL.md's "accepted residuals" section and stage 2
 * (POD-3238, "attach ≠ resize") both hang on it, so this runs a real vendored
 * abduco with a child that reports its own TIOCGWINSZ and every SIGWINCH.
 *
 * Integration lane (real processes, a C compile, real PTYs); never the unit lane.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  abducoHasSession,
  attachAbducoAgent,
  killAbducoSession,
  spawnAbducoAgent,
} from './abduco.js'
import { buildVendoredAbduco } from './abduco-bin.js'
import { bunTerminalBackend } from './backends/bun-terminal-backend.js'
import { spawnAgent } from './session.js'

const FIXTURE = fileURLToPath(new URL('../test/fixtures/winsize-log.mjs', import.meta.url))
const backend = bunTerminalBackend()
const LABEL = `podium-abduco-winsize-${process.pid}`

let dir = ''
let bin: string | undefined
let savedExplicit: string | undefined

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})

beforeAll(() => {
  if (!hasCompiler) return
  dir = mkdtempSync(join(tmpdir(), 'podium-abduco-winsize-'))
  bin = buildVendoredAbduco(join(dir, 'bin', 'abduco'))
  savedExplicit = process.env.PODIUM_ABDUCO
  if (bin) process.env.PODIUM_ABDUCO = bin
})

afterAll(async () => {
  try {
    await killAbducoSession(LABEL)
  } catch {
    // the session may already be gone; the temp dir sweep below still matters
  }
  if (savedExplicit === undefined) delete process.env.PODIUM_ABDUCO
  else process.env.PODIUM_ABDUCO = savedExplicit
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * What the child itself said, read from its WINSIZE_LOG file rather than the
 * attach stream: an abduco birth signals the child before the caller can
 * subscribe, so the stream alone cannot see the first report (POD-4723 — the
 * deleted repaint nudge used to add a later signal that it could see).
 */
let logSerial = 0
function childLog(): { env: Record<string, string>; text: () => string } {
  const path = join(dir, `winsize-${++logSerial}.log`)
  return {
    env: { WINSIZE_LOG: path },
    text: () => (existsSync(path) ? readFileSync(path, 'utf8') : ''),
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await wait(20)
  }
}

/**
 * The size the child last reported — its startup WINSZ or its latest SIGWINCH
 * line, whichever came last.
 */
function lastSize(text: string): { cols: number; rows: number } | undefined {
  const all = [...text.matchAll(/(?:WINSZ|SIGWINCH#\d+) cols=(\d+) rows=(\d+)/g)]
  const m = all.at(-1)
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : undefined
}

/** Every `SIGWINCH#<n> cols=<c> rows=<r>` line this client has seen, in order. */
function winches(text: string): Array<{ n: number; cols: number; rows: number }> {
  return [...text.matchAll(/SIGWINCH#(\d+) cols=(\d+) rows=(\d+)/g)].map((m) => ({
    n: Number(m[1]),
    cols: Number(m[2]),
    rows: Number(m[3]),
  }))
}

describe.skipIf(!hasCompiler)(
  'C14: what an abduco attach does to the agent (vendored build)',
  () => {
    it('a different-size attach resizes AND signals; a same-size attach signals anyway; a read-only attach signals WITHOUT resizing', async () => {
      expect(bin).toBeDefined()
      await killAbducoSession(LABEL)

      // Birth at 80x24 with a child that reports its own winsize and signals.
      const bornText = childLog()
      const born = await spawnAbducoAgent({
        label: LABEL,
        cmd: process.execPath,
        args: [FIXTURE],
        cols: 80,
        rows: 24,
        env: bornText.env,
        backend,
      })
      // BIRTH ENDS AT THE REQUESTED SIZE. Whether the child sees it as its
      // startup size or as a SIGWINCH is a race with the birth attach's resize
      // packet (a signal that lands before the handler is installed is ignored),
      // so what this pins is the END STATE, from the child's own report.
      await waitFor(() => lastSize(bornText.text())?.cols === 80 && lastSize(bornText.text())?.rows === 24)

      born.dispose()
      await wait(300)
      expect(await abducoHasSession(LABEL)).toBe(true)

      // ---- (a) attach at a DIFFERENT size -------------------------------
      // repaintOnAttach off: the repaint nudge is itself a shrink/restore pair
      // of resizes (C16), which would drown the signal being counted here.
      const bigger = attachAbducoAgent({
        label: LABEL,
        cols: 120,
        rows: 40,
        backend,
        repaintOnAttach: false,
      })
      const biggerText = bornText // the child's own log: nothing it says is missed
      let lastN = winches(bornText.text()).length // 0 or 1: see the birth race above
      try {
        await waitFor(() => winches(biggerText.text()).some((w) => w.n > lastN))
        const seen = winches(biggerText.text()).filter((w) => w.n > lastN)
        // The child was signalled AGAIN (a strictly higher counter, so this is a
        // new signal and not a replayed line), and its winsize really moved to
        // the attach size.
        expect(seen.at(-1)).toMatchObject({ cols: 120, rows: 40 })
        lastN = seen.at(-1)!.n
        // abduco has no read-back seam at all, so the session states no size
        // (POD-4723: a non-host backend reports nothing).
        expect(bigger.size).toBeUndefined()
      } finally {
        bigger.dispose()
      }
      await wait(300)

      // ---- (b) attach at the SAME size ----------------------------------
      const same = attachAbducoAgent({
        label: LABEL,
        cols: 120,
        rows: 40,
        backend,
        repaintOnAttach: false,
      })
      const sameText = bornText
      try {
        // The master `kill(-pid, SIGWINCH)`s on EVERY resize packet, so the agent
        // is signalled even though nothing about its winsize changed. This is
        // the repaint MODEL.md's "daemon restart, process alive" row relies on,
        // and the reason stage 2 cannot make attach silent for free.
        await waitFor(() => winches(sameText.text()).some((w) => w.n > lastN))
        const seen = winches(sameText.text()).filter((w) => w.n > lastN)
        expect(seen.at(-1)).toMatchObject({ cols: 120, rows: 40 }) // unchanged…
        expect(seen.at(-1)!.n).toBeGreaterThan(lastN) // …and signalled AGAIN
        lastN = seen.at(-1)!.n
      } finally {
        same.dispose()
      }
      await wait(300)

      // ---- (c) READ-ONLY attach at yet another size ---------------------
      // CORRECTION TO SPEC-0b C14, which predicted "neither". The vendored
      // server applies TIOCSWINSZ only for a writable head client, but the
      // `kill(-server.pid, SIGWINCH)` on the next line is UNCONDITIONAL
      // (vendor/abduco/server.c: the kill sits outside the readonly guard), so a
      // read-only attach signals the agent while leaving its winsize alone.
      const readonly = spawnAgent(
        {
          cmd: 'sh',
          args: ['-c', `exec ${bin as string} -q -e "$(printf '\\377')" -r -a "$0"`, LABEL],
          cols: 200,
          rows: 60,
        },
        backend,
      )
      const roText = bornText
      try {
        await waitFor(() => winches(roText.text()).some((w) => w.n > lastN))
        const seen = winches(roText.text()).filter((w) => w.n > lastN)
        expect(seen.at(-1)).toMatchObject({ cols: 120, rows: 40 }) // NOT 200x60
        expect(seen.at(-1)!.n).toBeGreaterThan(lastN) // but signalled all the same
      } finally {
        readonly.dispose()
      }

      await killAbducoSession(LABEL)
      await wait(300)
      expect(await abducoHasSession(LABEL)).toBe(false)
    }, 120_000)

    it('T8 (POD-3239): a REQUESTED resize reaches the child’s winsize, and old bytes may follow it', async () => {
      // THE HONEST LABEL, EXERCISED. The daemon reports `geometryApplied` after
      // it DISPATCHES a resize — attach-pty TIOCSWINSZ → SIGWINCH to the abduco
      // client → MSG_RESIZE → master TIOCSWINSZ + SIGWINCH to the agent — and
      // the master forwards bytes it had ALREADY READ after applying it. So a
      // viewer can receive the new W, then a few old-grid bytes, then the
      // agent's repaint. MODEL.md accepts that residual on purpose; this is
      // where it is observed rather than asserted from the source.
      expect(bin).toBeDefined()
      await killAbducoSession(LABEL)

      const text = childLog()
      const born = await spawnAbducoAgent({
        label: LABEL,
        cmd: process.execPath,
        args: [FIXTURE],
        cols: 80,
        rows: 24,
        env: text.env,
        backend,
      })
      await waitFor(() => lastSize(text.text()) !== undefined)
      const before = winches(text.text()).length

      // The resize a viewer's `viewportRequest` becomes, by the time the daemon
      // dispatches it: one call on the live session.
      born.resize(132, 43)

      // IT REACHES THE CHILD'S WINSIZE. Not the attach pty's — the child's own
      // live TIOCGWINSZ, read inside its SIGWINCH handler.
      await waitFor(() => winches(text.text()).length > before)
      const applied = winches(text.text()).at(-1)
      expect(applied).toMatchObject({ cols: 132, rows: 43 })

      // WHAT THE ORDERING LOOKS LIKE FROM HERE. `resize()` returns before the
      // child has been signalled — that is the asynchrony the residual names —
      // so a report emitted synchronously beside this call necessarily precedes
      // the child's repaint, and anything the master had already read from the
      // old grid arrives between the two. The daemon's own half of the ordering
      // (its held output leaves BEFORE the report) is T2, in the unit lane.
      expect(born.size).toBeUndefined()

      born.dispose()
      await wait(200)
      await killAbducoSession(LABEL)
    }, 30_000)

    it('C16 (abduco half, rev 3): an attach never nudges — the attach packet and nothing added (POD-4723)', async () => {
      const label = `${LABEL}-repaint`
      await killAbducoSession(label)
      const log = childLog()
      const born = await spawnAbducoAgent({
        label,
        cmd: process.execPath,
        args: [FIXTURE],
        cols: 80,
        rows: 24,
        env: log.env,
        backend,
      })
      try {
        await waitFor(() => lastSize(log.text()) !== undefined) // running, handler installed
        await wait(300)
        born.dispose()
        await wait(300)
        const before = winches(log.text()).length

        // Default repaintOnAttach: the attach's own resize packet (vendored
        // abduco signals even at the same size) and NOTHING added — the old
        // shrink/restore nudge made it three.
        const again = attachAbducoAgent({ label, cols: 80, rows: 24, backend })
        await waitFor(() => winches(log.text()).length > before, 10_000)
        await wait(1500) // give a nudge time to show up if one were coming
        expect(winches(log.text()).length).toBe(before + 1)
        expect(winches(log.text()).at(-1)).toMatchObject({ cols: 80, rows: 24 })
        again.dispose()
      } finally {
        await killAbducoSession(label)
      }
    }, 120_000)
  },
)
