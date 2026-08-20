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
  /** Children the host was asked to start, and to stop. */
  counts(): { launches: number; stopped: number; detached: number }
  /** Hold the NEXT launch open until `releaseLaunch()` is called, so a test can
   *  act INSIDE the window between "an upgrade started" and "it finished". */
  gateNextLaunch(): void
  releaseLaunch(): void
  authReports: { authMethod: string | undefined; subscription: boolean }[]
  events(): RuntimeEvent[]
  dispose(): void
}

async function world(): Promise<World> {
  const servers = new Map<SessionId, FakeAppServer>()
  const entries = new Map<SessionId, CodexJournalEntry>()
  const authReports: World['authReports'] = []
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
      const server = startFakeAppServer()
      servers.set(input.sessionId, server)
      return {
        transport: server.transport,
        process: { key: `podium-cx-${input.sessionId}`, pid: 1000 + seq },
        stop: async () => {
          stopped += 1
          server.close()
        },
        kill: async () => server.close(),
        memoryBytes: () => 1024,
      }
    },
    reportAuthMode: (report) =>
      void authReports.push({ authMethod: report.authMethod, subscription: report.subscription }),
    rolloutExists: async () => false,
    attachClient: async ({ sessionId }) => ({
      streamId: `cx-attach-${sessionId}`,
      warmTtlMs: 300_000,
    }),
    detachClient: async () => {
      detached += 1
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
    gateNextLaunch: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
    },
    releaseLaunch: () => openGate?.(),
    authReports,
    events: () => [...collected],
    dispose: () => runtime.dispose(),
  }
}

/** Let the driver's own microtasks settle. The transport delivers on the same
 *  tick, but the driver's handlers are async in places. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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

describe('the watch levels, negotiated rather than filtered', () => {
  it('suppresses token deltas AT THE SERVER while nobody holds a fine watch', async () => {
    const w = await world()
    // The handshake opted out, so the server does not send them at all — which
    // is strictly better than receiving and discarding them.
    expect(w.server.optedOutOfDeltas).toBe(true)
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    w.server.emitDelta('msg_1', 'hel')
    await settle()
    expect(w.events().filter((e) => e.t === 'item' && e.item.kind === 'delta')).toHaveLength(0)
    w.dispose()
  })

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

    await w.handle.lease.release('human-1')
    expect(w.counts()).toMatchObject({ launches: 2, stopped: 1, detached: 1 })
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

describe('the fine-watch upgrade, which reconnects', () => {
  it('starts ONE child when two viewers ask at once', async () => {
    /**
     * `watch()` cannot await the upgrade — it owes a viewer its release function
     * immediately — so the call is fire-and-forget. Two viewers opening a chat
     * in the same tick would otherwise each spawn a `codex app-server`, the
     * second would overwrite the endpoint, and the first child would be left
     * running with nobody holding it. A UI navigation must not leak processes.
     */
    const w = await world()
    const before = w.counts().launches
    const [releaseA, releaseB] = await Promise.all([
      w.handle.watch('fine'),
      w.handle.watch('fine'),
    ])
    await settle()
    await settle()
    expect(w.counts().launches - before).toBeLessThanOrEqual(1)
    releaseA()
    releaseB()
    w.dispose()
  })

  it('ABANDONS the upgrade when a turn opened while it was launching', async () => {
    /**
     * The safety guards run BEFORE a process spawn and a handshake, and a turn
     * can arrive during them. Swapping the connection then would abandon the
     * in-flight turn's notifications — so the freshly-launched child is stopped
     * rather than adopted, and the session keeps the connection it has.
     */
    const w = await world()
    const bindingBefore = w.handle.binding.bindingVersion
    // The upgrade's launch is held open, so the turn genuinely lands INSIDE the
    // window rather than after it.
    w.gateNextLaunch()
    const release = await w.handle.watch('fine')
    await settle()
    await w.handle.send({ text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    w.releaseLaunch()
    await settle()
    await settle()
    await settle()

    /**
     * THE ASSERTION IS THE HARM, NOT THE BOOKKEEPING.
     *
     * Counting launches and stops cannot tell "abandoned the new child" from
     * "swapped and stopped the old one" — both are one launch and one stop. What
     * separates them is whether the session can still hear the turn it has: a
     * driver that swapped is now connected to a child that never saw this turn,
     * so the completion arrives at a pipe nobody is reading and the session never
     * fences. `w.server` is the ORIGINAL child, and it is the one running the
     * turn.
     */
    expect(w.handle.binding.bindingVersion).toBe(bindingBefore)
    w.server.completeTurn('completed')
    await settle()
    expect((await w.handle.state()).phase).toBe('idle')
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
    await expect(pending).rejects.toThrow(/closed its pipe/)
  })
})
