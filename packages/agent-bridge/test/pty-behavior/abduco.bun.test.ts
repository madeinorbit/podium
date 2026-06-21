// Run ONLY under `bun test`. Proves the DURABLE session path — abduco create +
// `sh -c 'exec abduco -a'` attach, alt-screen chrome strip, OSC title, input
// round-trip, detach-survive, reattach repaint nudge, kill — works when the attach
// client's PTY is Bun.Terminal (not node-pty). This is the real-world path the
// node-pty suite proves in src/abduco.test.ts; here we prove its Bun twin.
//
// Narrow imports (../../src/abduco) keep node:sqlite and the node-pty native addon
// out of the graph.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import {
  abducoHasSession,
  attachAbducoAgent,
  isAbducoAvailable,
  killAbducoSession,
  spawnAbducoAgent,
} from '../../src/abduco'
import { bunTerminalBackend } from '../../src/pty/bun-terminal-backend'

const FIXTURE = fileURLToPath(new URL('../fixtures/echo-title.mjs', import.meta.url))
const TUI_FIXTURE = fileURLToPath(new URL('../fixtures/fixture-tui.mjs', import.meta.url))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const backend = bunTerminalBackend()

// bun:test has no describe.skipIf; pick the variant up front.
const d = isAbducoAvailable() ? describe : describe.skip

d('abduco durable path [bun-terminal]', () => {
  it('streams frames, surfaces the OSC title, strips chrome, round-trips input, reattaches, kills', async () => {
    const label = `podium-abduco-bun-${process.pid}`
    killAbducoSession(label)
    const session = spawnAbducoAgent({ label, cmd: 'node', args: [FIXTURE], cols: 80, rows: 24, backend })
    let out = ''
    let title = ''
    session.onFrame((f) => {
      out += Buffer.from(f.data, 'base64').toString('utf8')
    })
    session.onTitle((t) => {
      title = t
    })
    await wait(900)
    expect(out).toContain('READY') // byte-transparency through the Bun.Terminal attach client
    expect(out).not.toContain('\x1b[?1049h') // attach chrome stripped
    expect(title).toContain('FIXTURE-TITLE') // OSC title surfaces through the durable chain

    session.write(Buffer.from('hi\r', 'utf8').toString('base64'))
    await wait(600)
    expect(out).toContain('ECHO[6869') // input reached the agent (CR flushes the canonical line)

    // dispose() kills the attach client; the master + agent survive.
    session.dispose()
    await wait(400)
    expect(abducoHasSession(label)).toBe(true)

    // Reattach via a fresh Bun.Terminal client; prove liveness with a new round-trip.
    const re = attachAbducoAgent({ label, cols: 80, rows: 24, backend })
    let out2 = ''
    re.onFrame((f) => {
      out2 += Buffer.from(f.data, 'base64').toString('utf8')
    })
    await wait(600)
    re.write(Buffer.from('yo\r', 'utf8').toString('base64'))
    await wait(600)
    expect(out2).toContain('ECHO[796f')
    expect(out2).not.toContain('\x1b[?1049h')
    re.dispose()

    killAbducoSession(label)
    await wait(400)
    expect(abducoHasSession(label)).toBe(false)
  }, 20000)

  it('reattach at UNCHANGED geometry still repaints (the shrink/restore nudge fires)', async () => {
    const label = `podium-abduco-bun-repaint-${process.pid}`
    killAbducoSession(label)
    const session = spawnAbducoAgent({ label, cmd: 'node', args: [TUI_FIXTURE], cols: 80, rows: 24, backend })
    await wait(900)
    session.dispose()
    await wait(400)

    const re = attachAbducoAgent({ label, cols: 80, rows: 24, backend }) // same geometry
    let out = ''
    re.onFrame((f) => {
      out += Buffer.from(f.data, 'base64').toString('utf8')
    })
    await wait(1400)
    expect(out).toContain('PODIUM-FIXTURE') // repainted despite unchanged size
    expect(out).toContain('rows=24')
    re.dispose()
    killAbducoSession(label)
  }, 20000)
})
