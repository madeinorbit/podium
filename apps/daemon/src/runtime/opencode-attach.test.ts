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
import type { AgentFrame, AgentSession } from '@podium/pty'
import { asSessionId, type SessionId } from '@podium/model'
import { scopeUnitName } from '@podium/pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attributeMemory, type ProcSample } from '../memory-breakdown'
import {
  codexAttachLabel,
  createOpencodeClientTerminals,
  grokAttachLabel,
  opencodeAttachLabel,
  WARM_TTL_MS,
} from './opencode-attach'
import { createOpencodeHost, opencodeScopeLabel, STRIPPED_PROVIDER_KEYS } from './opencode-server'
import type { OpencodeJournal, OpencodeJournalEntry } from '@podium/agent-runtime'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')
const SECRET = 'e2d1c0ffee5eba11deadbeefcafef00dfeedfacefeedfacefeedfacefeedface'

const target = {
  url: 'http://127.0.0.1:41234',
  username: 'podium',
  secret: SECRET,
  opencodeSessionId: 'ses_abc123',
  workdir: '/home/agent/work',
}

/** A stand-in for the abduco client PTY: records what was wired to it. */
function fakeClient(
  redrawFrame?: string,
  subscribeFrame?: string,
): AgentSession & {
  emit(data: string): void
  disposed: boolean
  writes: string[]
  sizes: { cols: number; rows: number }[]
  redraws: number
} {
  const frameCbs: ((f: AgentFrame) => void)[] = []
  let seq = 0
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
    resize(cols: number, rows: number) {
      client.sizes.push({ cols, rows })
    },
    redraw() {
      client.redraws += 1
      if (redrawFrame) client.emit(redrawFrame)
    },
    geometry: () => ({ cols: 120, rows: 40 }),
    dispose() {
      client.disposed = true
    },
    emit(data: string) {
      for (const cb of frameCbs) cb({ seq: seq++, data })
    },
  }
  return client
}

interface HarnessOptions {
  hasMaster?: (label: string) => boolean
  redrawFrame?: string
  subscribeFrame?: string
  /** Browser/replay history already owned by a master that survived the daemon. */
  priorFrames?: { streamId: string; data: string }[]
  spawnError?: Error
}

interface Harness {
  spawns: {
    label: string
    cmd: string
    args: string[]
    env?: Record<string, string>
    stripEnv?: readonly string[]
  }[]
  reclaimed: string[]
  released: string[]
  frames: { streamId: string; data: string }[]
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
      })
      if (opts.spawnError) throw opts.spawnError
      const client = fakeClient(opts.redrawFrame, opts.subscribeFrame)
      state.clients.push(client)
      return client
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
    expect(spawn.args).toEqual(['attach', target.url, '--session', 'ses_abc123'])
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
    state.clients[0]?.emit('ZnJhbWU=')
    // The generation reset leads every client's output — see the cold-start rows.
    expect(state.frames.filter((frame) => frame.data === 'ZnJhbWU=')).toEqual([
      { streamId: endpoint.streamId, data: 'ZnJhbWU=' },
    ])
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
    const paint = Buffer.from('paint').toString('base64')
    const { terminals, state } = harness({ subscribeFrame: paint })
    await terminals.attach({ sessionId: SESSION, target })
    const decoded = state.frames.map((frame) =>
      Buffer.from(frame.data, 'base64').toString('latin1'),
    )
    expect(decoded[0]).toContain('\x1b[2J')
    expect(decoded[0]).toContain('\x1b[3J')
    expect(decoded.indexOf('paint')).toBeGreaterThan(0)
  })

  it('does not clear the terminal when the client spawn is refused', async () => {
    const { terminals, state } = harness({ spawnError: new Error('spawn refused') })

    await expect(terminals.attach({ sessionId: SESSION, target })).rejects.toThrow('spawn refused')

    expect(state.frames).toEqual([])
  })

  it('re-anchors on EVERY generation, which is the one the duplicate came from', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    state.clients[0]?.emit('Zmlyc3Q=')
    await terminals.close(SESSION)
    await terminals.attach({ sessionId: SESSION, target })
    state.clients[1]?.emit('c2Vjb25k')
    const decoded = state.frames.map((frame) =>
      Buffer.from(frame.data, 'base64').toString('latin1'),
    )
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
        threadId: 'thread-paint',
        clientAddress: 'unix:///instance/runtime/codex-paint.sock',
        workdir: '/work/codex',
      },
      'codex',
      false,
    ],
    [
      'grok',
      'cold',
      { kind: 'grok' as const, grokSessionId: 'grok-paint', workdir: '/work/grok' },
      'grok',
      false,
    ],
    ['opencode', 'adopted', target, 'opencode', true],
    [
      'codex',
      'adopted',
      {
        kind: 'codex' as const,
        threadId: 'thread-paint',
        clientAddress: 'unix:///instance/runtime/codex-paint.sock',
        workdir: '/work/codex',
      },
      'codex',
      true,
    ],
    [
      'grok',
      'adopted',
      { kind: 'grok' as const, grokSessionId: 'grok-paint', workdir: '/work/grok' },
      'grok',
      true,
    ],
  ] as const)('%s %s client anchors only new generations before initial paint', async (_harnessKind, _startKind, paintTarget, clientKind, adopted) => {
    const initialPaint = Buffer.from('\x1b[2Jopencode ready').toString('base64')
    const priorHistory = Buffer.from('older scrollback').toString('base64')
    const { terminals, state } = harness({
      redrawFrame: initialPaint,
      hasMaster: () => adopted,
      priorFrames: adopted ? [{ streamId: SESSION, data: priorHistory }] : [],
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
    // master already owns a running TUI and browser history: its viewport redraw
    // follows that history without a scrollback-clearing reset between them.
    const decoded = state.frames.map((frame) =>
      Buffer.from(frame.data, 'base64').toString('latin1'),
    )
    const resets = decoded.filter((data) => data.includes('\x1b[2J') && data.includes('\x1b[3J'))
    expect(resets).toHaveLength(adopted ? 0 : 1)
    if (adopted) {
      expect(decoded[0]).toBe('older scrollback')
      expect(decoded).toEqual(['older scrollback', '\x1b[2Jopencode ready'])
    } else {
      expect(decoded[0]).toContain('\x1b[3J')
    }
    expect(state.frames.at(-1)).toEqual({ streamId: endpoint.streamId, data: initialPaint })
    expect(state.frames.every((frame) => frame.streamId === endpoint.streamId)).toBe(true)
    expect(state.clients[0]?.redraws).toBe(1)
  })

  it('routes browser input, geometry, and redraw back to the attached TUI', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target })
    expect(terminals.input(SESSION, 'aGVsbG8=')).toBe(true)
    expect(terminals.resize(SESSION, 101, 37)).toBe(true)
    expect(terminals.redraw(SESSION)).toBe(true)
    expect(state.clients[0]?.writes).toEqual(['aGVsbG8='])
    expect(state.clients[0]?.sizes).toEqual([{ cols: 101, rows: 37 }])
    expect(state.clients[0]?.redraws).toBe(2)
    expect(terminals.input(asSessionId('not-attached'), 'eA==')).toBe(false)
  })

  it('launches Codex and Grok original resume TUIs under sibling labels', async () => {
    const codex = harness()
    await codex.terminals.attach({
      sessionId: SESSION,
      target: {
        kind: 'codex',
        threadId: 'thread-9',
        clientAddress: 'unix:///instance/runtime/codex-9.sock',
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
      target: { kind: 'grok', grokSessionId: 'grok-9', workdir: '/work/grok' },
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
    await terminals.close(SESSION)
    release?.()
    await expect(attaching).rejects.toThrow(/closed while it was starting/)
    expect(clients[0]?.disposed).toBe(true)
    expect(reclaimed).toEqual([opencodeAttachLabel(SESSION), opencodeAttachLabel(SESSION)])
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
  baseUrl: target.url,
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
      await host.attachClient({ sessionId: SESSION, url: target.url, mode: 'takeover' }),
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
      await host.attachClient({ sessionId: SESSION, url: target.url, mode: 'takeover' }),
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
      await host.attachClient({ sessionId: SESSION, url: target.url, mode: 'takeover' }),
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
