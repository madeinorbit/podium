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
import { mkdtempSync, rmSync } from 'node:fs'
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
import type { AgentSession } from './session.js'
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

function reader(session: AgentSession): { text: () => string } {
  let buf = ''
  session.onFrame((f) => {
    buf += Buffer.from(f.data).toString('utf8')
  })
  return { text: () => buf }
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await wait(20)
  }
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
      const born = await spawnAbducoAgent({
        label: LABEL,
        cmd: process.execPath,
        args: [FIXTURE],
        cols: 80,
        rows: 24,
        backend,
      })
      const bornText = reader(born)
      await waitFor(() => winches(bornText.text()).length > 0)

      // FINDING (not in SPEC-0b): the master's pty is NOT forked at the
      // requested geometry. The child reports some other size at startup, and it
      // is the FIRST ATTACH's resize packet that moves it to what the caller
      // asked for — arriving as a SIGWINCH like any other. So even birth goes
      // through the attach boundary.
      const bornLine = /WINSZ cols=(\d+) rows=(\d+)/.exec(bornText.text())
      expect(bornLine).not.toBeNull()
      expect({ cols: Number(bornLine?.[1]), rows: Number(bornLine?.[2]) }).not.toEqual({
        cols: 80,
        rows: 24,
      })
      expect(winches(bornText.text())[0]).toMatchObject({ n: 1, cols: 80, rows: 24 })

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
      const biggerText = reader(bigger)
      let lastN = 1 // the birth attach's own resize was SIGWINCH#1
      try {
        await waitFor(() => winches(biggerText.text()).some((w) => w.n > lastN))
        const seen = winches(biggerText.text()).filter((w) => w.n > lastN)
        // The child was signalled AGAIN (a strictly higher counter, so this is a
        // new signal and not a replayed line), and its winsize really moved to
        // the attach size.
        expect(seen.at(-1)).toMatchObject({ cols: 120, rows: 40 })
        lastN = seen.at(-1)!.n
        // The daemon-side session reports the size it ASKED for, not one read
        // back from the master — there is no read-back seam at all.
        expect(bigger.geometry()).toEqual({ cols: 120, rows: 40 })
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
      const sameText = reader(same)
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
      const roText = reader(readonly)
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

    it('C16 (abduco half): attachAbducoAgent nudges a repaint by default, and not when told otherwise', async () => {
      const label = `${LABEL}-repaint`
      await killAbducoSession(label)
      const born = await spawnAbducoAgent({
        label,
        cmd: process.execPath,
        args: [FIXTURE],
        cols: 80,
        rows: 24,
        backend,
      })
      try {
        const bornText = reader(born)
        await waitFor(() => bornText.text().includes('WINSZ '))
        born.dispose()
        await wait(300)

        // Default: repaintOnAttach is true, and redraw() is a shrink/restore, so
        // the agent sees MORE signals than the single attach resize would give.
        const nudged = attachAbducoAgent({ label, cols: 80, rows: 24, backend })
        const nudgedText = reader(nudged)
        await waitFor(() => winches(nudgedText.text()).length >= 2, 10_000)
        const nudgedCount = winches(nudgedText.text()).length
        expect(nudgedCount).toBeGreaterThanOrEqual(2)
        nudged.dispose()
        await wait(400)

        // Explicitly off: the attach's own resize packet, and nothing added.
        const quiet = attachAbducoAgent({
          label,
          cols: 80,
          rows: 24,
          backend,
          repaintOnAttach: false,
        })
        const quietText = reader(quiet)
        await waitFor(() => winches(quietText.text()).length >= 1, 10_000)
        await wait(800) // give a nudge time to show up if one were coming
        expect(winches(quietText.text()).length).toBe(1)
        quiet.dispose()
      } finally {
        await killAbducoSession(label)
      }
    }, 120_000)
  },
)
