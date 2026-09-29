/**
 * MESSAGE DELIVERY UNDER REAL FAILURES (POD-4779, part of POD-4720).
 *
 * One end-to-end proof, across the failures delivery actually meets: the server
 * killed, the daemon killed at each point a message can be in, the daemon's link
 * cut for seconds and for minutes or merely degraded, a device reloaded or
 * offline or losing an answer, a second device retracting, an agent's CLI send
 * whose relay timed out and was run again, and a backlog across sessions
 * meeting a reconnect.
 *
 * Every scenario ends the same way: let the chain come to rest, then ask the
 * oracle (`delivery-oracle.ts`) whether anything is wrong — per message: typed
 * into the agent at most once, never lost to a transient fault, a final status
 * that matches what the agent received (`unknown` only in the one declared
 * window), one server row, one bubble per device, the same story on every
 * device; per reconnect: frames bounded by the backlog.
 *
 * ---------------------------------------------------------------------------
 * THE LEGACY CONTROL ARM
 * ---------------------------------------------------------------------------
 *
 * The chain this lane is written for is still being built (POD-4720's other
 * sub-issues). Until it is, today's code FAILS these assertions — and that is
 * the evidence that the harness can see the bugs at all. So each scenario pins
 * exactly what it finds today in {@link KNOWN}: which violation kinds MUST
 * appear on the current base, and which sub-issue removes them. Both directions
 * are enforced:
 *
 *  - a violation kind a scenario does not list is a NEW defect, and fails;
 *  - a listed `must` kind that stops appearing means its fix landed — the test
 *    fails until the entry is deleted, so the lane becomes that fix's
 *    regression guard instead of silently tolerating a defect that is gone.
 *
 * `may` lists kinds that appear on some runs and not others on today's base
 * (a race the design removes); each names the same owning sub-issue. The
 * no-fault baseline lists nothing: it is the control dimension that must be
 * clean in every arm.
 *
 * Runs in the e2e lane (`bun run test:e2e`). Real processes, a real PTY per
 * agent, no model: the agent is `fake-claude.ts`.
 */

import { randomUUID } from 'node:crypto'
import type { SessionId } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'
import { applyHarnessEnv, reapHarnessSessions } from '../harness-env'
import {
  kindsOf,
  stormViolations,
  type TrackedMessage,
  type Violation,
  type ViolationKind,
  violations,
} from './delivery-oracle'
import { messageText } from './device'
import { DeliveryWorld, sleep, waitFor } from './world'

// Own isolated harness root (relay 9921 … resume-send 9927).
const ISOLATION_PORT = 9928
reapHarnessSessions(ISOLATION_PORT)
const harness = applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

interface Known {
  /** What today's base shows on EVERY run. An entry that is a list is met by
   *  any one of its kinds (a race decides which, never whether). */
  readonly must: readonly (ViolationKind | readonly ViolationKind[])[]
  /** Kinds today's base shows on some runs, or as the screen-side echo of a
   *  `must` defect. Never required. */
  readonly may?: readonly ViolationKind[]
  /** The POD-4720 sub-issue(s) whose landing removes them, and why. */
  readonly until: string
}

/** How one defect looks on a screen: the dead-lettered row drawn beside the
 *  transcript turn, the sender's bubble still "sending/queued" while other
 *  devices say "not delivered" (POD-4764 draws bubbles from the record by id). */
const SCREEN_ECHO: readonly ViolationKind[] = [
  'duplicate-bubble',
  'screen-lies',
  'devices-disagree',
]

/**
 * TODAY'S FINDINGS, per scenario — measured on the integration branch at
 * a1844130c across repeated runs; mechanisms read in code or in the children's
 * logs as noted. See "THE LEGACY CONTROL ARM" above for how this is enforced.
 */
const KNOWN: Record<string, Known> = {
  // The message forwarded into the stalled link never reached the daemon (the
  // lane waits until the stall holds its frame, so the server HAS attempted it); the
  // re-forward after the server restart carries `deliveryRecovery` (inbox.ts
  // `attempts > 0`) and the daemon fails any recovery row it does not know
  // without typing it (delivery-queue.ts `deliveryRecovery ⇒ failed`).
  // Since POD-4775 the daemon labels that failure `unconfirmed` and the server
  // records the row `unknown` rather than failed — honest, but outside this
  // scenario's declared window until the journal can tell "never typed".
  'server-crash': {
    must: [['lost', 'unknown-outside-window']],
    may: SCREEN_ECHO,
    until: 'POD-4777 (daemon delivery journal replaces the recovery ⇒ failed rule)',
  },
  // A new daemon receives the waiting row as a recovery row and fails it
  // untyped — or, on some runs, never settles it at all.
  // Since POD-4775 that failure is recorded `unknown` (see server-crash).
  'daemon-crash-queued': {
    must: [['lost', 'stuck', 'unknown-outside-window']],
    may: SCREEN_ECHO,
    until: 'POD-4777',
  },
  // Typed before the kill. Since POD-4775 the new daemon's recovery failure is
  // labelled `unconfirmed` and the server records the row `unknown` — the
  // allowed answer here — which is what this scenario shows on most runs. On
  // some runs the old race remains: the row left dispatched, or failed
  // although the agent has it, or the follow-up message failed untyped.
  'daemon-crash-typing': {
    must: [],
    may: ['status-lies', 'stuck', 'lost', ...SCREEN_ECHO],
    until: 'POD-4777',
  },
  // command-plane.ts sendHandler: a session whose machine is `reconnecting`
  // dead-letters the send ("not sent — machine unreachable") instead of storing
  // and forwarding it. When the send beats the server's own notice that the
  // daemon died, it is instead forwarded into the dead link and left
  // `dispatched` for good.
  'daemon-crash-before': {
    must: [['lost', 'stuck']],
    may: SCREEN_ECHO,
    until: 'POD-4775 (server stores and forwards, never decides on machine state) / POD-4777',
  },
  // The server marks the row `cancelled` at once. Since POD-4764 every device
  // learns it from the synced record, so no screen lies about it any more.
  // What is left is the race: when the cancel loses to the daemon's queue, the
  // message is typed anyway and the row still says `cancelled`.
  'device-retract-queued': {
    must: [],
    may: ['status-lies'],
    until: 'POD-4776 (retract answered by the daemon)',
  },
  // The server says `cancelled` before the daemon agreed; the agent has it.
  'device-retract-typing': {
    must: ['status-lies'],
    may: SCREEN_ECHO,
    until: 'POD-4776 (retract answered by the daemon)',
  },
  // Since POD-4796 the reports replayed after the reconnect are applied (the
  // gate rejected them as `stale-observer-generation`). What is left is the
  // daemon's own verdict, traced in the gate's log: each message typed DURING
  // the cut comes back from the driver unverified, so the daemon reports it
  // unconfirmed and the row ends `unknown` though the agent has it. (No frame
  // storm on this base: the storm check stays armed.)
  'link-cut-minutes-storm': {
    must: ['unknown-outside-window'],
    may: ['stuck', ...SCREEN_ECHO],
    until: 'POD-4777 (the daemon settles a typed message by its journal, not by a live receipt)',
  },
}

const CLEAN: Known = { must: [], until: "nothing — this scenario is clean on today's base" }

function known(scenario: string): Known {
  return KNOWN[scenario] ?? CLEAN
}

async function judge(
  world: DeliveryWorld,
  scenario: string,
  messages: readonly TrackedMessage[],
  /** Further checks, evaluated once the chain has come to rest. */
  extra: () => readonly Violation[] = () => [],
): Promise<void> {
  await world.settle(messages)
  const observation = await world.observe(messages)
  const found = [...violations(observation), ...extra()]
  const kinds = kindsOf(found)
  const expected = known(scenario)
  const report = JSON.stringify(
    {
      scenario,
      found,
      rows: observation.rows.map((row) => ({
        id: row.id,
        status: row.deliveryStatus,
        reason: row.reason,
        body: row.body,
      })),
      screens: observation.devices.map((device) => ({
        device: device.device,
        shown: [...device.screen].map(([id, shown]) => ({ id, ...shown })),
      })),
      typed: observation.typed.map((prompt) => prompt.prompt),
    },
    null,
    2,
  )
  console.log(`[delivery-outage] ${report}`)
  const listed = new Set<ViolationKind>([...expected.must.flat(), ...(expected.may ?? [])])
  const unexpected = kinds.filter((kind) => !listed.has(kind))
  expect(
    unexpected,
    `NEW delivery defects in "${scenario}":\n${report}\n${world.logs(3_000)}`,
  ).toEqual([])
  const gone = expected.must
    .map((entry) => (typeof entry === 'string' ? [entry] : entry))
    .filter((anyOf) => !anyOf.some((kind) => kinds.includes(kind)))
  expect(
    gone,
    `"${scenario}" no longer shows ${gone.map((anyOf) => anyOf.join('|')).join(', ')} — ${expected.until} may have landed: delete it from KNOWN so this lane guards the fix\n${report}`,
  ).toEqual([])
}

function open(options: {
  sessions: number
  devices: readonly string[]
  issue?: boolean
}): Promise<DeliveryWorld> {
  return DeliveryWorld.start({ root: harness.base, ...options, logLevel: 'info' })
}

function only<T>(values: readonly T[], what: string): T {
  const [value] = values
  if (value === undefined) throw new Error(`no ${what}`)
  return value
}

async function waitTyped(world: DeliveryWorld, id: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    () => world.typedCount(id) > 0,
    timeoutMs,
    `${id} typed`,
    () => world.logs(),
  )
}

/**
 * Wait until the server has a row for the message or its sender gave up on it
 * — whichever the chain does. A refusal is a finding for the oracle to report,
 * not a harness timeout; after `timeoutMs` the scenario moves on regardless.
 */
async function waitAnswered(
  world: DeliveryWorld,
  device: string,
  sessionId: SessionId,
  id: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    async () =>
      world
        .device(device)
        .heldSends(sessionId)
        .some((send) => send.mutationId === id && send.state === 'failed') ||
      (await world.rows()).some((row) => row.id === id),
    timeoutMs,
    `${id} answered`,
  ).catch(() => undefined)
}

/** The server → daemon frame that carried a message toward its agent. */
function carrier(world: DeliveryWorld, id: string): Record<string, unknown> | undefined {
  return world.link
    .crossed({ dir: 'down' })
    .find(
      (frame) => frame.type.startsWith('runtime') && JSON.stringify(frame.body ?? {}).includes(id),
    )?.body
}

async function waitCarried(
  world: DeliveryWorld,
  id: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  await waitFor(
    () => carrier(world, id) !== undefined,
    timeoutMs,
    `${id} carried down the link`,
    () => world.logs(),
  )
  return carrier(world, id) as Record<string, unknown>
}

const delivered = (id: string, sessionId: SessionId, sender = 'phone'): TrackedMessage => ({
  id,
  sessionId,
  expect: 'delivered',
  sender,
})

describe('message delivery under real failures', { retry: 0 }, () => {
  it('baseline: no fault — every message typed once, confirmed, drawn once on every device', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      const sent = ['one', 'two', 'three'].map((label) =>
        delivered(phone.send(session, label).id, session),
      )
      await judge(world, 'baseline', sent)
    } finally {
      await world.close()
    }
  }, 240_000)

  // -------------------------------------------------------------------------
  // 1. The server is killed while messages are queued, in flight, just typed.
  // -------------------------------------------------------------------------
  it('server kill -9: one message just typed, one held by the daemon, one forwarded into a stalled link', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      world.setTurnMs(session, 6_000)
      // Typed, but the agent shows no sign of it for 3 s: its proof reaches the
      // daemon while the server is dead.
      world.setHookDelayMs(session, 3_000)
      const typed = phone.send(session, 'typed just before the server died')
      await waitTyped(world, typed.id)
      world.setHookDelayMs(session, 0)
      const held = phone.send(session, 'held by the daemon behind a working turn')
      await waitCarried(world, held.id)
      world.link.stall()
      const queued = phone.send(session, 'forwarded into the stalled link, never arrived')
      // The server has handed it on: the stall holds its frame.
      await waitFor(
        () =>
          world.link
            .holding('down')
            .some((frame) => JSON.stringify(frame.body ?? {}).includes(queued.id)),
        30_000,
        'the queued message forwarded into the stalled link',
        () => world.logs(),
      )
      await world.server.crash()
      world.link.restore()
      await world.server.restart()
      await judge(world, 'server-crash', [
        delivered(typed.id, session),
        delivered(held.id, session),
        delivered(queued.id, session),
      ])
    } finally {
      await world.close()
    }
  }, 300_000)

  // -------------------------------------------------------------------------
  // 2. The daemon is killed at each point a message can be in.
  // -------------------------------------------------------------------------
  it('daemon kill -9 while a message waits in its queue behind a working turn', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      world.setTurnMs(session, 6_000)
      const first = phone.send(session, 'the turn the agent is working on')
      await waitTyped(world, first.id)
      const waiting = phone.send(session, 'waiting in the daemon queue')
      await waitCarried(world, waiting.id)
      await world.daemon.crash()
      await world.daemon.restart()
      await judge(world, 'daemon-crash-queued', [
        delivered(first.id, session),
        delivered(waiting.id, session),
      ])
    } finally {
      await world.close()
    }
  }, 300_000)

  it('daemon kill -9 between typing and proof — the one ambiguous window', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      world.setHookDelayMs(session, 8_000)
      const typing = phone.send(session, 'typed, then the daemon died before any proof')
      await waitTyped(world, typing.id)
      await world.daemon.crash()
      world.setHookDelayMs(session, 0)
      await world.daemon.restart()
      await waitFor(
        async () => (await world.session(session))?.status === 'live',
        60_000,
        'the session live again',
      )
      // The session still works afterwards.
      const after = phone.send(session, 'sent after the daemon came back')
      await judge(world, 'daemon-crash-typing', [
        { id: typing.id, sessionId: session, expect: 'ambiguous', sender: 'phone' },
        delivered(after.id, session),
      ])
    } finally {
      await world.close()
    }
  }, 300_000)

  it('daemon kill -9 before a message reaches it — stored at the server meanwhile', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      await world.daemon.crash()
      const stored = phone.send(session, 'sent while the daemon was dead')
      await waitAnswered(world, 'phone', session, stored.id)
      await world.daemon.restart()
      await judge(world, 'daemon-crash-before', [delivered(stored.id, session)])
    } finally {
      await world.close()
    }
  }, 300_000)

  it('daemon kill -9 after typing and proof, before the server heard the outcome', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      const proven = phone.send(session, 'typed and proven; the report never arrived')
      const request = await waitCarried(world, proven.id)
      const rowId = typeof request.rowId === 'string' ? request.rowId : proven.id
      // Every report the daemon sends about this message is lost on the way.
      world.link.drop(
        'up',
        (frame) =>
          frame.type === 'runtimeEvent' && JSON.stringify(frame.body ?? {}).includes(rowId),
        Number.POSITIVE_INFINITY,
      )
      await waitTyped(world, proven.id)
      await waitFor(
        () => world.hookAccepted(session, 'UserPromptSubmit'),
        20_000,
        'the proof to reach the daemon',
      )
      await sleep(1_500)
      await world.daemon.crash()
      world.link.clearDrops()
      await world.daemon.restart()
      await judge(world, 'daemon-crash-unreported', [delivered(proven.id, session)])
    } finally {
      await world.close()
    }
  }, 300_000)

  // -------------------------------------------------------------------------
  // 3. The daemon's link: cut for seconds, degraded.
  //    (Cut for minutes is the storm scenario below.)
  // -------------------------------------------------------------------------
  it('link cut for seconds during sends', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      world.setTurnMs(session, 500)
      const before = phone.send(session, 'before the cut')
      await waitTyped(world, before.id)
      world.link.cut()
      const during = [
        phone.send(session, 'during the cut, one'),
        phone.send(session, 'during the cut, two'),
      ]
      await sleep(5_000)
      world.link.restore()
      await judge(
        world,
        'link-cut-seconds',
        [before, ...during].map((sent) => delivered(sent.id, session)),
      )
    } finally {
      await world.close()
    }
  }, 300_000)

  it('link degraded: every frame delayed, one delivery report lost', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      world.link.setDelay(400)
      world.link.drop(
        'up',
        (frame) =>
          frame.type === 'runtimeEvent' && JSON.stringify(frame.body ?? {}).includes('"delivery"'),
        1,
      )
      const sent = ['slow one', 'slow two', 'slow three', 'slow four'].map((label) =>
        phone.send(session, label),
      )
      await judge(
        world,
        'link-degraded',
        sent.map((one) => delivered(one.id, session)),
      )
    } finally {
      await world.close()
    }
  }, 300_000)

  // -------------------------------------------------------------------------
  // 4. Devices: reload, offline past the give-up window, a lost answer, a
  //    second device retracting.
  // -------------------------------------------------------------------------
  it('device reload mid-send, then offline past the give-up window, then the user retries', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      const inFlight = [
        phone.send(session, 'sent, then the app reloaded'),
        phone.send(session, 'also in flight at the reload'),
      ]
      await world.reloadDevice('phone')
      // The reloaded app finishes what the last life started…
      for (const sent of inFlight) await waitAnswered(world, 'phone', session, sent.id)
      // …then the phone goes into a tunnel.
      phone.setOnline(false)
      const offline = phone.send(session, 'written in a tunnel')
      await sleep(2_000)
      await world.reloadDevice('phone')
      // Still offline: the queue gives up with "not sent" after its window.
      await waitFor(
        () =>
          phone
            .heldSends(session)
            .some((send) => send.mutationId === offline.id && send.state === 'failed'),
        200_000,
        'the offline send to give up',
      )
      phone.setOnline(true)
      await phone.retry(session, offline.id)
      await judge(
        world,
        'device-reload-offline-retry',
        [...inFlight, offline].map((sent) => delivered(sent.id, session)),
      )
    } finally {
      await world.close()
    }
  }, 420_000)

  it('device loses the server answer to a send — the queue repeats the same id', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      phone.loseNextAnswer('sessions.sendText')
      const lost = phone.send(session, 'stored, but the answer never came back')
      await judge(world, 'device-answer-lost', [delivered(lost.id, session)])
      // The setup fired: one answer was lost, and the queue asked again.
      expect(phone.answersLost).toBe(1)
      expect(phone.calls.get('sessions.sendText') ?? 0).toBeGreaterThanOrEqual(2)
    } finally {
      await world.close()
    }
  }, 300_000)

  it('second device retracts a queued message before it is typed', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      world.setTurnMs(session, 8_000)
      const busy = phone.send(session, 'keeps the agent busy')
      await waitTyped(world, busy.id)
      const retracted = phone.send(session, 'retracted from the laptop')
      await waitAnswered(world, 'phone', session, retracted.id)
      await world.device('laptop').retract(session, retracted.id)
      const after = phone.send(session, 'sent after the retract')
      await judge(world, 'device-retract-queued', [
        delivered(busy.id, session),
        { id: retracted.id, sessionId: session, expect: 'retracted', sender: 'phone' },
        delivered(after.id, session),
      ])
    } finally {
      await world.close()
    }
  }, 300_000)

  it('second device retracts a message the daemon is already typing', async () => {
    const world = await open({ sessions: 1, devices: ['phone', 'laptop'] })
    try {
      const session = only(world.sessionIds, 'session')
      const phone = world.device('phone')
      world.setHookDelayMs(session, 5_000)
      const late = phone.send(session, 'retracted too late')
      await waitTyped(world, late.id)
      await world.device('laptop').retract(session, late.id)
      world.setHookDelayMs(session, 0)
      await judge(world, 'device-retract-typing', [
        { id: late.id, sessionId: session, expect: 'retracted', sender: 'phone' },
      ])
    } finally {
      await world.close()
    }
  }, 300_000)

  // -------------------------------------------------------------------------
  // 5. An agent's CLI send whose relay timed out, run again.
  // -------------------------------------------------------------------------
  it('agent CLI send whose relay answer is lost: repeated by the CLI, or rerun by the agent', async () => {
    const world = await open({ sessions: 2, devices: ['phone'], issue: true })
    try {
      const [sender, target] = world.sessionIds
      if (!sender || !target) throw new Error('two sessions')
      const token = `msg_${randomUUID()}`
      const text = messageText(token, 'from an agent; its first relay answer was lost')
      // The server handles the send; its answer never reaches the daemon, so
      // the relay times out under the CLI, and the CLI does what it does next.
      world.link.drop('down', (frame) => frame.type === 'agentRelayResult', 1)
      // …and when the CLI reports failure, the agent runs the command again.
      const reruns = await world.cliSend(sender, target, text).then(
        () => 0,
        async (error: unknown) => {
          console.log(`[delivery-outage] the CLI failed, the agent reruns it: ${String(error)}`)
          await world.cliSend(sender, target, text)
          return 1
        },
      )
      console.log(`[delivery-outage] agent reruns: ${reruns}`)
      // The setup fired: one relay answer was lost on the way back.
      expect(
        world.link.frames.filter((frame) => frame.dropped && frame.type === 'agentRelayResult'),
      ).toHaveLength(1)
      await judge(world, 'agent-cli-repeat', [
        { id: token, sessionId: target, expect: 'delivered', trackedBy: 'text' },
      ])
    } finally {
      await world.close()
    }
  }, 300_000)

  // -------------------------------------------------------------------------
  // 6. A backlog across sessions meets a reconnect after minutes away.
  // -------------------------------------------------------------------------
  it('link cut for minutes with a backlog across sessions, then reconnect: no loss, no storm', async () => {
    const world = await open({ sessions: 3, devices: ['phone', 'laptop'] })
    try {
      const phone = world.device('phone')
      // Busy agents, so the backlog is still unconfirmed when the link goes:
      // each session's first message is being worked on, the rest wait.
      for (const session of world.sessionIds) world.setTurnMs(session, 20_000)
      const backlog: TrackedMessage[] = []
      for (const session of world.sessionIds) {
        for (const label of ['a', 'b', 'c', 'd'])
          backlog.push(delivered(phone.send(session, `backlog ${label}`).id, session))
      }
      for (const message of backlog)
        await waitAnswered(world, 'phone', message.sessionId as SessionId, message.id)
      world.link.cut()
      // Longer than the server's re-forward sweep (60 s), twice.
      await sleep(125_000)
      for (const session of world.sessionIds) world.setTurnMs(session, 300)
      const reconnectedAt = Date.now()
      world.link.restore()
      await judge(world, 'link-cut-minutes-storm', backlog, () =>
        stormViolations(world.link.frames, reconnectedAt, {
          backlog: backlog.length,
          perMessage: 2,
          fixed: 0,
        }),
      )
    } finally {
      await world.close()
    }
  }, 480_000)
})
