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
  createOpencodeClientTerminals,
  opencodeAttachLabel,
  WARM_TTL_MS,
} from './opencode-attach'
import { createOpencodeHost, opencodeScopeLabel } from './opencode-server'
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
function fakeClient(): AgentSession & { emit(data: string): void; disposed: boolean } {
  const frameCbs: ((f: AgentFrame) => void)[] = []
  let seq = 0
  const client = {
    pid: 4242,
    disposed: false,
    onFrame(cb: (f: AgentFrame) => void) {
      frameCbs.push(cb)
      return () => {}
    },
    onTitle() {
      return () => {}
    },
    onExit() {
      return () => {}
    },
    write() {},
    resize() {},
    redraw() {},
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

interface Harness {
  spawns: { label: string; cmd: string; args: string[]; env?: Record<string, string> }[]
  reclaimed: string[]
  frames: { streamId: string; data: string }[]
  clients: ReturnType<typeof fakeClient>[]
  fire(): void
  armed: number
  cleared: number
}

function harness(opts: { hasMaster?: (label: string) => boolean } = {}) {
  const state: Harness = {
    spawns: [],
    reclaimed: [],
    frames: [],
    clients: [],
    armed: 0,
    cleared: 0,
    fire: () => {},
  }
  const terminals = createOpencodeClientTerminals({
    frames: (streamId, data) => state.frames.push({ streamId, data }),
    spawn: async (o) => {
      state.spawns.push({
        label: o.label,
        cmd: o.cmd,
        args: o.args ?? [],
        ...(o.env ? { env: o.env } : {}),
      })
      const client = fakeClient()
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
    const endpoint = await terminals.attach({ sessionId: SESSION, target, mode: 'takeover' })

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

  it('keeps the secret OUT of argv, exactly as the server it connects to does', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target, mode: 'takeover' })
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

    const { agents } = attributeMemory(procs, [{ sessionId: SESSION, label: sessionLabel, pid: 100 }], [])
    expect(agents).toEqual([{ sessionId: SESSION, bytes: 300_000_000, processCount: 1 }])
  })

  it('streams the client’s frames on the daemon’s own relay, under the minted stream id', async () => {
    const { terminals, state } = harness()
    const endpoint = await terminals.attach({ sessionId: SESSION, target, mode: 'peek' })
    state.clients[0]?.emit('ZnJhbWU=')
    expect(state.frames).toEqual([{ streamId: endpoint.streamId, data: 'ZnJhbWU=' }])
  })
})

describe('warm-parking', () => {
  it('re-attaches to the SAME client and re-arms the reaper, rather than starting a second', async () => {
    const { terminals, state } = harness()
    const first = await terminals.attach({ sessionId: SESSION, target, mode: 'takeover' })
    const second = await terminals.attach({ sessionId: SESSION, target, mode: 'peek' })

    expect(second.streamId).toBe(first.streamId)
    // The whole point of parking: bouncing back is a reconnect, not a cold start.
    expect(state.spawns).toHaveLength(1)
    expect(state.armed).toBe(2)
    expect(state.cleared).toBe(1)
  })

  it('gives ONE screen to a peek and a take-over, because they are the same screen', async () => {
    const { terminals, state } = harness()
    const peek = await terminals.attach({ sessionId: SESSION, target, mode: 'peek' })
    const takeover = await terminals.attach({ sessionId: SESSION, target, mode: 'takeover' })
    expect(takeover.streamId).toBe(peek.streamId)
    expect(state.spawns).toHaveLength(1)
  })

  it('starts ONE client for two attaches that race', async () => {
    const { terminals, state } = harness()
    const [a, b] = await Promise.all([
      terminals.attach({ sessionId: SESSION, target, mode: 'takeover' }),
      terminals.attach({ sessionId: SESSION, target, mode: 'peek' }),
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
    const attaching = terminals.attach({ sessionId: SESSION, target, mode: 'takeover' })
    await terminals.close(SESSION)
    release?.()
    await expect(attaching).rejects.toThrow(/closed while it was starting/)
    expect(clients[0]?.disposed).toBe(true)
    expect(reclaimed).toEqual([opencodeAttachLabel(SESSION), opencodeAttachLabel(SESSION)])
  })

  it('reaps the client when the warm window closes', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target, mode: 'takeover' })
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

  it('takes the client down with the session it belongs to', async () => {
    const { terminals, state } = harness()
    await terminals.attach({ sessionId: SESSION, target, mode: 'takeover' })
    await terminals.close(SESSION)
    expect(state.clients[0]?.disposed).toBe(true)
    expect(state.reclaimed).toEqual([opencodeAttachLabel(SESSION)])
    // …and the reaper for a closed attachment is disarmed, not left to fire at
    // a session that has since started a new one.
    expect(state.cleared).toBe(1)
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
      memoryBytes: () => undefined,
      journal: memoryJournal(journalEntry()),
    })
    expect(
      await host.attachClient({ sessionId: SESSION, url: target.url, mode: 'takeover' }),
    ).toBeUndefined()
  })

  it('refuses before the session has a conversation, rather than opening a DIFFERENT one', async () => {
    const { terminals, state } = harness()
    const host = createOpencodeHost({
      memoryBytes: () => undefined,
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
      memoryBytes: () => undefined,
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
      memoryBytes: () => undefined,
      journal: memoryJournal(journalEntry()),
      clientTerminals: {
        attach: async () => {
          throw new Error('abduco unavailable: not installed and the vendored build failed')
        },
        adopt: () => {},
        close: async () => {},
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
      memoryBytes: () => undefined,
      journal: memoryJournal(journalEntry()),
      clientTerminals: terminals,
    })
    expect(await host.adopt(binding)).toBeDefined()
    expect(state.armed).toBe(1)
  })

  it('kills the client when the session is killed', async () => {
    const { terminals, state } = harness({ hasMaster: () => true })
    const host = createOpencodeHost({
      memoryBytes: () => undefined,
      journal: memoryJournal(journalEntry()),
      clientTerminals: terminals,
    })
    const endpoint = await host.adopt(binding)
    await endpoint?.kill()
    expect(state.reclaimed).toEqual([opencodeAttachLabel(SESSION)])
  })
})
