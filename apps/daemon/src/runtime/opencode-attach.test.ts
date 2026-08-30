/**
 * THE CLIENT TERMINAL FOR A SERVER-FAMILY SESSION (POD-2059).
 *
 * Everything here is the daemon's half of `attach()`: which process runs, under
 * which label, with the secret where, whose memory it counts against, and when
 * the warm window closes. The DRIVER's half — that the endpoint is the `client`
 * variant its capability declares — is proved by the conformance corpus in
 * `packages/agent-runtime`, against a real listener.
 *
 * No abduco and no systemd are started: every process port is injected. What is
 * NOT faked is `attributeMemory`, because the label rule below is only true if
 * the real attribution function says so.
 */

import type { SessionBinding } from '@podium/agent-runtime'
import { STRIPPED_CODEX_CREDENTIALS } from '@podium/agent-runtime'
import { AGENT_MANIFESTS, CLIENT_TERMINAL_HARNESSES, clientTerminalFor } from '@podium/harness'
import { BUILTIN_HARNESS_KINDS } from '@podium/protocol'
import type { AgentFrame, AgentSession } from '@podium/pty'
import { asSessionId, type SessionId } from '@podium/model'
import { scopeUnitName } from '@podium/pty'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attributeMemory, type ProcSample } from '../memory-breakdown'
import {
  type ClientTerminalKind,
  clientTerminalLabel,
  codexAttachLabel,
  createOpencodeClientTerminals,
  CLIENT_TERMINAL_INPUT_MAX_BYTES,
  CLIENT_TERMINAL_INPUT_MAX_MESSAGES,
  grokAttachLabel,
  opencodeAttachLabel,
  WARM_TTL_MS,
} from './opencode-attach'
import { createOpencodeHost, opencodeScopeLabel, STRIPPED_PROVIDER_KEYS } from './opencode-server'
import type { OpencodeJournal, OpencodeJournalEntry } from '@podium/agent-runtime'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')
const SECRET = 'e2d1c0ffee5eba11deadbeefcafef00dfeedfacefeedfacefeedfacefeedface'

const URL = 'http://127.0.0.1:41234'

const target = {
  kind: 'opencode',
  conversation: 'ses_abc123',
  endpoint: { address: URL, username: 'podium', secret: SECRET },
  workdir: '/home/agent/work',
} as const

/** A stand-in for the abduco client PTY: records what was wired to it. */
function fakeClient(
  redrawFrame?: string,
  subscribeFrame?: string,
  attachReady = true,
): AgentSession & {
  emit(data: string): void
  disposed: boolean
  writes: string[]
  sizes: { cols: number; rows: number }[]
  redraws: number
  markAttachReady(): void
} {
  const frameCbs: ((f: AgentFrame) => void)[] = []
  let seq = 0
  let pendingReadyRedraw = false

  const client = {
    pid: 4242,
    disposed: false,
    writes: [] as string[],
    sizes: [] as { cols: number; rows: number }[],
    redraws: 0,
    onFrame(cb: (f: AgentFrame) => void) {
      frameCbs.push(cb)
      if (subscribeFrame) client.emit(subscribeFrame)
      return () => {}
    },
    onTitle() {
      return () => {}
    },
    onExit() {
      return () => {}
    },
    write(data: string) {
      client.writes.push(data)
    },
    writeBytes(data: Uint8Array) {
      client.writes.push(Buffer.from(data).toString('utf8'))
    },
    resize(cols: number, rows: number) {
      client.sizes.push({ cols, rows })
    },
    redraw() {
      client.redraws += 1
      if (redrawFrame) client.emit(redrawFrame)
    },
    geometry: () => ({ cols: 120, rows: 40 }),
    redrawWhenReady() {
      if (attachReady) client.redraw()
      else pendingReadyRedraw = true
    },
    markAttachReady() {
      attachReady = true
      if (!pendingReadyRedraw) return
      pendingReadyRedraw = false
      client.redraw()
    },
    dispose() {
      client.disposed = true
    },
    emit(data: string) {
      for (const cb of frameCbs) cb({ seq: seq++, data: Buffer.from(data, 'latin1') })
    },
  }
  return client
}

interface HarnessOptions {
  hasMaster?: (label: string) => boolean
  /**
   * What the SPAWN reports: it found a live master owning the label and attached
   * to that instead of creating one. This — not `hasMaster` — is what decides the
   * generation reset, so the adopted rows below must drive it here.
   */
  adopted?: boolean
  redrawFrame?: string
  subscribeFrame?: string
  /** Browser/replay history already owned by a master that survived the daemon. */
  priorFrames?: { streamId: string; data: Uint8Array }[]
  spawnError?: Error
}

interface Harness {
  spawns: {
    label: string
    cmd: string
    args: string[]
    env?: Record<string, string>
    stripEnv?: readonly string[]
    preserveReplayOnAdopt?: boolean
  }[]
  reclaimed: string[]
  released: string[]
  frames: { streamId: string; data: Uint8Array }[]
  clients: ReturnType<typeof fakeClient>[]
  fire(): void
  armed: number
  cleared: number
}

function harness(opts: HarnessOptions = {}) {
  const state: Harness = {
    spawns: [],
    reclaimed: [],
    released: [],
    frames: [...(opts.priorFrames ?? [])],
    clients: [],
    armed: 0,
    cleared: 0,
    fire: () => {},
  }
  const terminals = createOpencodeClientTerminals({
    frames: (streamId, data) => state.frames.push({ streamId, data }),
    releaseStream: (streamId) => state.released.push(streamId),
    spawn: async (o) => {
      state.spawns.push({
        label: o.label,
        cmd: o.cmd,
        args: o.args ?? [],
        ...(o.env ? { env: o.env } : {}),
        ...(o.stripEnv ? { stripEnv: o.stripEnv } : {}),
        ...(o.preserveReplayOnAdopt ? { preserveReplayOnAdopt: true } : {}),
      })
      if (opts.spawnError) throw opts.spawnError
      const client = fakeClient(opts.redrawFrame, opts.subscribeFrame)
      state.clients.push(client)
      return opts.adopted ? { ...client, adopted: true } : client
    },
    reclaim: async (label) => {
      state.reclaimed.push(label)
    },
    hasMaster: opts.hasMaster ?? (() => false),
    setTimer: (fn) => {
      state.armed += 1
      state.fire = fn
      return state.armed
    },
    clearTimer: () => {
      state.cleared += 1
    },
  })
  return { terminals, state }
}

describe('the client terminal a server-family attach produces', () => {
  it("runs opencode's OWN client against this session's server and conversation", async () => {
    const { terminals, state } = harness()
    const endpoint = await terminals.attach({ sessionId: SESSION, target })

    expect(state.spawns).toHaveLength(1)
    const spawn = state.spawns[0] as NonNullable<(typeof state.spawns)[number]>
    expect(spawn.cmd).toBe('opencode')
    // `--session` is what makes this an ATTACH: without it the TUI opens a
    // different conversation on the same server.
    expect(spawn.args).toEqual(['attach', URL, '--session', 'ses_abc123'])
    expect(endpoint.warmTtlMs).toBe(WARM_TTL_MS)
  })

  it('puts it in a scope SIBLING to the session’s, never inside or under it', () => {
    const sessionLabel = opencodeScopeLabel(SESSION)
    const attachLabel = opencodeAttachLabel(SESSION)
    // Two distinct units, so either can be reclaimed without touching the other.
    expect(scopeUnitName(attachLabel)).not.toBe(scopeUnitName(sessionLabel))
    // And NEITHER label contains the other. Every consumer of these labels does
    // substring work — memory attribution most of all (below).
    expect(attachLabel).not.toContain(sessionLabel)
    expect(sessionLabel).not.toContain(attachLabel)
  })

  it('strips the provider keys the serve half strips, rather than half of them', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    const spawn = state.spawns[0] as NonNullable<(typeof state.spawns)[number]>
    // REMOVED, not blanked: an empty ANTHROPIC_API_KEY is still a set one, and
    // the point is that the client resolves as if the daemon never carried it.
    expect(spawn.stripEnv).toEqual(STRIPPED_PROVIDER_KEYS)
    expect(spawn.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('keeps the secret OUT of argv, exactly as the server it connects to does', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    const spawn = state.spawns[0] as NonNullable<(typeof state.spawns)[number]>
    expect(JSON.stringify(spawn.args)).not.toContain(SECRET)
    expect(spawn.env?.OPENCODE_SERVER_PASSWORD).toBe(SECRET)
    expect(spawn.env?.OPENCODE_SERVER_USERNAME).toBe('podium')
  })

  /**
   * THE RULE WITH TEETH (spec §5). Run against the REAL attribution function,
   * because the failure it guards is a substring match: name the attachment
   * `podium-oc-<id>-attach` and the agent's memory number silently swallows the
   * whole client TUI.
   */
  it('NEVER lets the client’s memory count against the agent’s budget', () => {
    const sessionLabel = opencodeScopeLabel(SESSION)
    const attachLabel = opencodeAttachLabel(SESSION)
    const procs: ProcSample[] = [
      {
        pid: 100,
        ppid: 1,
        name: 'opencode',
        cmdline: `systemd-run --user --scope --unit=${scopeUnitName(sessionLabel)} -- opencode serve --port 41234`,
        memBytes: 300_000_000,
      },
      {
        pid: 200,
        ppid: 1,
        name: 'abduco',
        cmdline: `systemd-run --user --scope --unit=${scopeUnitName(attachLabel)} -- abduco -n ${attachLabel} opencode attach http://127.0.0.1:41234`,
        memBytes: 90_000_000,
      },
      // The TUI itself, a child of the attachment's master.
      { pid: 201, ppid: 200, name: 'opencode', cmdline: 'opencode attach', memBytes: 120_000_000 },
    ]

    const { agents } = attributeMemory(
      procs,
      [{ sessionId: SESSION, label: sessionLabel, pid: 100 }],
      [],
    )
    expect(agents).toEqual([{ sessionId: SESSION, bytes: 300_000_000, processCount: 1 }])
  })

  it('streams the client’s frames on the daemon’s own relay, under the minted stream id', async () => {
    const { terminals, state } = harness()
    const endpoint = await terminals.attach({ sessionId: SESSION, target })
    state.clients[0]?.emit('frame')
    // The generation reset leads every client's output — see the cold-start rows.
    expect(
      state.frames.filter((frame) => Buffer.from(frame.data).toString('latin1') === 'frame'),
    ).toEqual([{ streamId: endpoint.streamId, data: Buffer.from('frame', 'latin1') }])
    expect(state.frames.every((frame) => frame.streamId === endpoint.streamId)).toBe(true)
    expect(endpoint.streamId).toBe(SESSION)
  })

  /**
   * POD-2761. Leaving Native closes the client terminal for EVERY server-family
   * harness, so returning to it is always a cold start that repaints the whole
   * interface. The browser terminal is addressed by session, not by attachment,
   * so that paint lands in a view the previous generation already wrote to.
   *
   * The rows below pin the two things that make the reset an anchor rather than
   * a decoration: it precedes the generation it introduces, and it takes the
   * scrollback as well as the screen.
   */
  it('clears the screen and scrollback BEFORE a cold-started client can paint', async () => {
    const paint = 'paint'
    const { terminals, state } = harness({ subscribeFrame: paint })
    await terminals.attach({ sessionId: SESSION, target })
    const decoded = state.frames.map((frame) => Buffer.from(frame.data).toString('latin1'))
    expect(decoded[0]).toContain('\x1b[2J')
    expect(decoded[0]).toContain('\x1b[3J')
    expect(decoded.indexOf('paint')).toBeGreaterThan(0)
  })

  it('does not clear the terminal when the client spawn is refused', async () => {
    const { terminals, state } = harness({ spawnError: new Error('spawn refused') })

    await expect(terminals.attach({ sessionId: SESSION, target })).rejects.toThrow('spawn refused')

    expect(state.frames).toEqual([])
  })

  it('clears buffered input when client launch fails', async () => {
    let failSpawn: ((error: Error) => void) | undefined
    const spawned = new Promise<AgentSession>((_resolve, reject) => {
      failSpawn = reject
    })
    const terminals = createOpencodeClientTerminals({
      frames: () => {},
      spawn: async () => spawned,
      reclaim: async () => {},
      hasMaster: () => false,
      setTimer: () => 1,
      clearTimer: () => {},
    })
    const attaching = terminals.attach({ sessionId: SESSION, target })

    expect(terminals.input(SESSION, Buffer.from('do not replay'))).toBe(true)
    failSpawn?.(new Error('launch failed'))
    await expect(attaching).rejects.toThrow('launch failed')
    expect(terminals.input(SESSION, Buffer.from('after failure'))).toBe(false)
  })

  it('re-anchors on EVERY generation, which is the one the duplicate came from', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    state.clients[0]?.emit('first')
    await terminals.close(SESSION)
    await terminals.attach({ sessionId: SESSION, target })
    state.clients[1]?.emit('second')
    const decoded = state.frames.map((frame) => Buffer.from(frame.data).toString('latin1'))
    const resets = decoded.filter((data) => data.includes('\x1b[2J') && data.includes('\x1b[3J'))
    expect(resets).toHaveLength(2)
    // The second client's paint follows the second reset, so nothing of the first
    // generation survives in front of it.
    expect(decoded.lastIndexOf(resets[1] as string)).toBeLessThan(decoded.indexOf('second'))
    expect(decoded.indexOf('first')).toBeLessThan(decoded.lastIndexOf(resets[1] as string))
  })

  /**
   * The adopted rows exercise the shared client-terminal seam, not identical
   * production recovery paths for all three families. Only OpenCode server
   * adoption calls `clientTerminals.adopt()` before a viewer attaches. Codex
   * and Grok restore their server handles without pre-adopting this record; a
   * later `attach()` finds and reconnects their durable client master instead.
   */
  it.each([
    ['opencode', 'cold', target, 'opencode', false],
    [
      'codex',
      'cold',
      {
        kind: 'codex' as const,
        conversation: 'thread-paint',
        endpoint: { address: 'unix:///instance/runtime/codex-paint.sock' },
        workdir: '/work/codex',
      },
      'codex',
      false,
    ],
    [
      'grok',
      'cold',
      { kind: 'grok' as const, conversation: 'grok-paint', endpoint: {}, workdir: '/work/grok' },
      'grok',
      false,
    ],
    ['opencode', 'adopted', target, 'opencode', true],
    [
      'codex',
      'adopted',
      {
        kind: 'codex' as const,
        conversation: 'thread-paint',
        endpoint: { address: 'unix:///instance/runtime/codex-paint.sock' },
        workdir: '/work/codex',
      },
      'codex',
      true,
    ],
    [
      'grok',
      'adopted',
      { kind: 'grok' as const, conversation: 'grok-paint', endpoint: {}, workdir: '/work/grok' },
      'grok',
      true,
    ],
  ] as const)('%s %s client anchors only new generations before initial paint', async (_harnessKind, _startKind, paintTarget, clientKind, adopted) => {
    const initialPaint = '\x1b[2Jopencode ready'
    const priorHistory = 'older scrollback'
    const { terminals, state } = harness({
      redrawFrame: initialPaint,
      // `hasMaster` seeds `adopt()`, which holds no session and must still probe
      // by label. `adopted` is what the spawn reports, and it is what the reset
      // is decided on.
      hasMaster: () => adopted,
      adopted,
      priorFrames: adopted
        ? [{ streamId: SESSION, data: Buffer.from(priorHistory, 'latin1') }]
        : [],
    })

    if (adopted) {
      terminals.adopt(SESSION, clientKind)
      // Prove this is an adopted record BEFORE attach can create the same
      // observable client through the cold path.
      expect(state.spawns).toHaveLength(0)
      expect(state.armed).toBe(1)
      expect(terminals.reclaimable()).toBe(1)
    }

    const endpoint = await terminals.attach({ sessionId: SESSION, target: paintTarget })

    // The old fixture began with an empty stream, so it could bless a reset on
    // adoption. This one carries the surviving master's prior history. A cold
    // client gets a reset before its first observable paint; an adopted
    // master already owns a running TUI and browser history, so attach emits no
    // destructive redraw at all.
    const decoded = state.frames.map((frame) => Buffer.from(frame.data).toString('latin1'))
    const resets = decoded.filter((data) => data.includes('\x1b[2J') && data.includes('\x1b[3J'))
    expect(resets).toHaveLength(adopted ? 0 : 1)
    if (adopted) {
      expect(decoded[0]).toBe('older scrollback')
      expect(decoded).toEqual(['older scrollback'])
    } else {
      expect(decoded[0]).toContain('\x1b[3J')
      expect(decoded.at(-1)).toBe(initialPaint)
    }
    expect(state.frames.every((frame) => frame.streamId === endpoint.streamId)).toBe(true)
    // Mutation tooth: an unconditional attach-time redraw appends the TUI's
    // viewport-clearing repaint and destroys the surviving Native content.
    expect(state.clients[0]?.redraws).toBe(adopted ? 0 : 1)
  })

  /**
   * THE CONFIGURATION NO FIXTURE COULD REPRESENT (POD-2761).
   *
   * The reset used to be decided by `hasMaster`, sampled before the spawn. In
   * PRODUCTION nothing passes that port, so the default ran — and the default
   * probed the DAEMON's `HOME` for a master created under the agent home. The
   * two rows below are the two ways that answer is wrong, and neither could be
   * written while the fixture drove the same port the discriminator read: the
   * fake was always self-consistent, so the divergence had nowhere to appear.
   */
  it('acknowledges one browser replay redraw after daemon adoption without repainting', async () => {
    const priorHistory = 'older scrollback'
    const { terminals, state } = harness({
      redrawFrame: '\x1b[2Jcodex ready',
      hasMaster: () => true,
      adopted: true,
      priorFrames: [{ streamId: SESSION, data: Buffer.from(priorHistory, 'latin1') }],
    })

    terminals.adopt(SESSION)
    await terminals.attach({ sessionId: SESSION, target })
    // Production PTY adoption suppresses its pre-adoption repaint only when
    // this server-family capability crosses the injected spawn seam.
    expect(state.spawns[0]?.preserveReplayOnAdopt).toBe(true)

    // SessionTerminal performs this nudge after replaying retained bytes to a
    // newly attached browser. Adoption must ACK it without a TUI repaint.
    expect(terminals.redraw(SESSION)).toBe(true)
    expect(state.clients[0]?.redraws).toBe(0)

    const decoded = state.frames.map((frame) => Buffer.from(frame.data).toString('latin1'))
    expect(decoded.filter((data) => data.includes('\x1b[3J'))).toEqual([])
    expect(decoded).toEqual(['older scrollback'])

    // Deleting the fence fails above; leaving it armed forever fails this later
    // explicit redraw.
    expect(terminals.redraw(SESSION)).toBe(true)
    expect(state.clients[0]?.redraws).toBe(1)
  })

  it('repaints an adopted client when a new page has no server replay', async () => {
    const recovered = '\x1b[2Jseed marker from surviving TUI'
    const { terminals, state } = harness({
      redrawFrame: recovered,
      hasMaster: () => true,
      adopted: true,
    })

    terminals.adopt(SESSION)
    // Mutation tooth: the current adoption fence consumes this request and the
    // fresh page remains blank. The request may precede RuntimeDriver.attach,
    // so the obligation must also survive creation of the adopted client handle.
    expect(terminals.redraw(SESSION, true)).toBe(true)
    expect(state.clients).toHaveLength(0)

    await terminals.attach({ sessionId: SESSION, target })
    expect(state.clients[0]?.redraws).toBe(1)
    expect(state.frames.map((frame) => Buffer.from(frame.data).toString('latin1'))).toEqual([
      recovered,
    ])
  })

  it('emits the reset when the spawn CREATED, even though a master existed a moment earlier', async () => {
    // The TOCTOU the old ordering carried: a master alive when the probe ran and
    // gone by the time the spawn landed. The client is then a brand-new TUI
    // generation with no anchor, painting its whole interface below the last
    // one — the duplicated-interface report this issue was opened for.
    const { terminals, state } = harness({
      redrawFrame: '\x1b[2Jcodex ready',
      hasMaster: () => true,
      adopted: false,
    })

    await terminals.attach({ sessionId: SESSION, target })

    const decoded = state.frames.map((frame) => Buffer.from(frame.data).toString('latin1'))
    expect(decoded.filter((data) => data.includes('\x1b[3J'))).toHaveLength(1)
    expect(decoded[0]).toContain('\x1b[3J')
  })

  it('routes browser input, geometry, and redraw back to the attached TUI', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    expect(terminals.input(SESSION, Buffer.from('hello'))).toBe(true)
    expect(terminals.resize(SESSION, 101, 37)).toBe(true)
    expect(terminals.redraw(SESSION)).toBe(true)
    expect(state.clients[0]?.writes).toEqual(['hello'])
    expect(state.clients[0]?.sizes).toEqual([{ cols: 101, rows: 37 }])
    expect(state.clients[0]?.redraws).toBe(2)
    expect(terminals.input(asSessionId('not-attached'), Buffer.from('x'))).toBe(false)
  })

  it('preserves first input that arrives while the visible client is still attaching', async () => {
    let finishSpawn: ((client: AgentSession) => void) | undefined
    const spawned = new Promise<AgentSession>((resolve) => {
      finishSpawn = resolve
    })
    const client = fakeClient()
    const terminals = createOpencodeClientTerminals({
      frames: () => {},
      spawn: async () => spawned,
      reclaim: async () => {},
      hasMaster: () => false,
      setTimer: () => 1,
      clearTimer: () => {},
    })

    const attaching = terminals.attach({ sessionId: SESSION, target })
    // The native request exists and its client is starting, but no writable
    // handle exists yet. This was false, so dispatchInputBytes silently lost
    // the first prompt even though startup output could already be visible.
    expect(terminals.input(SESSION, Buffer.from('first prompt\r'))).toBe(true)
    expect(client.writes).toEqual([])

    finishSpawn?.(client)
    await attaching

    expect(client.writes).toEqual(['first prompt\r'])
  })

  it('drains multiple attaching chunks once in exact order', async () => {
    let finishSpawn: ((client: AgentSession) => void) | undefined
    const spawned = new Promise<AgentSession>((resolve) => {
      finishSpawn = resolve
    })
    const client = fakeClient()
    const terminals = createOpencodeClientTerminals({
      frames: () => {},
      spawn: async () => spawned,
      reclaim: async () => {},
      hasMaster: () => false,
      setTimer: () => 1,
      clearTimer: () => {},
    })
    const attaching = terminals.attach({ sessionId: SESSION, target })

    expect(terminals.input(SESSION, Buffer.from('one'))).toBe(true)
    expect(terminals.input(SESSION, Buffer.from('two'))).toBe(true)
    finishSpawn?.(client)
    await attaching
    expect(terminals.input(SESSION, Buffer.from('three'))).toBe(true)

    expect(client.writes).toEqual(['one', 'two', 'three'])
  })

  it('refuses attaching input atomically at the byte bound', async () => {
    let finishSpawn: ((client: AgentSession) => void) | undefined
    const spawned = new Promise<AgentSession>((resolve) => {
      finishSpawn = resolve
    })
    const client = fakeClient()
    const terminals = createOpencodeClientTerminals({
      frames: () => {},
      spawn: async () => spawned,
      reclaim: async () => {},
      hasMaster: () => false,
      setTimer: () => 1,
      clearTimer: () => {},
    })
    const attaching = terminals.attach({ sessionId: SESSION, target })
    const accepted = Buffer.alloc(CLIENT_TERMINAL_INPUT_MAX_BYTES, 7)

    expect(terminals.input(SESSION, accepted)).toBe(true)
    accepted.fill(9)
    expect(terminals.input(SESSION, Buffer.from('overflow'))).toBe(false)
    finishSpawn?.(client)
    await attaching

    expect(client.writes).toEqual([Buffer.alloc(CLIENT_TERMINAL_INPUT_MAX_BYTES, 7).toString()])
  })

  it('refuses attaching input atomically at the message bound', async () => {
    let finishSpawn: ((client: AgentSession) => void) | undefined
    const spawned = new Promise<AgentSession>((resolve) => {
      finishSpawn = resolve
    })
    const client = fakeClient()
    const terminals = createOpencodeClientTerminals({
      frames: () => {},
      spawn: async () => spawned,
      reclaim: async () => {},
      hasMaster: () => false,
      setTimer: () => 1,
      clearTimer: () => {},
    })
    const attaching = terminals.attach({ sessionId: SESSION, target })

    for (let index = 0; index < CLIENT_TERMINAL_INPUT_MAX_MESSAGES; index += 1) {
      expect(terminals.input(SESSION, Buffer.from(String(index)))).toBe(true)
    }
    expect(terminals.input(SESSION, Buffer.from('overflow'))).toBe(false)
    finishSpawn?.(client)
    await attaching

    expect(client.writes).toEqual(
      Array.from({ length: CLIENT_TERMINAL_INPUT_MAX_MESSAGES }, (_, index) => String(index)),
    )
  })

  /**
   * THE DECLARATION IS WHAT DECIDES (POD-2823).
   *
   * The three rows above pin the argv a reader wants to SEE. These pin the
   * property behind them, derived from the registry, so a fourth server driver
   * is covered by declaring itself rather than by someone remembering to add a
   * row — which is exactly the failure the nine name checks were.
   */
  it('reclaims a parked master for EVERY harness that declares a client terminal', async () => {
    // No attachment record, so the teardown path must probe by label alone. A
    // hand-written list of three names here would silently strand a fourth
    // driver's abduco master until the machine rebooted.
    for (const kind of CLIENT_TERMINAL_HARNESSES) {
      const label = clientTerminalLabel(SESSION, kind)
      expect(label, `${kind} declares a client terminal but has no label`).toBeDefined()
      const { terminals, state } = harness({ hasMaster: (probed) => probed === label })
      await terminals.close(SESSION)
      expect(state.reclaimed, `${kind} parked master was not reclaimed`).toEqual([label])
    }
  })

  it('refuses a harness that declares no client terminal, rather than defaulting', async () => {
    // Claude Code ships no server mode at all, so nothing here could open its
    // conversation. Falling back to another harness's client would run the wrong
    // CLI against the wrong session while LOOKING like the session's screen.
    const noClient = BUILTIN_HARNESS_KINDS.find((kind) => clientTerminalFor(kind) === undefined)
    expect(noClient, 'every builtin harness declares a client terminal').toBeDefined()
    const { terminals, state } = harness()
    await expect(
      terminals.attach({
        sessionId: SESSION,
        target: {
          kind: noClient as ClientTerminalKind,
          conversation: 'whatever',
          endpoint: {},
          workdir: '/work',
        },
      }),
    ).rejects.toThrow(/no client terminal/)
    expect(state.spawns).toEqual([])
  })

  it('strips exactly what each harness declares its client must not inherit', async () => {
    // ONE HOME FOR THE FACT. This used to be a three-way name check unioned with
    // the manifest read that already answered it, and codex's two copies had
    // drifted three variables apart.
    for (const [kind, launchTarget] of [
      ['opencode', target],
      [
        'codex',
        {
          kind: 'codex',
          conversation: 'thread-strip',
          endpoint: { address: 'unix:///instance/runtime/codex-strip.sock' },
          workdir: '/work/codex',
        },
      ],
      ['grok', { kind: 'grok', conversation: 'grok-strip', endpoint: {}, workdir: '/work/grok' }],
    ] as const) {
      const { terminals, state } = harness()
      await terminals.attach({ sessionId: SESSION, target: launchTarget })
      expect(state.spawns[0]?.stripEnv, `${kind} client strip list`).toEqual(
        AGENT_MANIFESTS[kind].inventory.foreignCredentialEnv,
      )
    }
    // And the codex list is the reconciled one, named so a silent narrowing back
    // to the three it used to carry fails here rather than in a billing report.
    expect(AGENT_MANIFESTS.codex.inventory.foreignCredentialEnv).toEqual(STRIPPED_CODEX_CREDENTIALS)
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('OPENAI_BASE_URL')
  })

  it('launches Codex and Grok original resume TUIs under sibling labels', async () => {
    const codex = harness()
    await codex.terminals.attach({
      sessionId: SESSION,
      target: {
        kind: 'codex',
        conversation: 'thread-9',
        endpoint: { address: 'unix:///instance/runtime/codex-9.sock' },
        workdir: '/work/codex',
      },
    })
    expect(codex.state.spawns[0]).toMatchObject({
      label: codexAttachLabel(SESSION),
      cmd: 'codex',
      env: { CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '1' },
      args: [
        'resume',
        '-C',
        '/work/codex',
        'thread-9',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '--remote',
        'unix:///instance/runtime/codex-9.sock',
      ],
    })

    const grok = harness()
    await grok.terminals.attach({
      sessionId: SESSION,
      target: { kind: 'grok', conversation: 'grok-9', endpoint: {}, workdir: '/work/grok' },
    })
    expect(grok.state.spawns[0]).toMatchObject({
      label: grokAttachLabel(SESSION),
      cmd: 'grok',
      args: ['--resume', 'grok-9'],
      stripEnv: ['XAI_API_KEY'],
    })
  })
})

describe('warm-parking', () => {
  it('re-attaches to the SAME client and re-arms the reaper, rather than starting a second', async () => {
    const { terminals, state } = harness()
    const first = await terminals.attach({ sessionId: SESSION, target })
    const second = await terminals.attach({ sessionId: SESSION, target })

    expect(second.streamId).toBe(first.streamId)
    // The whole point of parking: bouncing back is a reconnect, not a cold start.
    expect(state.spawns).toHaveLength(1)
    expect(state.armed).toBe(2)
    expect(state.cleared).toBe(1)
  })

  it('gives ONE screen to a peek and a take-over, because they are the same screen', async () => {
    const { terminals, state } = harness()
    const peek = await terminals.attach({ sessionId: SESSION, target })
    const takeover = await terminals.attach({ sessionId: SESSION, target })
    expect(takeover.streamId).toBe(peek.streamId)
    expect(state.spawns).toHaveLength(1)
  })

  it('starts ONE client for two attaches that race', async () => {
    const { terminals, state } = harness()
    const [a, b] = await Promise.all([
      terminals.attach({ sessionId: SESSION, target }),
      terminals.attach({ sessionId: SESSION, target }),
    ])
    expect(state.spawns).toHaveLength(1)
    expect(a.streamId).toBe(b.streamId)
  })

  it('does not leave a client running when it is closed WHILE it is starting', async () => {
    // The reaper (or a session teardown) landing between the spawn going out and
    // the client coming back. Nothing is tracking that process any more, so it
    // must not be left running with a stream handed out for it.
    let release: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const clients: ReturnType<typeof fakeClient>[] = []
    const reclaimed: string[] = []
    const terminals = createOpencodeClientTerminals({
      frames: () => {},
      spawn: async () => {
        await started
        const client = fakeClient()
        clients.push(client)
        return client
      },
      reclaim: async (label) => {
        reclaimed.push(label)
      },
      hasMaster: () => true,
      setTimer: () => 1,
      clearTimer: () => {},
    })
    const attaching = terminals.attach({ sessionId: SESSION, target })
    expect(terminals.input(SESSION, Buffer.from('stale close input'))).toBe(true)
    await terminals.close(SESSION)
    expect(terminals.input(SESSION, Buffer.from('after close'))).toBe(false)
    release?.()
    await expect(attaching).rejects.toThrow(/closed while it was starting/)
    expect(clients[0]?.disposed).toBe(true)
    expect(clients[0]?.writes).toEqual([])
    expect(reclaimed).toEqual([opencodeAttachLabel(SESSION), opencodeAttachLabel(SESSION)])
  })

  it('never drains a stale completion into a replacement generation', async () => {
    const resolvers: Array<(client: AgentSession) => void> = []
    const clients = [fakeClient(), fakeClient()]
    const terminals = createOpencodeClientTerminals({
      frames: () => {},
      spawn: async () =>
        new Promise<AgentSession>((resolve) => {
          resolvers.push(resolve)
        }),
      reclaim: async () => {},
      hasMaster: () => false,
      setTimer: () => 1,
      clearTimer: () => {},
    })

    const staleAttach = terminals.attach({ sessionId: SESSION, target })
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    expect(terminals.input(SESSION, Buffer.from('stale'))).toBe(true)
    await terminals.close(SESSION)

    const currentAttach = terminals.attach({ sessionId: SESSION, target })
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    expect(terminals.input(SESSION, Buffer.from('current'))).toBe(true)
    resolvers[0]?.(clients[0] as AgentSession)
    await expect(staleAttach).rejects.toThrow(/closed while it was starting/)
    resolvers[1]?.(clients[1] as AgentSession)
    await currentAttach

    expect(clients[0]?.writes).toEqual([])
    expect(clients[1]?.writes).toEqual(['current'])
  })

  /**
   * SWITCHING BACK TO CHAT AND RETURNING (POD-3045).
   *
   * The defect these rows exist for is not visible in any single verb: attach
   * was right, close was right, and the switch made of the two lost the CLI's
   * keyboard. Every switch out of Native reclaimed the abduco master, so every
   * switch back in cold-started `opencode attach` — and that TUI DISCARDS stdin
   * part-way through its own startup, which is exactly when a viewer who has
   * just switched types. Driven against the real binary under abduco, a nonce
   * typed 1.2s and 1.5s after the client PTY appeared never echoed, while the
   * fresh interface painted ~16 KB; the same nonce typed into a client that had
   * been PARKED and reconnected echoed at the same 1.5s, with `adopted` true.
   *
   * So what is pinned here is that a release parks where the harness allows it,
   * that a parked client cannot be typed into, and that the return reconnects
   * rather than restarts.
   */
  const CODEX_TARGET = {
    kind: 'codex',
    conversation: 'thread-9',
    endpoint: { address: '/run/user/1000/codex-9.sock' },
    workdir: '/home/agent/work',
  } as const

  it('parks the opencode client on a switch to Chat, rather than reclaiming its master', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })

    await terminals.release(SESSION)

    // The master is what "warm" means. Reclaiming it here is what forced the
    // cold start whose startup window ate the keystrokes.
    expect(state.reclaimed).toEqual([])
    // The daemon's own handle IS the writer the lease release has to revoke, and
    // dropping it is how a park revokes it without ending the process.
    expect(state.clients[0]?.disposed).toBe(true)
  })

  it('leaves a parked client with no writer at all, which is the lease obligation', async () => {
    const { terminals } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    await terminals.release(SESSION)

    // Not "refuses to type": there is nothing to type into. Same answer for the
    // other two directions, so nothing can drive a parked TUI.
    expect(terminals.input(SESSION, Buffer.from('hello'))).toBe(false)
    expect(terminals.resize(SESSION, 101, 37)).toBe(false)
    expect(terminals.redraw(SESSION)).toBe(false)
  })

  it('repaints the same generation after Chat activity escaped the parked relay', async () => {
    // The second spawn adopts, because the park left the master running. An
    // adopted generation must not be reset: `[3J` would delete the surviving
    // TUI's history from the browser and the replay log both.
    const spawns: string[] = []
    const clients: ReturnType<typeof fakeClient>[] = []
    const frames: { streamId: string; data: Uint8Array }[] = []
    const terminals = createOpencodeClientTerminals({
      frames: (streamId, data) => frames.push({ streamId, data }),
      spawn: async (o) => {
        spawns.push(o.label)
        const client = fakeClient(
          spawns.length === 1 ? undefined : '\x1b[2Jseed marker learned while parked',
          undefined,
          spawns.length === 1,
        )
        clients.push(client)
        // A park leaves the master holding the label, so the NEXT spawn finds it.
        return spawns.length === 1 ? client : { ...client, adopted: true }
      },
      reclaim: async () => {},
      hasMaster: () => false,
      setTimer: () => 1,
      clearTimer: () => {},
    })

    await terminals.attach({ sessionId: SESSION, target })
    await terminals.release(SESSION)
    await terminals.attach({ sessionId: SESSION, target })
    // Mutation tooth: treating every adoption as fully represented by server
    // replay suppresses this redraw and loses provider output produced in Chat.
    expect(clients[1]?.redraws).toBe(0)
    clients[1]?.markAttachReady()

    expect(frames.some((frame) => Buffer.from(frame.data).includes('seed marker'))).toBe(true)

    const resets = frames
      .map((frame) => Buffer.from(frame.data).toString('latin1'))
      .filter((data) => data.includes('\x1b[3J'))
    expect(resets).toHaveLength(1)
    // And the keyboard is back, on the reconnected client rather than the parked one.
    expect(terminals.input(SESSION, Buffer.from('hello'))).toBe(true)
    expect(clients[1]?.writes).toEqual(['hello'])
    expect(clients[0]?.writes).toEqual([])
  })

  it('closes the client of a harness that says its client may not outlive the view', async () => {
    // Codex's stock TUI holds a direct writer to the engine's Unix listener, so
    // dropping the daemon's handle would revoke nothing. Its declaration says
    // so, and this arm honours it — the old unconditional teardown, kept exactly
    // where the obligation is real.
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target: CODEX_TARGET })

    await terminals.release(SESSION)

    expect(state.reclaimed).toEqual([codexAttachLabel(SESSION)])
  })

  it('starts the warm window on the park, so a parked client is not resident forever', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    terminals.viewers(SESSION, false)
    await terminals.release(SESSION)

    state.fire()

    await vi.waitFor(() => expect(state.reclaimed).toEqual([opencodeAttachLabel(SESSION)]))
  })

  it('parks a client that was still STARTING when the viewer switched away', async () => {
    // `record.session` is only set once the spawn returns. Parking around an
    // in-flight start would leave the finished client attached — streaming into
    // a browser that has gone back to Chat, with the writer the release was
    // meant to revoke.
    let release: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const clients: ReturnType<typeof fakeClient>[] = []
    const terminals = createOpencodeClientTerminals({
      frames: () => {},
      spawn: async () => {
        await started
        const client = fakeClient()
        clients.push(client)
        return client
      },
      reclaim: async () => {},
      hasMaster: () => false,
      setTimer: () => 1,
      clearTimer: () => {},
    })

    const attaching = terminals.attach({ sessionId: SESSION, target })
    expect(terminals.input(SESSION, Buffer.from('stale first prompt'))).toBe(true)
    const parking = terminals.release(SESSION)
    expect(terminals.input(SESSION, Buffer.from('after release began'))).toBe(false)
    release?.()
    await expect(attaching).rejects.toThrow(/generation was revoked/)
    await parking

    expect(clients[0]?.disposed).toBe(true)
    expect(clients[0]?.writes).toEqual([])
    expect(terminals.input(SESSION, Buffer.from('hello'))).toBe(false)
  })

  it('does not arm a deleted generation when a pending start rejects during release', async () => {
    let rejectStart: ((reason: Error) => void) | undefined
    const firstStart = new Promise<never>((_resolve, reject) => {
      rejectStart = reject
    })
    const clients: ReturnType<typeof fakeClient>[] = []
    const frames: { streamId: string; data: Uint8Array }[] = []
    let spawnCount = 0
    let armed = 0
    let cleared = 0
    const terminals = createOpencodeClientTerminals({
      frames: (streamId, data) => frames.push({ streamId, data }),
      spawn: async () => {
        spawnCount += 1
        if (spawnCount === 1) return await firstStart
        const client = fakeClient()
        clients.push(client)
        return client
      },
      reclaim: async () => {},
      hasMaster: () => false,
      setTimer: () => ++armed,
      clearTimer: () => {
        cleared += 1
      },
    })

    const attaching = terminals.attach({ sessionId: SESSION, target })
    expect(terminals.input(SESSION, Buffer.from('before release'))).toBe(true)
    const parking = terminals.release(SESSION)
    expect(terminals.input(SESSION, Buffer.from('after release began'))).toBe(false)
    rejectStart?.(new Error('start rejected'))

    await expect(attaching).rejects.toThrow('start rejected')
    await parking
    expect(terminals.reclaimable()).toBe(0)
    expect(terminals.input(SESSION, Buffer.from('after rejection'))).toBe(false)
    expect(armed).toBe(1)
    expect(cleared).toBe(1)
    expect(frames).toEqual([])

    await terminals.attach({ sessionId: SESSION, target })
    expect(spawnCount).toBe(2)
    expect(terminals.input(SESSION, Buffer.from('clean generation'))).toBe(true)
    expect(clients[0]?.writes).toEqual(['clean generation'])
  })

  it('reaps the client when the warm window closes', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    state.fire()
    await vi.waitFor(() => expect(state.reclaimed).toEqual([opencodeAttachLabel(SESSION)]))
    expect(state.clients[0]?.disposed).toBe(true)
  })

  it('adopts a client that outlived the daemon, so it is reaped instead of resident forever', () => {
    const { terminals, state } = harness({ hasMaster: () => true })
    terminals.adopt(SESSION)
    // Adopting starts NOTHING — the master is already running the TUI. It only
    // puts the deadline back under somebody's control.
    expect(state.spawns).toHaveLength(0)
    expect(state.armed).toBe(1)
    state.fire()
    return vi.waitFor(() => expect(state.reclaimed).toEqual([opencodeAttachLabel(SESSION)]))
  })

  it('does not adopt what is not there, and does not fork to find out on teardown', async () => {
    const { terminals, state } = harness({ hasMaster: () => false })
    terminals.adopt(SESSION)
    await terminals.close(SESSION)
    expect(state.armed).toBe(0)
    expect(state.reclaimed).toEqual([])
  })

  /**
   * THE DEFAULT PROBE — THE ONLY ONE PRODUCTION EVER RUNS (POD-2761).
   *
   * Every other test here injects `hasMaster`, so none of them touches the
   * default, and the default was wrong: it read the DAEMON's `HOME` for a master
   * abduco created under the instance agent home. `abducoSocketDirs` falls back
   * to `$HOME/.abduco` only when `ABDUCO_SOCKET_DIR` is unset — which is why a
   * NAMED instance never saw this (`applyInstanceRuntimeEnv` pins that variable
   * on both sides) and an agent home on the default instance did.
   *
   * Driven against the real filesystem and the real `abducoSocketPath`, because
   * a fake socket root is the one thing that cannot pin a bug about which socket
   * root gets read. Only `reclaim` is injected, so nothing forks `abduco`.
   */
  describe('the default master probe, against a real socket directory', () => {
    const realHome = process.env.HOME
    const realSocketDir = process.env.ABDUCO_SOCKET_DIR
    let agentHome: string
    let daemonHome: string

    beforeEach(() => {
      agentHome = mkdtempSync(join(tmpdir(), 'pod2761-agent-home-'))
      daemonHome = mkdtempSync(join(tmpdir(), 'pod2761-daemon-home-'))
      // The EXPOSED configuration is the unpinned one. With ABDUCO_SOCKET_DIR
      // set, both sides resolve one root and `HOME` never enters the answer.
      delete process.env.ABDUCO_SOCKET_DIR
      process.env.HOME = daemonHome
      // A live master, where abduco puts one for a client whose HOME is the
      // agent home. Relative names are stored `<label>@<hostname>`, and a clear
      // group-execute bit is what abduco writes to mean "not terminated".
      const dir = join(agentHome, '.abduco')
      mkdirSync(dir, { recursive: true })
      const socket = join(dir, `${codexAttachLabel(SESSION)}@${hostname()}`)
      writeFileSync(socket, '')
      chmodSync(socket, 0o600)
    })

    afterEach(() => {
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
      if (realSocketDir !== undefined) process.env.ABDUCO_SOCKET_DIR = realSocketDir
      rmSync(agentHome, { recursive: true, force: true })
      rmSync(daemonHome, { recursive: true, force: true })
    })

    function subject(homeDir?: string) {
      const reclaimed: string[] = []
      const terminals = createOpencodeClientTerminals({
        frames: () => {},
        // `hasMaster` is DELIBERATELY not injected here: it is the subject.
        reclaim: async (label) => {
          reclaimed.push(label)
        },
        setTimer: () => 1,
        clearTimer: () => {},
        ...(homeDir ? { homeDir } : {}),
      })
      return { terminals, reclaimed }
    }

    it('reclaims a parked master that lives under the agent home', async () => {
      const { terminals, reclaimed } = subject(agentHome)
      // No attachment record, so teardown has nothing but the label to go on.
      await terminals.close(SESSION)
      expect(reclaimed).toEqual([codexAttachLabel(SESSION)])
    })

    it('adopts that same master back under a deadline', () => {
      const { terminals } = subject(agentHome)
      terminals.adopt(SESSION, 'codex')
      expect(terminals.reclaimable()).toBe(1)
    })

    it('follows homeDir, and is not merely answering yes to everything', async () => {
      // The control that gives the two rows above their direction. With no agent
      // home the daemon's own `HOME` IS the right place to look, and there is no
      // master in it — so the probe must say no. Before the fix both arms said
      // no, and the master leaked while nothing ever adopted it back.
      const { terminals, reclaimed } = subject(undefined)
      await terminals.close(SESSION)
      terminals.adopt(SESSION, 'codex')
      expect(reclaimed).toEqual([])
      expect(terminals.reclaimable()).toBe(0)
    })
  })

  it('holds the warm window OFF while somebody is watching the session', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    expect(state.armed).toBe(1)

    // A viewer opened the session (sessionPriority 0-2). An idle TTL that keeps
    // counting here is a LIFETIME: it would kill the terminal under someone who
    // has been watching it for thirty minutes.
    terminals.viewers(SESSION, true)
    expect(state.cleared).toBe(1)
    expect(state.armed).toBe(1)

    // …and the last viewer leaving starts the window from now.
    terminals.viewers(SESSION, false)
    expect(state.armed).toBe(2)
  })

  /**
   * THE SEEDING BUG THE SECOND ROUND CAUGHT, and the reason the reclaim-first
   * design was accepted at all.
   *
   * `sessionPriority` is sent ONLY ON CHANGE, so a session already on screen when
   * its terminal is attached announces nothing. An attachment that defaulted to
   * unwatched would be armed AND offered to the pressure sweep — closing a
   * terminal somebody is looking at, which is exactly the guarantee that made
   * "attachments first" safe.
   */
  it('is born WATCHED when the viewer arrived before the attachment did', async () => {
    const { terminals, state } = harness()
    terminals.viewers(SESSION, true)

    await terminals.attach({ sessionId: SESSION, target })

    expect(state.armed).toBe(0)
    expect(terminals.reclaimable()).toBe(0)
  })

  it('is born watched on ADOPT too, when a viewer had the session open', () => {
    const { terminals, state } = harness({ hasMaster: () => true })
    terminals.viewers(SESSION, true)

    terminals.adopt(SESSION)

    expect(state.armed).toBe(0)
    expect(terminals.reclaimable()).toBe(0)
  })

  it('is born unwatched once the viewer has left again', async () => {
    const { terminals, state } = harness()
    terminals.viewers(SESSION, true)
    terminals.viewers(SESSION, false)

    await terminals.attach({ sessionId: SESSION, target })

    // Silence about a session nobody has mentioned means nobody is watching —
    // and so does an explicit "the last viewer left".
    expect(state.armed).toBe(1)
    expect(terminals.reclaimable()).toBe(1)
  })

  it('does not re-arm on a repeated viewer signal, so a watched terminal cannot be reaped', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    terminals.viewers(SESSION, true)
    terminals.viewers(SESSION, true)
    terminals.viewers(SESSION, true)
    // The frame arrives on every priority change (focused ↔ visible ↔ attached
    // are all "watched"), so an implementation that re-armed per signal would
    // put a live viewer back on a countdown.
    expect(state.armed).toBe(1)
    expect(state.cleared).toBe(1)
  })

  it('takes the client down with the session it belongs to', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    await terminals.close(SESSION)
    expect(state.clients[0]?.disposed).toBe(true)
    expect(state.reclaimed).toEqual([opencodeAttachLabel(SESSION)])
    // …and the reaper for a closed attachment is disarmed, not left to fire at
    // a session that has since started a new one.
    expect(state.cleared).toBe(1)
  })
})

describe('what a machine can give back under pressure (spec §5)', () => {
  const OTHER = asSessionId('22222222-2222-4222-8222-222222222222')

  it('offers up the terminals nobody is watching, and never the watched one', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    await terminals.attach({ sessionId: OTHER, target })
    expect(terminals.reclaimable()).toBe(2)

    terminals.viewers(SESSION, true)
    // Reclaiming the terminal someone is looking at is not a cheaper trade than
    // parking an idle agent — it is a worse one, so it is not on offer.
    expect(terminals.reclaimable()).toBe(1)

    expect(await terminals.reclaimUnwatched()).toBe(1)
    expect(state.reclaimed).toEqual([opencodeAttachLabel(OTHER)])
    expect(terminals.reclaimable()).toBe(0)

    // …and the watched one is still there, with its window still held off.
    terminals.viewers(SESSION, false)
    expect(terminals.reclaimable()).toBe(1)
  })

  it('frees the relay entry it minted, so attach churn cannot grow the scheduler', async () => {
    const { terminals, state } = harness()
    const endpoint = await terminals.attach({ sessionId: SESSION, target })
    await terminals.close(SESSION)
    expect(state.released).toEqual([endpoint.streamId])
  })
})

// ---------------------------------------------------------------------------
// The host port: when the daemon answers `attach` at all
// ---------------------------------------------------------------------------

const journalEntry = (over: Partial<OpencodeJournalEntry> = {}): OpencodeJournalEntry => ({
  sessionId: SESSION,
  opencodeSessionId: 'ses_abc123' as OpencodeJournalEntry['opencodeSessionId'],
  baseUrl: URL,
  username: 'podium',
  secret: SECRET,
  workdir: target.workdir,
  process: { key: opencodeScopeLabel(SESSION), pid: 100 },
  seq: 3,
  turnEpoch: 1,
  bindingVersion: 1,
  ...over,
})

function memoryJournal(entry?: OpencodeJournalEntry): OpencodeJournal {
  const entries = new Map<SessionId, OpencodeJournalEntry>(entry ? [[entry.sessionId, entry]] : [])
  return {
    read: (sessionId) => entries.get(sessionId),
    write: (e) => {
      entries.set(e.sessionId, e)
    },
    clear: (sessionId) => {
      entries.delete(sessionId)
    },
  }
}

describe('the daemon’s answer to “host a client terminal”', () => {
  it('refuses on a machine that hosts none — an honest per-machine answer', async () => {
    const host = createOpencodeHost({
      resources: () => undefined,
      journal: memoryJournal(journalEntry()),
    })
    expect(
      await host.attachClient({ sessionId: SESSION, url: URL, mode: 'takeover' }),
    ).toBeUndefined()
  })

  it('refuses before the session has a conversation, rather than opening a DIFFERENT one', async () => {
    const { terminals, state } = harness()
    const host = createOpencodeHost({
      resources: () => undefined,
      journal: memoryJournal(),
      clientTerminals: terminals,
    })
    expect(
      await host.attachClient({ sessionId: SESSION, url: URL, mode: 'takeover' }),
    ).toBeUndefined()
    expect(state.spawns).toHaveLength(0)
  })

  it('hands the client the live url and the journalled conversation + credential', async () => {
    const { terminals, state } = harness()
    const host = createOpencodeHost({
      resources: () => undefined,
      journal: memoryJournal(journalEntry()),
      clientTerminals: terminals,
    })
    // A rebind moved the server's port; the DRIVER's url is the current one.
    const endpoint = await host.attachClient({
      sessionId: SESSION,
      url: 'http://127.0.0.1:55555',
      mode: 'takeover',
    })
    expect(endpoint).toEqual({ streamId: expect.any(String), warmTtlMs: WARM_TTL_MS })
    const spawn = state.spawns[0] as NonNullable<(typeof state.spawns)[number]>
    expect(spawn.args).toContain('http://127.0.0.1:55555')
    expect(spawn.env?.OPENCODE_SERVER_PASSWORD).toBe(SECRET)
  })

  it('answers “this machine cannot host one” when the client will not start', async () => {
    const host = createOpencodeHost({
      resources: () => undefined,
      journal: memoryJournal(journalEntry()),
      clientTerminals: {
        attach: async () => {
          throw new Error('abduco unavailable: not installed and the vendored build failed')
        },
        adopt: () => {},
        close: async () => {},
        release: async () => {},
        viewers: () => {},
        input: () => false,
        resize: () => false,
        redraw: () => false,
        reclaimable: () => 0,
        reclaimUnwatched: async () => 0,
      },
    })
    // A throw would surface to the caller as a driver crash; the port's contract
    // is a value.
    expect(
      await host.attachClient({ sessionId: SESSION, url: URL, mode: 'takeover' }),
    ).toBeUndefined()
  })
})

describe('the session’s lifecycle owns its attachment', () => {
  const binding: SessionBinding = {
    sessionId: SESSION,
    driver: 'opencode-server',
    family: 'server',
    harness: 'opencode',
    workdir: target.workdir,
    resume: null,
    process: { key: opencodeScopeLabel(SESSION), pid: 100 },
    bindingVersion: 1,
  }

  const originalFetch = globalThis.fetch

  beforeEach(() => {
    // `adopt()` health-probes the journalled server. The probe is the only thing
    // standing between this test and a network call.
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch
    process.env.PODIUM_NO_SCOPE = '1'
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('re-adopts a surviving client when the daemon rebinds the session', async () => {
    const { terminals, state } = harness({ hasMaster: () => true })
    const host = createOpencodeHost({
      resources: () => undefined,
      journal: memoryJournal(journalEntry()),
      clientTerminals: terminals,
    })
    expect(await host.adopt(binding)).toBeDefined()
    expect(state.armed).toBe(1)
  })

  /**
   * THE BRANCH THE FIRST ROUND MISSED. Every refusal below means this binding
   * has no live server on this machine — and the attachment is in its own scope,
   * so nothing else would ever reap it: the durable census matches labels
   * against session rows and never kills. An orphan here is resident until the
   * machine reboots, in the one case where the client is guaranteed useless.
   */
  it.each([
    ['there is no journal entry', () => memoryJournal()],
    [
      'the entry describes a DIFFERENT incarnation',
      () => memoryJournal(journalEntry({ process: { key: 'podium-oc-someone-else', pid: 7 } })),
    ],
  ])('abandons the client when %s', async (_name, journal) => {
    const { terminals, state } = harness({ hasMaster: () => true })
    const host = createOpencodeHost({
      resources: () => undefined,
      journal: journal(),
      clientTerminals: terminals,
    })
    expect(await host.adopt(binding)).toBeUndefined()
    expect(state.reclaimed).toEqual([opencodeAttachLabel(SESSION)])
  })

  it('abandons the client when the journalled server does not answer', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch
    const { terminals, state } = harness({ hasMaster: () => true })
    const host = createOpencodeHost({
      resources: () => undefined,
      journal: memoryJournal(journalEntry()),
      clientTerminals: terminals,
    })
    expect(await host.adopt(binding)).toBeUndefined()
    expect(state.reclaimed).toEqual([opencodeAttachLabel(SESSION)])
  })

  it('kills the client when the session is killed', async () => {
    const { terminals, state } = harness({ hasMaster: () => true })
    const host = createOpencodeHost({
      resources: () => undefined,
      journal: memoryJournal(journalEntry()),
      clientTerminals: terminals,
    })
    const endpoint = await host.adopt(binding)
    await endpoint?.kill()
    expect(state.reclaimed).toEqual([opencodeAttachLabel(SESSION)])
  })
})
