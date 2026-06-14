import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  abducoAttachArgv,
  abducoCreateArgv,
  abducoHasSession,
  attachAbducoAgent,
  createAltScreenStripper,
  isAbducoAvailable,
  killAbducoSession,
  parseAbducoList,
  spawnAbducoAgent,
  systemdScopeArgv,
} from './abduco.js'
import { spawnAgent } from './session'

describe('abduco command builders', () => {
  it('builds a direct-argv create command (no shell quoting needed)', () => {
    expect(abducoCreateArgv('podium-1', 'node', ['app.mjs', 'a b'])).toEqual([
      '-n',
      'podium-1',
      'node',
      'app.mjs',
      'a b',
    ])
  })

  it('builds an attach command that remaps the detach key to a raw 0xff via printf', () => {
    const argv = abducoAttachArgv('podium-1')
    expect(argv[0]).toBe('sh')
    expect(argv[1]).toBe('-c')
    // The script must produce the raw byte through printf (node argv would UTF-8
    // encode \xff into 0xC3 0xBF, silently making the detach key 0xC3).
    expect(argv[2]).toContain("printf '\\377'")
    expect(argv[2]).toContain("exec 'abduco'")
    expect(argv[2]).toContain('-q')
    expect(argv[2]).toContain('-a "$0"')
    expect(argv[3]).toBe('podium-1')
  })

  it('shell-quotes a resolved binary path in the attach command', () => {
    const argv = abducoAttachArgv('podium-1', '/home/u/.podium/bin/abduco')
    expect(argv[2]).toContain("exec '/home/u/.podium/bin/abduco'")
  })

  it('wraps the create command in a named transient --user scope (the cgroup that survives redeploy)', () => {
    // The master must land in a sibling cgroup, not the daemon's service cgroup,
    // or `systemctl restart` (KillMode=control-group) takes it down on every redeploy.
    expect(
      systemdScopeArgv('podium-1.scope', ['abduco', ...abducoCreateArgv('podium-1', 'claude')]),
    ).toEqual([
      '--user',
      '--scope',
      '--collect',
      '--quiet',
      '--unit=podium-1.scope',
      '--',
      'abduco',
      '-n',
      'podium-1',
      'claude',
    ])
  })
})

describe('abduco session list parser', () => {
  // State chars per abduco 0.6 source: `+` = app terminated (dead), `*` = a client
  // is currently attached (alive), ` ` = detached and alive.
  const LISTING = [
    'Active sessions (on host podium-host)',
    '+ Thu\t 2026-06-11 09:10:11\t1111\tpodium-dead',
    '* Thu\t 2026-06-11 09:20:22\t2222\tpodium-attached',
    '  Thu\t 2026-06-11 09:30:33\t3333\tpodium-detached',
  ].join('\n')

  it('parses names, pids and liveness; attached (*) is alive, terminated (+) is not', () => {
    expect(parseAbducoList(LISTING)).toEqual([
      { name: 'podium-dead', pid: 1111, alive: false },
      { name: 'podium-attached', pid: 2222, alive: true },
      { name: 'podium-detached', pid: 3333, alive: true },
    ])
  })

  it('handles an empty listing (header only) and blank output', () => {
    expect(parseAbducoList('Active sessions (on host x)\n')).toEqual([])
    expect(parseAbducoList('')).toEqual([])
  })
})

describe('alt-screen chrome stripper', () => {
  const CHROME = '\x1b[?1049h\x1b[H'

  it('strips the exact one-time prefix and passes the rest through', () => {
    const strip = createAltScreenStripper()
    expect(strip(`${CHROME}hello`)).toBe('hello')
    expect(strip(CHROME)).toBe(CHROME) // later occurrences are app output, untouched
  })

  it('strips a prefix split across chunks', () => {
    const strip = createAltScreenStripper()
    expect(strip('\x1b[?10')).toBe('')
    expect(strip('49h\x1b[Hworld')).toBe('world')
  })

  it('flushes held bytes when the stream turns out not to start with the chrome', () => {
    const strip = createAltScreenStripper()
    expect(strip('\x1b[?10')).toBe('')
    expect(strip('25h')).toBe('\x1b[?1025h')
    expect(strip(CHROME)).toBe(CHROME)
  })

  it('passes a chrome-less stream through unchanged', () => {
    const strip = createAltScreenStripper()
    expect(strip('plain')).toBe('plain')
    expect(strip(CHROME)).toBe(CHROME)
  })
})

const hasAbduco = isAbducoAvailable()
const FIXTURE = fileURLToPath(new URL('../test/fixtures/echo-title.mjs', import.meta.url))
const HEX_FIXTURE = fileURLToPath(new URL('../test/fixtures/stdin-hex.mjs', import.meta.url))
const TUI_FIXTURE = fileURLToPath(new URL('../test/fixtures/fixture-tui.mjs', import.meta.url))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hasAbduco)('abduco integration', () => {
  it('streams frames, surfaces the OSC title, round-trips input, survives detach, reattaches, kills', async () => {
    const label = `podium-abduco-itest-${process.pid}`
    killAbducoSession(label)
    const session = spawnAbducoAgent({
      label,
      cmd: 'node',
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })
    let out = ''
    let title = ''
    session.onFrame((f) => {
      out += Buffer.from(f.data, 'base64').toString('utf8')
    })
    session.onTitle((t) => {
      title = t
    })
    await wait(700)
    expect(out).toContain('READY') // byte-transparency
    expect(out).not.toContain('\x1b[?1049h') // client attach chrome stripped
    expect(title).toContain('FIXTURE-TITLE') // OSC passes through verbatim (no tmux set-titles needed)

    session.write(Buffer.from('hi\r', 'utf8').toString('base64'))
    await wait(500)
    expect(out).toContain('ECHO[6869') // input reached the agent (canonical pty: CR flushes the line)

    // dispose() kills the attach client; the abduco master + agent survive.
    session.dispose()
    await wait(300)
    expect(abducoHasSession(label)).toBe(true)

    // Reattach: abduco does not replay history (it SIGWINCHes the app), so prove
    // liveness via a fresh input round-trip rather than a repaint.
    const re = attachAbducoAgent({ label, cols: 80, rows: 24 })
    let out2 = ''
    re.onFrame((f) => {
      out2 += Buffer.from(f.data, 'base64').toString('utf8')
    })
    await wait(500)
    re.write(Buffer.from('yo\r', 'utf8').toString('base64'))
    await wait(500)
    expect(out2).toContain('ECHO[796f')
    expect(out2).not.toContain('\x1b[?1049h')
    re.dispose()

    // explicit kill terminates the agent.
    killAbducoSession(label)
    await wait(300)
    expect(abducoHasSession(label)).toBe(false)
  }, 15000)

  it('reattach at UNCHANGED geometry still repaints (nudge forces a real resize)', async () => {
    // abduco only SIGWINCHes the app on attach; node TUIs (Claude Code included)
    // emit 'resize' — and thus repaint — only when the dimensions actually change.
    // Reattaching at the same size would paint nothing without the shrink/restore
    // nudge. fixture-tui repaints exclusively on resize, so it proves the nudge.
    const label = `podium-abduco-repaint-${process.pid}`
    killAbducoSession(label)
    const session = spawnAbducoAgent({
      label,
      cmd: 'node',
      args: [TUI_FIXTURE],
      cols: 80,
      rows: 24,
    })
    await wait(800)
    session.dispose()
    await wait(300)

    const re = attachAbducoAgent({ label, cols: 80, rows: 24 }) // same geometry
    let out = ''
    re.onFrame((f) => {
      out += Buffer.from(f.data, 'base64').toString('utf8')
    })
    await wait(1200)
    expect(out).toContain('PODIUM-FIXTURE') // repainted despite unchanged size
    expect(out).toContain('rows=24') // and settled back at the requested geometry
    re.dispose()
    killAbducoSession(label)
  }, 15000)
})

describe.skipIf(!hasAbduco)('abduco input-fidelity parity', () => {
  // The byte sequences that matter for agent control — including 0x1c (Ctrl-\),
  // abduco's DEFAULT detach key, which must arrive because we remap it to 0xff.
  const SAMPLES: Record<string, string> = {
    ctrlC: '03',
    ctrlBackslash: '1c',
    altX: '1b78', // ESC + 'x'  (Meta-x)
    upArrow: '1b5b41', // ESC [ A
    utf8: 'c3a9', // 'é'
  }

  async function received(via: 'abduco' | 'direct', hex: string): Promise<string> {
    const bytes = Buffer.from(hex, 'hex')
    let out = ''
    let session: import('./session').AgentSession
    let label = ''
    if (via === 'abduco') {
      label = `podium-abfid-${process.pid}-${hex}`
      killAbducoSession(label)
      session = spawnAbducoAgent({ label, cmd: 'node', args: [HEX_FIXTURE], cols: 80, rows: 24 })
    } else {
      session = spawnAgent({ cmd: 'node', args: [HEX_FIXTURE], cols: 80, rows: 24 })
    }
    session.onFrame((f) => {
      out += Buffer.from(f.data, 'base64').toString('utf8')
    })
    await wait(500)
    session.write(bytes.toString('base64'))
    await wait(500)
    session.dispose()
    if (via === 'abduco') killAbducoSession(label)
    const m = out.match(/<([0-9a-f]*)>/g)
    return (m ?? []).join('')
  }

  for (const [name, hex] of Object.entries(SAMPLES)) {
    it(`delivers ${name} (${hex}) through abduco identically to direct node-pty`, async () => {
      const direct = await received('direct', hex)
      const abduco = await received('abduco', hex)
      expect(direct).toContain(hex) // sanity: direct path delivers the bytes
      expect(abduco).toContain(hex) // PARITY: abduco delivers the same bytes
    }, 15000)
  }
})
