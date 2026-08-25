/**
 * THE DRIVER'S OWN BEHAVIOUR (POD-1761 W6).
 *
 * The conformance corpus proves this driver keeps the promises EVERY driver
 * makes. These are the ones only this driver can make, and the acceptance
 * checklist names three of them by hand:
 *
 *   - native steer, reported as `steer` and never as a silent substitution;
 *   - an approval round-trip: server→client request → PendingInteraction →
 *     answer → the turn continues;
 *   - the subscription-auth assertion, proven rather than assumed.
 *
 * Plus the two hazards the live protocol handed us: a handshake whose violation
 * is SILENCE, and a request id of zero.
 */

import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { AgentSessionHandle } from '../../driver.js'
import type { RuntimeEvent } from '../../events.js'
import { streamItemIdOf } from '../../stream-identity.js'
import { createCodexClient } from './client.js'
import {
  type CodexJournal,
  type CodexJournalEntry,
  type CodexRuntimeHost,
  createCodexRuntime,
} from './runtime.js'
import { type FakeAppServer, startFakeAppServer } from './test-support/fake-app-server.js'

interface World {
  handle: AgentSessionHandle
  server: FakeAppServer
  /** Children the host was asked to start, and children stopped. A fine watch
   *  costs neither now, which is what `launches: 1, stopped: 0` pins. */
  counts(): { launches: number; stopped: number; detached: number }
  /** Hold the NEXT connection open until `releaseConnect()` is called, so a test
   *  can act inside the window while a session is being built. */
  gateNextConnect(): void
  releaseConnect(): void
  attachedAddresses: string[]
  /** The fake serving the session's connection. There is only ever one now —
   *  nothing re-handshakes a session after it is built — but tests reach for it
   *  through here so a future second connection cannot silently strand them. */
  liveServer(): FakeAppServer
  authReports: { authMethod: string | undefined; subscription: boolean }[]
  /** Every `onQueueAbandoned` the driver raised, in order (POD-2297). */
  abandonments: { turnIds: (string | undefined)[]; reason: string }[]
  events(): RuntimeEvent[]
  /** Re-adopt the session from its journal, as the daemon's reattach does. */
  adopt(): Promise<AgentSessionHandle>
  /** Make the NEXT `onQueueAbandoned` throw, as an fsync-backed host can. */
  failNextAbandonment(): void
  dispose(): void
}

async function world(stageAttachment?: CodexRuntimeHost['stageAttachment']): Promise<World> {
  const servers = new Map<SessionId, FakeAppServer>()
  const entries = new Map<SessionId, CodexJournalEntry>()
  /**
   * THE THREADS THIS WORLD HAS ON DISK, and world-wide ids so no two
   * incarnations mint the same one (POD-2703's argument, POD-2775's set).
   * Every server this world starts shares them, which is what lets `adopt()`
   * resume a thread an earlier incarnation started — and what makes a resume of
   * an id nobody started fail, as Codex fails it.
   */
  const threads = new Set<string>()
  let mintedThreads = 0
  const authReports: World['authReports'] = []
  const abandonments: World['abandonments'] = []
  let failAbandonment = false
  const attachedAddresses: string[] = []
  let seq = 0
  let launches = 0
  let stopped = 0
  let detached = 0
  let gate: Promise<void> | undefined
  let openGate: (() => void) | undefined
  const journal: CodexJournal = {
    read: (id) => entries.get(id),
    write: (entry) => {
      entries.set(entry.sessionId, entry)
    },
    clear: (id) => {
      entries.delete(id)
    },
  }
  const host: CodexRuntimeHost = {
    stageAttachment:
      stageAttachment ??
      (async ({ source }) => ({
        id: 'image-1',
        path: '/tmp/image-1-' + source.filename,
        filename: source.filename,
        mediaType: source.mediaType,
        kind: 'image',
      })),
    journal,
    now: () => Date.UTC(2026, 7, 14) + ++seq * 1000,
    mintSessionId: () => 'cx-1' as SessionId,
    async launch(input) {
      launches += 1
      // A REAL PAUSE, where the real host does a process spawn and a handshake.
      // Without it the upgrade completes before a test can interleave anything,
      // and the property about interleaving becomes unfalsifiable.
      if (gate) {
        const waiting = gate
        gate = undefined
        await waiting
      }
      const server = startFakeAppServer({ threadIds: [`thr-w${++mintedThreads}`], threads })
      const clients = [server]
      servers.set(input.sessionId, server)
      return {
        transport: server.transport,
        clientAddress: `unix:///tmp/${input.sessionId}.sock`,
        process: { key: `podium-cx-${input.sessionId}`, pid: 1000 + seq },
        stop: async () => {
          stopped += 1
          for (const client of clients) client.close()
        },
        kill: async () => {
          for (const client of clients) client.close()
        },
        resources: () => ({ memoryBytes: 1024, oomKills: 0 }),
      }
    },
    reportAuthMode: (report) =>
      void authReports.push({ authMethod: report.authMethod, subscription: report.subscription }),
    rolloutExists: async () => false,
    attachClient: async ({ sessionId, clientAddress }) => {
      attachedAddresses.push(clientAddress)
      return {
        streamId: `cx-attach-${sessionId}`,
        warmTtlMs: 300_000,
      }
    },
    detachClient: async () => {
      detached += 1
    },
    onQueueAbandoned: ({ turns, reason }) => {
      if (failAbandonment) {
        failAbandonment = false
        // What an fsync-backed outbox raises: ENOSPC, EDQUOT, EIO, or an
        // outright throw on a reportId collision.
        throw new Error('ENOSPC: no space left on device, write')
      }
      abandonments.push({ turnIds: turns.map((turn) => turn.input.id), reason })
    },
  }
  const runtime = createCodexRuntime(host)
  const handle = await runtime.driver.create({
    harness: 'codex',
    selection: { auth: 'subscription', platform: 'linux', available: ['codex-app-server'] },
    workdir: '/tmp/codex-test',
    model: {},
    instructions: { supported: false, reason: 'test' },
    mcpServers: { supported: false, reason: 'test' },
  })
  const collected: RuntimeEvent[] = []
  void (async () => {
    try {
      for await (const event of handle.events('bootstrap')) collected.push(event)
    } catch {
      // the stream ends with the session
    }
  })()
  const server = servers.get(handle.binding.sessionId)
  if (!server) throw new Error('no fake server')
  return {
    handle,
    server,
    counts: () => ({ launches, stopped, detached }),
    gateNextConnect: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
    },
    releaseConnect: () => openGate?.(),
    attachedAddresses,
    authReports,
    abandonments,
    liveServer: () => {
      const live = servers.get(handle.binding.sessionId)
      if (!live) throw new Error('no live fake server')
      return live
    },
    events: () => [...collected],
    adopt: () => runtime.driver.adopt(handle.binding),
    failNextAbandonment: () => {
      failAbandonment = true
    },
    dispose: () => runtime.dispose(),
  }
}

/** Let the driver's own microtasks settle. The transport delivers on the same
 *  tick, but the driver's handlers are async in places. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('attachment local-image prompts', () => {
  it('returns raw typed refusals for unsupported files and staging failures', async () => {
    const ordinary = await world()
    try {
      await expect(
        ordinary.handle.stageAttachment({
          bytes: new TextEncoder().encode('notes'),
          filename: 'notes.txt',
          mediaType: 'text/plain',
        }),
      ).resolves.toEqual({ reason: 'unsupported', detail: 'Codex accepts image attachments only' })
    } finally {
      ordinary.dispose()
    }

    const failing = await world(async () => {
      throw new Error('disk full')
    })
    try {
      await expect(
        failing.handle.stageAttachment({
          bytes: new Uint8Array([1]),
          filename: 'diagram.png',
          mediaType: 'image/png',
        }),
      ).resolves.toEqual({ reason: 'staging_failed', detail: 'Error: disk full' })
    } finally {
      failing.dispose()
    }
  })

  it('sends staged images through Codex localImage input', async () => {
    const w = await world()
    try {
      const staged = await w.handle.stageAttachment({
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        filename: 'diagram.png',
        mediaType: 'image/png',
      })
      if ('reason' in staged) throw new Error(staged.detail ?? staged.reason)
      await w.handle.send(
        { text: 'describe this', attachments: [staged] },
        { origin: 'human', delivery: 'when-ready' },
      )
      expect(w.server.lastTurnInput).toEqual([
        { type: 'localImage', path: staged.path },
        { type: 'text', text: 'describe this', text_elements: [] },
      ])
    } finally {
      w.dispose()
    }
  })
})

describe('provider failure detail', () => {
  it('carries the provider text on the normalized state event', async () => {
    const w = await world()
    try {
      await w.handle.send({ text: 'hello' }, { origin: 'human', delivery: 'when-ready' })
      w.server.completeTurn('failed')
      await settle()

      const failure = w
        .events()
        .find((event) => event.t === 'state' && event.change.kind === 'turn_failed')
      expect(failure).toMatchObject({
        t: 'state',
        change: {
          kind: 'turn_failed',
          errorClass: 'provider-error',
          retryable: true,
          detail: 'provider exploded',
        },
      })
    } finally {
      w.dispose()
    }
  })
})

describe('native steer — the thing no other driver in the fleet can do', () => {
  it('joins the OPEN turn and reports `steer`, not a downgrade', async () => {
    const w = await world()
    const first = await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    expect(first.outcome).toBe('accepted')
    if (first.outcome !== 'accepted') return

    const steered = await w.handle.send(
      { text: 'also mention bananas' },
      { origin: 'human', delivery: 'steer' },
    )
    expect(steered.outcome).toBe('accepted')
    if (steered.outcome !== 'accepted') return
    // THE ACCEPTANCE ITEM. Every other driver in the epic answers `queue` here.
    expect(steered.deliveredAs).toBe('steer')
    // THE SAME TURN, so the epoch does not move: a steer joins a turn rather
    // than opening one, and advancing the epoch would orphan every event still
    // arriving under the old number.
    expect(steered.turnEpoch).toBe(first.turnEpoch)
    // …and it really went over the wire as a steer, not as a second turn.
    expect(w.server.steers).toBe(1)
    expect(w.server.turnStarts).toBe(1)
    w.dispose()
  })

  it('WAITS for the turn to actually open before steering into it', async () => {
    /**
     * THE WINDOW, HELD STILL.
     *
     * `turn/start` answers with an `inProgress` turn BEFORE `turn/started`
     * arrives, and a steer fired in between is refused with "no active turn to
     * steer" — recorded in `./__fixtures__/steer-interrupt.json`. A driver that
     * treated the ack as the open turn would steer into that gap and silently
     * degrade to a queue on every fast caller.
     */
    const w = await world()
    w.server.deferTurnStarted()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })

    // The turn is ACKED but not yet STEERABLE. Start the steer here…
    const steering = w.handle.send({ text: 'and bananas' }, { origin: 'human', delivery: 'steer' })
    await settle()
    expect(w.server.steers).toBe(0)

    // …and let the turn open. The steer should now land as a steer.
    w.server.releaseTurnStarted()
    const receipt = await steering
    expect(receipt.outcome).toBe('accepted')
    if (receipt.outcome !== 'accepted') return
    expect(receipt.deliveredAs).toBe('steer')
    expect(w.server.steers).toBe(1)
    w.dispose()
  })

  it('DOWNGRADES to queue, and says so, when the turn ended first', async () => {
    const w = await world()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    // The turn ends between the caller deciding to steer and the steer landing —
    // a real race on a live connection, not a hypothetical.
    w.server.completeTurn('completed')
    await settle()

    const receipt = await w.handle.send({ text: 'late' }, { origin: 'human', delivery: 'steer' })
    // NOT `accepted`-with-`steer`. `deliveredAs` exists to prevent exactly this
    // substitution, so the receipt reports what actually happened.
    expect(receipt.outcome).toBe('accepted')
    if (receipt.outcome !== 'accepted') return
    expect(receipt.deliveredAs).not.toBe('steer')
    expect(w.server.steers).toBe(0)
    w.dispose()
  })
})

describe('the approval inversion — server asks, Podium answers, the turn continues', () => {
  it('round-trips a command approval and unblocks the turn', async () => {
    const w = await world()
    await w.handle.send({ text: 'run something' }, { origin: 'human', delivery: 'when-ready' })
    const askId = w.server.askCommandApproval({ command: 'rm -rf build' })
    await settle()

    const open = await w.handle.interactions()
    expect(open.map((i) => i.id)).toContain(askId)
    const ask = open.find((i) => i.id === askId)
    expect(ask?.kind).toBe('permission')
    expect(ask?.source).toBe('protocol')
    expect(ask?.answerable).toBe('structured')
    if (ask?.kind === 'permission') expect(ask.payload.inputSummary).toContain('rm -rf build')

    // A BLOCKED SESSION REFUSES WRITES. The ask is what the user has to answer,
    // and a turn stacked behind it would bury the question.
    const blocked = await w.handle.send({ text: 'more' }, { origin: 'human', delivery: 'queue' })
    expect(blocked.outcome).toBe('refused')
    if (blocked.outcome === 'refused') expect(blocked.refusal.reason).toBe('needs_user')

    expect(await w.handle.answer(askId, { decision: 'allow' })).toEqual({ ok: true })
    // THE ANSWER REACHED THE SERVER as the response to the blocking request.
    expect(w.server.answers.get(Number(askId))).toEqual({ decision: 'accept' })
    expect(await w.handle.interactions()).toHaveLength(0)

    // …and the session accepts writes again.
    const after = await w.handle.send({ text: 'more' }, { origin: 'human', delivery: 'queue' })
    expect(after.outcome).not.toBe('refused')
    w.dispose()
  })

  it('answers the FIRST approval of a session, whose request id is zero', async () => {
    /**
     * A REGRESSION GUARD FOR A TRUTHINESS BUG. Codex numbers server→client
     * requests from 0, so `if (msg.id)` drops the first approval of every
     * session — the very first permission prompt a user ever sees. The test
     * asserts the id really is 0 so it cannot quietly stop covering the case.
     */
    const w = await world()
    const askId = w.server.askCommandApproval()
    await settle()
    expect(askId).toBe('0')
    expect((await w.handle.interactions()).map((i) => i.id)).toContain('0')
    expect(await w.handle.answer('0', { decision: 'allow' })).toEqual({ ok: true })
    expect(w.server.answers.get(0)).toEqual({ decision: 'accept' })
    w.dispose()
  })

  it('REFUSES an always-allow the ask never offered, and leaves it open', async () => {
    const w = await world()
    // The recorded live ask offered `accept` and `cancel` — no
    // `acceptForSession`. Sending `accept` instead would report a persistent
    // grant that was never made.
    const askId = w.server.askCommandApproval({ canAlwaysAllow: false })
    await settle()

    const outcome = await w.handle.answer(askId, { decision: 'allow-always' })
    expect(outcome).toEqual({ ok: false, reason: 'not-yet-supported' })
    // THE ASK STAYS OPEN, which is the point: the session remains visibly
    // blocked rather than reporting an answer that never reached the agent.
    expect((await w.handle.interactions()).map((i) => i.id)).toContain(askId)
    expect(w.server.answers.has(Number(askId))).toBe(false)
    w.dispose()
  })

  it('sends `acceptForSession` when the ask DID offer one', async () => {
    const w = await world()
    const askId = w.server.askCommandApproval({ canAlwaysAllow: true })
    await settle()
    expect(await w.handle.answer(askId, { decision: 'allow-always' })).toEqual({ ok: true })
    expect(w.server.answers.get(Number(askId))).toEqual({ decision: 'acceptForSession' })
    w.dispose()
  })

  it('closes an ask somebody ELSE answered, via serverRequest/resolved', async () => {
    const w = await world()
    const askId = w.server.askCommandApproval()
    await settle()
    expect(await w.handle.interactions()).toHaveLength(1)
    // A human at an attached Codex TUI answers the same request. The aggregate
    // must see it close either way, or the session reports itself blocked while
    // it works.
    w.server.transport.write(JSON.stringify({ id: Number(askId), result: { decision: 'accept' } }))
    await settle()
    expect(await w.handle.interactions()).toHaveLength(0)
    w.dispose()
  })
})

describe('the subscription-auth assertion', () => {
  it('asks the SERVER which credential it chose, rather than assuming', async () => {
    const w = await world()
    /**
     * Stripping API keys from the child env is the MECHANISM; this is the
     * VERIFICATION, and they are not the same thing. Codex resolves credentials
     * from several places, so an env strip proves what we did, not what Codex
     * chose — and the acceptance item asks for proof that the demonstration does
     * not ride an inherited key.
     */
    expect(w.authReports).toHaveLength(1)
    expect(w.authReports[0]?.authMethod).toBe('chatgpt')
    expect(w.authReports[0]?.subscription).toBe(true)
    w.dispose()
  })
})

describe('the watch levels, filtered rather than negotiated', () => {
  // Whether a fragment reaches a viewer is asserted in 'the fine watch, which
  // takes effect where the viewer is'. What is left here is the other side of
  // the same handshake: what muting the fragments must never take with them.

  it('never suppresses anything the coarse plane needs', async () => {
    const w = await world()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    w.server.emitAgentMessage('the answer')
    w.server.completeTurn('completed')
    await settle()
    const events = w.events()
    // A fence that was opted out of is a session that never goes idle, and a
    // completed item that was opted out of is an empty chat.
    expect(events.some((e) => e.t === 'turn' && e.ev.ev === 'completed')).toBe(true)
    expect(events.some((e) => e.t === 'item' && e.item.kind === 'complete')).toBe(true)
    w.dispose()
  })

  it('emits only the COMPLETED half of an item Codex updates in place', async () => {
    const w = await world()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    w.server.emitAgentMessage('the answer', 'msg_x')
    await settle()
    // `item/started` and `item/completed` carry the SAME id — the first without
    // its text. Emitting both would put the message in the transcript twice, the
    // first time empty.
    const items = w.events().filter((e) => e.t === 'item' && e.item.kind === 'complete')
    expect(items).toHaveLength(1)
    w.dispose()
  })
})

describe('the human take-over lease', () => {
  it('materializes a blank thread without a model turn before starting the stock TUI', async () => {
    const w = await world()

    const endpoint = await w.handle.attach({ holder: 'human-1', mode: 'takeover' })

    expect(endpoint).toMatchObject({ kind: 'client', placement: 'on-machine' })
    expect(w.server.threadNames).toEqual(['Podium cx-1'])
    expect(w.server.turnStarts).toBe(0)
    expect(w.attachedAddresses).toEqual(['unix:///tmp/cx-1.sock'])

    await w.handle.lease.release('human-1')
    // Native is another client of the SAME app-server. Returning to Chat drops
    // the write lease but leaves that TUI warm; the engine is neither stopped
    // nor relaunched.
    expect(w.counts()).toMatchObject({ launches: 1, stopped: 0, detached: 0 })
    w.dispose()
  })

  it('DELIVERS a turn parked behind a takeover the moment the lease is released', async () => {
    /**
     * RELEASING THE LEASE IS A DRAIN EDGE. A `queue` that arrives while a human
     * holds the take-over lease is parked rather than refused — headless drivers
     * queue rather than interleave, and W3's F6 says the nudge lands AFTER the
     * takeover ends. If the only drain edge is a turn completing, then on an
     * IDLE session that nudge waits for a turn that may never come: the human
     * releases, nothing is running, and the words sit there indefinitely.
     *
     * The same bug the opencode driver had; this one inherited it by mirroring
     * that file's structure, which is exactly why it is pinned here too.
     */
    const w = await world()
    const lease = await w.handle.lease.acquire('human-1', 'human-controller')
    expect('holder' in lease).toBe(true)

    // A steward nudge arriving mid-takeover, on an IDLE session.
    const receipt = await w.handle.send(
      { text: 'nudge while a human is driving' },
      { origin: 'mail', delivery: 'queue', principal: { kind: 'system', ref: 'steward' } },
    )
    expect(receipt.outcome).toBe('queued')
    expect(w.server.turnStarts).toBe(0)

    await w.handle.lease.release('human-1')
    await settle()
    await settle()
    // The words were handed over, without waiting for a turn edge that never
    // arrives on an idle session.
    expect(w.server.turnStarts).toBe(1)
    w.dispose()
  })
})

describe('the fine watch, which takes effect where the viewer is', () => {
  const fragments = (events: RuntimeEvent[]): RuntimeEvent[] =>
    events.filter((e) => e.t === 'item' && e.item.kind === 'delta')

  /**
   * THE BUG THIS BLOCK REPLACED A RECONNECT TO FIX (POD-2745).
   *
   * Reaching `fine` used to mean re-handshaking, because the coarse handshake
   * asked the app-server to mute the delta notifications and that mute is sent
   * once, for the connection's life. A reconnect abandons an in-flight turn and
   * any outstanding approval, so the upgrade could only be applied in an idle
   * gap — and the turn a viewer opened the chat DURING was therefore always the
   * turn that streamed nothing. On a session started with an initial prompt that
   * is the first turn there is. It is the turn people judge the feature by, and
   * an adversarial drive that watched only that turn concluded the feature
   * produced nothing at all.
   *
   * THE FAKE IS WHAT MAKES THESE ASSERTIONS ABOUT THE MECHANISM RATHER THAN
   * ABOUT A COUNTER. `emitDelta` is a no-op on a connection whose handshake
   * muted `item/agentMessage/delta`, exactly as the real server suppresses it.
   * So a fragment ARRIVING proves the notification crossed the wire, and a
   * fragment NOT arriving on an unmuted connection proves the driver dropped it
   * — two different facts that a `watchers.fine` assertion would conflate.
   */
  it('streams the turn that was ALREADY RUNNING when the viewer arrived', async () => {
    const w = await world()
    // BUSY FIRST, then the viewer. This is the ordering that produced silence,
    // and it is the normal one rather than an edge.
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await settle()
    const release = await w.handle.watch('fine')
    await settle()

    // No turn boundary in between — the same turn the viewer joined mid-way.
    w.liveServer().emitDelta('msg_1', 'streaming')
    await settle()
    expect(fragments(w.events())).toHaveLength(1)

    // And the child was never remade to get here, which is the other half of
    // the fix: one launch, nothing stopped, so the in-flight turn cannot have
    // been abandoned — there was no second connection to abandon it for.
    expect(w.counts()).toMatchObject({ launches: 1, stopped: 0 })
    release()
    w.dispose()
  })

  it('streams mid-turn even with an approval outstanding', async () => {
    /**
     * THE SECOND CONDITION THE OLD UPGRADE REFUSED ON, and it deserves its own
     * test because it does not resolve on its own: a turn ends by itself, an
     * unanswered approval waits for a person. A viewer who opened the chat
     * BECAUSE something was asking them a question used to be the one guaranteed
     * to see nothing while they read it.
     */
    const w = await world()
    await w.handle.send({ text: 'run something' }, { origin: 'human', delivery: 'when-ready' })
    const askId = w.server.askCommandApproval({ command: 'rm -rf build' })
    await settle()
    expect((await w.handle.interactions()).map((i) => i.id)).toContain(askId)

    const release = await w.handle.watch('fine')
    await settle()
    w.liveServer().emitDelta('msg_1', 'thinking out loud')
    await settle()
    expect(fragments(w.events())).toHaveLength(1)

    // The ask is still the user's to answer — streaming did not disturb it.
    expect((await w.handle.interactions()).map((i) => i.id)).toContain(askId)
    release()
    w.dispose()
  })

  /**
   * THE OTHER DIRECTION, AND IT IS NOW A REAL TEST RATHER THAN A RESTATEMENT OF
   * THE HANDSHAKE.
   *
   * While the server did the muting, "no viewer means no fragments" was true
   * because the notification never arrived — the driver's own guard was never
   * reached, so the test proved the fake's opt-out and nothing about the driver.
   * Now the notification DOES arrive and the driver has to drop it, so the two
   * tests below are the only thing standing between this change and an
   * always-on token stream.
   */
  it('emits NO fragment when nobody is watching, though the wire now carries one', async () => {
    const w = await world()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await settle()

    // THE PRECONDITION IS THE POINT: this connection is NOT muted, so the fake
    // really does send. Without this assertion the test below passes just as
    // well against a server that suppressed the frame.
    expect(w.liveServer().optedOutOfDeltas).toBe(false)
    w.liveServer().emitDelta('msg_1', 'nobody asked for this')
    await settle()
    expect(fragments(w.events())).toEqual([])
    w.dispose()
  })

  it('stops emitting the moment the last viewer leaves, with nothing left behind', async () => {
    const w = await world()
    const release = await w.handle.watch('fine')
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await settle()
    w.liveServer().emitDelta('msg_1', 'watched')
    await settle()
    expect(fragments(w.events())).toHaveLength(1)

    /**
     * AND THIS IS WHERE THE OLD SHAPE LEAKED. The upgrade was deliberately
     * ONE-WAY — tearing the child down when a tab closed would have churned a
     * process per navigation — so a session that once had a viewer kept a `fine`
     * connection for the rest of its life. Correct, because the refcount still
     * dropped the fragments, but it meant the level and the demand disagreed
     * from here on. With nothing negotiated there is nothing to leave behind.
     */
    release()
    w.liveServer().emitDelta('msg_1', ' and then unwatched')
    await settle()
    expect(fragments(w.events())).toHaveLength(1)

    // A second viewer gets fragments again, immediately, with no boundary in
    // between — the reverse of the trip that used to be one-way.
    const second = await w.handle.watch('fine')
    w.liveServer().emitDelta('msg_1', ' and watched again')
    await settle()
    expect(fragments(w.events())).toHaveLength(2)
    second()
    w.dispose()
  })

  it('counts viewers rather than tracking a level, so one leaving does not silence another', async () => {
    const w = await world()
    const first = await w.handle.watch('fine')
    const second = await w.handle.watch('fine')
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await settle()
    first()
    w.liveServer().emitDelta('msg_1', 'still one viewer')
    await settle()
    expect(fragments(w.events())).toHaveLength(1)
    second()
    w.liveServer().emitDelta('msg_1', 'now none')
    await settle()
    expect(fragments(w.events())).toHaveLength(1)
    w.dispose()
  })

  /**
   * WHAT THE HANDSHAKE STILL MUTES, PINNED BY NAME.
   *
   * `optOutNotificationMethods` takes any method string, so the failure mode of
   * a wrong entry is a lifecycle event that silently stops arriving — a session
   * that never goes idle, if `turn/completed` ever landed on it. Asserting the
   * exact list is the only check that fails loudly instead.
   *
   * The three that remain have no ingest arm at all, so receiving them would be
   * waste at every level; the assistant one is absent because muting it is what
   * made the level connection-scoped.
   */
  it('mutes only the fragments it never reads, and never the assistant ones', async () => {
    const w = await world()
    expect([...w.server.mutedNotificationMethods]).toEqual([
      'item/reasoning/textDelta',
      'item/reasoning/summaryTextDelta',
      'item/plan/delta',
    ])
    expect(w.server.optedOutOfDeltas).toBe(false)
    w.dispose()
  })

  it('mutes the same list on a resumed connection, and streams on it with no upgrade', async () => {
    /**
     * A RESUME IS A NEW CHILD AND A NEW HANDSHAKE, so it is a second place the
     * mute list is chosen and a second place the old shape started at `coarse`.
     * A daemon reattach that landed a session back on a muted connection would
     * reintroduce exactly this bug for every recovered session.
     */
    const w = await world()
    const resumed = await w.adopt()
    await settle()
    const release = await resumed.watch('fine')
    await resumed.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await settle()
    expect([...w.liveServer().mutedNotificationMethods]).toEqual([
      'item/reasoning/textDelta',
      'item/reasoning/summaryTextDelta',
      'item/plan/delta',
    ])

    const collected: RuntimeEvent[] = []
    void (async () => {
      try {
        for await (const event of resumed.events('bootstrap')) collected.push(event)
      } catch {
        // ends with the session
      }
    })()
    await settle()
    w.liveServer().emitDelta('msg_1', 'streaming after a reattach')
    await settle()
    expect(fragments(collected).length).toBeGreaterThan(0)
    release()
    w.dispose()
  })
})

describe('the pipe is the liveness signal', () => {
  it('reports a child that went away as a PROCESS exit, not a turn failure', async () => {
    const w = await world()
    // There is no port to probe and no health endpoint: the child writing EOF is
    // the child being gone.
    w.server.crash()
    await settle()
    const events = w.events()
    expect(events.some((e) => e.t === 'process' && e.ev.ev === 'exited')).toBe(true)
    // NOT a turn failure. The contract is explicit that conflating a dead
    // process with a failed turn is how ghost sessions happen.
    expect(events.some((e) => e.t === 'turn' && e.ev.ev === 'failed')).toBe(false)
    w.dispose()
  })

  it('says NOTHING when the driver itself ended the session', async () => {
    const w = await world()
    await w.handle.stop()
    await settle()
    // A stop, a kill and a hibernate are expected endings; reporting one as a
    // crash would make every ordinary shutdown look like a fault.
    expect(w.events().some((e) => e.t === 'process' && e.ev.ev === 'exited')).toBe(false)
    w.dispose()
  })
})

describe('the handshake, whose violation is silence', () => {
  it('refuses to send anything before `initialize` rather than hanging', async () => {
    /**
     * MEASURED ON 0.147.0: a `thread/start` before `initialize` gets NO response
     * AND poisons the connection, so the `initialize` that follows never answers
     * either. There is nothing to recover to, which is why the client refuses at
     * the call site instead of trying and timing out.
     */
    const server = startFakeAppServer()
    const client = createCodexClient({
      transport: server.transport,
      onNotification: () => {},
      onServerRequest: () => {},
    })
    await expect(client.call('thread/start', {})).rejects.toThrow(/before the initialize handshake/)
    client.close()
  })

  it('refuses a second handshake on the same connection', async () => {
    const server = startFakeAppServer()
    const client = createCodexClient({
      transport: server.transport,
      onNotification: () => {},
      onServerRequest: () => {},
    })
    const params = {
      clientInfo: { name: 'podium', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }
    await client.handshake(params)
    await expect(client.handshake(params)).rejects.toThrow(/already performed/)
    client.close()
  })

  it('rejects every in-flight request when the pipe dies', async () => {
    // One dead pipe kills them all at once. Leaving them pending would hang
    // whichever session verb is awaiting one, forever.
    const server = startFakeAppServer()
    const client = createCodexClient({
      transport: server.transport,
      onNotification: () => {},
      onServerRequest: () => {},
    })
    await client.handshake({
      clientInfo: { name: 'podium', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    // GENUINELY IN FLIGHT: the server received it and is still thinking when the
    // pipe dies. A request the fake answered immediately would prove nothing.
    server.stallNextRequest()
    const pending = client.call('thread/read', { threadId: 'nope' })
    server.crash()
    await expect(pending).rejects.toThrow(/closed its transport/)
  })
})

describe('a queue this driver loses says so — POD-2297', () => {
  it('reports the turn a failed drain dropped, instead of swallowing it', async () => {
    /**
     * THE BUG, HELD STILL.
     *
     * Before this issue `drainQueue`'s handler was `catch { return }` and a
     * commentary paragraph. The turn had already been `shift()`ed off the queue,
     * its sender was holding a `queued` receipt that POD-2291 made the ledger's
     * last word, and the driver's answer was to do nothing at all — no event, no
     * log, no row. The turn simply stopped existing.
     */
    const w = await world()
    const open = await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    expect(open.outcome).toBe('accepted')
    // Parked behind the open turn, and told so: this is the receipt that has to
    // stop being true out loud.
    const parked = await w.handle.send(
      { id: 'msg-parked', text: 'and then this' },
      { origin: 'human', delivery: 'queue' },
    )
    expect(parked.outcome).toBe('queued')

    // The turn ends, the drain runs, and the app-server refuses the send.
    w.server.failNextTurn()
    w.server.completeTurn()
    await settle()

    expect(w.abandonments).toEqual([{ turnIds: ['msg-parked'], reason: 'delivery-failed' }])
    // NOT a turn event: this turn never opened, and the contract is explicit
    // that a consumer told a turn failed believes one ran.
    expect(w.events().some((e) => e.t === 'turn' && e.ev.ev === 'failed')).toBe(false)
    w.dispose()
  })

  it('leaves the rest of the queue alone — a failed send is not a dead session', async () => {
    // Only the turn that was actually attempted is declared lost. The others are
    // still in the queue and may still drain; dead-lettering them here would
    // strand turns this driver can deliver.
    const w = await world()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await w.handle.send({ id: 'a', text: 'a' }, { origin: 'human', delivery: 'queue' })
    await w.handle.send({ id: 'b', text: 'b' }, { origin: 'human', delivery: 'queue' })

    w.server.failNextTurn()
    w.server.completeTurn()
    await settle()

    expect(w.abandonments).toEqual([{ turnIds: ['a'], reason: 'delivery-failed' }])
    // `b` is still owed, so `stop()` is what finally reports it.
    await w.handle.stop()
    expect(w.abandonments).toEqual([
      { turnIds: ['a'], reason: 'delivery-failed' },
      { turnIds: ['b'], reason: 'teardown' },
    ])
    w.dispose()
  })

  it('reports the whole queue when the session is stopped out from under it', async () => {
    const w = await world()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await w.handle.send({ id: 'x', text: 'x' }, { origin: 'human', delivery: 'queue' })
    await w.handle.send({ id: 'y', text: 'y' }, { origin: 'human', delivery: 'queue' })

    await w.handle.stop()

    // ONE report, in queue order: the consumer dedupes by turn id and corrects
    // both receipts from a single durable frame.
    expect(w.abandonments).toEqual([{ turnIds: ['x', 'y'], reason: 'teardown' }])
    w.dispose()
  })

  it('reports the queue when the child dies under the session', async () => {
    const w = await world()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await w.handle.send({ id: 'orphan', text: 'orphan' }, { origin: 'human', delivery: 'queue' })

    w.server.crash()
    await settle()

    expect(w.abandonments).toEqual([{ turnIds: ['orphan'], reason: 'teardown' }])
    w.dispose()
  })

  it('says nothing when there is nothing to say', async () => {
    // An empty queue at teardown is not an abandonment, and a report naming no
    // turns would put a frame on the daemon's durable outbox for every session
    // that ever ends.
    const w = await world()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    w.server.completeTurn()
    await settle()
    await w.handle.stop()
    expect(w.abandonments).toEqual([])
    w.dispose()
  })

  it('reports a turn once — the queue does not keep its own copy', async () => {
    /**
     * THE REPORT IS THE POINT OF NO RETURN (`TerminalInjectionPorts.onDrainAbandoned`).
     * A queue that retained its turns after reporting them could deliver, on a
     * later drain, words the ledger has already recorded as never delivered —
     * the silent loss again, with a dead-letter row on top of it.
     */
    const w = await world()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await w.handle.send({ id: 'once', text: 'once' }, { origin: 'human', delivery: 'queue' })

    await w.handle.stop()
    w.dispose()

    expect(w.abandonments).toEqual([{ turnIds: ['once'], reason: 'teardown' }])
  })
})

describe('an adopted session comes back on ITS OWN conversation — POD-2775, review 2', () => {
  /**
   * THE ONE PROPERTY A REBIND EXISTS TO PRESERVE, and until this test nothing
   * at any level compared it. The corpus checked the session id, the process
   * key, the turn epoch, the observer generation and the binding version — all
   * of which a session resumed onto SOMEBODY ELSE'S THREAD satisfies exactly.
   * A mutant that replaced `journalled.threadId` with a literal passed 355
   * tests green.
   *
   * It is asserted on the RESUME REF rather than on any transcript text,
   * because the ref is what the next `thread/resume` will be handed: a check
   * that the words came back is satisfied by any conversation containing them.
   */
  it('resumes the thread the journal names, not a fresh one', async () => {
    const w = await world()
    const before = w.handle.binding.resume
    expect(before).toEqual({ kind: 'codex-thread', value: expect.any(String) })

    const adopted = await w.adopt()

    expect(adopted.binding.resume).toEqual(before)
    w.dispose()
  })
})

describe('a session adopted OVER a live one takes its queue with it — POD-2297 review, 1', () => {
  it('reports the displaced queue instead of overwriting it into the garbage collector', async () => {
    /**
     * `adopt()` never sets `disposed`, so it never reached `endSession`: it built
     * a fresh session object and `sessions.set` overwrote the live one, whose
     * queue was collected in silence. The daemon's reattach runs
     * `adoptServerDriverSession` BEFORE any live-session check and a reconnect
     * can re-send a hundred reattaches, so a browser refresh was enough.
     */
    const w = await world()
    await w.handle.lease.acquire('operator', 'human-controller')
    const parked = await w.handle.send(
      { id: 'nudge-adopted-away', text: 'land after the takeover' },
      { origin: 'steward', delivery: 'when-ready' },
    )
    expect(parked.outcome).toBe('queued')

    await w.adopt()

    expect(w.abandonments).toEqual([{ turnIds: ['nudge-adopted-away'], reason: 'teardown' }])
    w.dispose()
  })

  it('says nothing when the session it displaces had an empty queue', async () => {
    // The common reattach. A report here would put a durable frame on the
    // daemon's outbox for every reconnect in the fleet.
    const w = await world()
    await w.adopt()
    expect(w.abandonments).toEqual([])
    w.dispose()
  })
})

describe('a throwing report does not leak the child — POD-2297 review, 2', () => {
  it('still stops the endpoint when the host port throws', async () => {
    /**
     * `endSession` is the FIRST statement of `stop`/`kill`/`hibernate`, and the
     * daemon's port fsyncs a durable outbox — ENOSPC, EDQUOT, EIO and a reportId
     * collision all arrive here as exceptions. Before the guard, one of those
     * skipped `detachClient`, `client.close()`, `endpoint.stop()` and both map
     * deletes: a live `codex app-server` with nobody holding it, which is a
     * worse failure than the one being reported.
     */
    const w = await world()
    await w.handle.lease.acquire('operator', 'human-controller')
    await w.handle.send({ id: 'boom', text: 'x' }, { origin: 'steward', delivery: 'when-ready' })
    w.failNextAbandonment()

    await expect(w.handle.stop()).resolves.toBeUndefined()

    // The child was stopped and the session unregistered — the teardown ran to
    // the end despite the port throwing on its way through.
    expect(w.counts().stopped).toBe(1)
    expect(w.counts().detached).toBe(1)
    w.dispose()
  })

  it('does not retain the turns a failed report was carrying', async () => {
    // `abandonQueue` splices BEFORE calling the port, so the turns are gone
    // whether or not the report lands. A queue that kept them could deliver, on
    // a later drain, words the ledger may already have recorded as undelivered.
    const w = await world()
    await w.handle.lease.acquire('operator', 'human-controller')
    await w.handle.send({ id: 'boom', text: 'x' }, { origin: 'steward', delivery: 'when-ready' })
    w.failNextAbandonment()
    await w.handle.stop()

    // The throwing call consumed them; the dispose that follows finds nothing
    // left to report rather than reporting them a second time.
    w.dispose()
    expect(w.abandonments).toEqual([])
  })
})

/**
 * THE IN-PROGRESS TOOL CALL (POD-2293).
 *
 * Codex updates one item in place, so the durable path publishes only
 * `item/completed` — correct, and the reason a viewer sees nothing at all while
 * a two-minute command runs. The started half goes out on the live-only fine
 * plane instead. These pin both halves of that: it is there for a fine watcher,
 * it is NOT there for a coarse one, and it carries the identity that retires it
 * when the result lands.
 */
describe('in-progress tool calls on the fine plane', () => {
  const partials = (events: RuntimeEvent[]): RuntimeEvent[] =>
    events.filter((e) => e.t === 'item' && e.item.kind === 'partial')
  const completes = (events: RuntimeEvent[]): RuntimeEvent[] =>
    events.filter((e) => e.t === 'item' && e.item.kind === 'complete')

  it('publishes a started command to a fine watcher, and retires it on the result', async () => {
    const w = await world()
    const release = await w.handle.watch('fine')
    await w.handle.send({ text: 'run it' }, { origin: 'human', delivery: 'when-ready' })
    await settle()
    const run = w.liveServer().emitCommandExecution('sleep 120', 'done\n')
    await settle()

    const started = partials(w.events())
    expect(started).toHaveLength(1)
    const startedItem = started[0]
    if (startedItem?.t !== 'item' || startedItem.item.kind !== 'partial') throw new Error('shape')
    // THE CALL WITHOUT ITS RESULT — which is what `item/started` means, and what
    // makes this safe to show and unsafe to journal.
    expect(startedItem.item.item.toolName).toBe('Bash')
    expect(startedItem.item.item.toolInput).toBe('sleep 120')
    expect(startedItem.item.item.toolResult).toBeUndefined()

    run.complete()
    await settle()
    const landed = completes(w.events()).at(-1)
    if (landed?.t !== 'item' || landed.item.kind !== 'complete') throw new Error('shape')
    expect(landed.item.item.toolResult).toBe('done\n')
    // The join: the preview the partial opened is the one the result closes.
    expect(streamItemIdOf(landed.item.item)).toBe(streamItemIdOf(startedItem.item.item))
    // And no second partial was invented for the completion.
    expect(partials(w.events())).toHaveLength(1)
    release()
    w.dispose()
  })

  /**
   * THE ROW THAT WOULD SIT ABOVE THE ANSWER.
   *
   * Found by driving it, not by reading it: `item/started` fires for every arm
   * of codex's vocabulary, so before this guard an agent message opened a
   * `partial` of its own ALONGSIDE the fragments streaming the same message.
   * The two carry different identities, so the preview showed two rows for one
   * reply — and the second, having no text and no tool, rendered as a bare
   * "tool" line above the answer as it was written.
   */
  it('opens NO partial for the messages a viewer can already see', async () => {
    const w = await world()
    const release = await w.handle.watch('fine')
    await w.handle.send({ text: 'say something' }, { origin: 'human', delivery: 'when-ready' })
    await settle()
    // The user's own message. Codex announces it back with `item/started`, and
    // it is already on screen above the composer.
    w.liveServer().emitUserMessage('say something')
    await settle()
    // The agent's message. The started half carries the prefix codex has so far
    // — the shape that maps to a real assistant item, and therefore the only one
    // that could open a second row beside the fragments.
    w.liveServer().emitAgentMessage('the answer', undefined, 'the ans')
    await settle()

    // Neither opens a preview row: one is visible already, the other is being
    // streamed by the fragments on this same plane.
    expect(partials(w.events())).toEqual([])
    // And the durable half is untouched: the message still lands complete.
    const landed = completes(w.events()).at(-1)
    if (landed?.t !== 'item' || landed.item.kind !== 'complete') throw new Error('shape')
    expect(landed.item.item.text).toBe('the answer')
    release()
    w.dispose()
  })

  it('publishes NOTHING started to a coarse watcher', async () => {
    const w = await world()
    await w.handle.send({ text: 'run it' }, { origin: 'human', delivery: 'when-ready' })
    await settle()
    const run = w.liveServer().emitCommandExecution('sleep 120', 'done\n')
    await settle()
    expect(partials(w.events())).toEqual([])
    run.complete()
    await settle()
    expect(completes(w.events()).length).toBeGreaterThan(0)
    w.dispose()
  })

  it('publishes nothing started once the turn is fenced', async () => {
    const w = await world()
    const release = await w.handle.watch('fine')
    await settle()
    await settle()
    await w.handle.send({ text: 'run it' }, { origin: 'human', delivery: 'when-ready' })
    await settle()
    w.liveServer().completeTurn('completed')
    await settle()
    // A started item arriving after the fence can only revive a preview the
    // durable transcript already replaced.
    w.liveServer().emitCommandExecution('late', 'out')
    await settle()
    expect(partials(w.events())).toEqual([])
    release()
    w.dispose()
  })
})
