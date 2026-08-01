/**
 * SessionService decomposition oracle (POD-392).
 *
 * The earlier session-write oracle pins lifecycle and inbox commands. This file
 * adds the current-head seams that arrived later and a real two-account fixture.
 * Provisional assertions are evidence about an open decision or a known gap,
 * never a demand that the extracted modules preserve the gap.
 */

import {
  type Attribution,
  actorUser,
  asSessionId,
  asUserId,
  FIRST_ADMIN_USER_ID,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommandPrincipal } from '../../command-principal'
import { mailHarness } from '../messages/characterization-support'
import {
  disposeOracles,
  MUST_NOT_CHANGE,
  makeOracle,
  messageOf,
  provisional,
} from './oracle-support'
import { type PresencePrincipal, PresenceRegistry } from './presence-registry'

afterEach(() => disposeOracles())

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')
const ALICE_SESSION = asSessionId('10000000-0000-4000-8000-000000000001')
const BOB_SESSION = asSessionId('20000000-0000-4000-8000-000000000002')

function seedUser(
  store: ReturnType<typeof makeOracle>['store'],
  id: UserId,
  displayName: string,
): void {
  // User lifecycle writes are intentionally absent from UsersRepository.
  // @ts-expect-error test-only seed through SessionStore's private connection
  store.db
    .prepare(
      "INSERT INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, ?, 'member', '2026-08-01T00:00:00.000Z', NULL)",
    )
    .run(id, displayName)
}

function delegatedAgent(sessionId: SessionId, onBehalfOf: UserId): AgentCommandPrincipal {
  return {
    kind: 'agent',
    agentSessionId: sessionId,
    onBehalfOf,
    capability: {
      role: 'worker',
      scope: { kind: 'self', userId: onBehalfOf },
      actorSessionId: sessionId,
      onBehalfOf,
    },
    chain: [],
  }
}

function presencePrincipal(agent: AgentCommandPrincipal): PresencePrincipal {
  return {
    userId: agent.onBehalfOf,
    capability: agent.capability,
    actorSessionId: agent.agentSessionId,
    onBehalfOf: agent.onBehalfOf,
    humanDirect: false,
  }
}

function twoUserOracle() {
  const o = makeOracle()
  seedUser(o.store, ALICE, 'Alice')
  seedUser(o.store, BOB, 'Bob')
  const alice = o.reg.modules.sessions.createSession({
    sessionId: ALICE_SESSION,
    agentKind: 'codex',
    cwd: '/work/alice',
    binding: { principal: { kind: 'user', userId: ALICE } },
  })
  const bob = o.reg.modules.sessions.createSession({
    sessionId: BOB_SESSION,
    agentKind: 'codex',
    cwd: '/work/bob',
    binding: { principal: { kind: 'user', userId: BOB } },
  })
  const agents = {
    alice: delegatedAgent(alice.sessionId, ALICE),
    bob: delegatedAgent(bob.sessionId, BOB),
  }
  const presence = new PresenceRegistry({
    sessions: o.reg.modules.sessions,
    store: o.store,
    now: () => Date.now(),
    mutations: o.reg.modules.mutations,
  })
  return { o, alice, bob, agents, presence }
}

describe('oracle: two-user SessionService fixture', () => {
  it(`${MUST_NOT_CHANGE}: contains two accounts, one session each, and one delegated agent principal per human`, () => {
    const f = twoUserOracle()
    expect(f.o.store.users.get(ALICE)).toMatchObject({ id: ALICE, displayName: 'Alice' })
    expect(f.o.store.users.get(BOB)).toMatchObject({ id: BOB, displayName: 'Bob' })
    expect(f.agents.alice).toMatchObject({
      agentSessionId: ALICE_SESSION,
      onBehalfOf: ALICE,
    })
    expect(f.agents.bob).toMatchObject({
      agentSessionId: BOB_SESSION,
      onBehalfOf: BOB,
    })
    const spawns = f.o.daemon.filter(
      (message): message is Extract<ControlMessage, { type: 'spawn' }> => message.type === 'spawn',
    )
    expect(spawns.map((message) => message.binding?.principal)).toEqual([
      { kind: 'user', userId: ALICE },
      { kind: 'user', userId: BOB },
    ])
  })

  it(`${provisional('readiness-3.1.1', 'session ownership and private visibility have not reached this service')}: both sessions resolve to user:sole and an unrelated viewer receives both`, () => {
    const f = twoUserOracle()
    expect(f.o.reg.modules.sessions.sessionOwner(f.alice.sessionId)).toEqual({
      owner: FIRST_ADMIN_USER_ID,
      grants: [],
    })
    expect(f.o.reg.modules.sessions.sessionOwner(f.bob.sessionId)).toEqual({
      owner: FIRST_ADMIN_USER_ID,
      grants: [],
    })
    expect(
      f.o.reg.modules.sessions
        .listSessions(actorUser(BOB))
        .map((session) => session.sessionId)
        .sort(),
    ).toEqual([ALICE_SESSION, BOB_SESSION].sort())
  })
})

describe('oracle: durable per-user session state (not live co-presence)', () => {
  it(`${MUST_NOT_CHANGE}: snooze, pins, and tab order are isolated for both users, and payload identity is inert`, () => {
    const f = twoUserOracle()
    const alice = presencePrincipal(f.agents.alice)
    const bob = presencePrincipal(f.agents.bob)
    const aliceUntil = '2099-08-01T01:00:00.000Z'
    const bobUntil = '2099-08-01T02:00:00.000Z'
    f.presence.execute(
      'snoozes.set',
      {
        sessionId: f.alice.sessionId,
        until: aliceUntil,
        userId: BOB,
        actor: BOB_SESSION,
        onBehalfOf: BOB,
      },
      alice,
    )
    f.presence.execute('snoozes.set', { sessionId: f.alice.sessionId, until: bobUntil }, bob)
    f.presence.execute('pins.set', { kind: 'panel', id: f.alice.sessionId, pinned: true }, alice)
    f.presence.execute('pins.set', { kind: 'panel', id: f.bob.sessionId, pinned: true }, bob)
    f.presence.execute(
      'tabs.setOrder',
      { worktree: '/work', sessionIds: [f.alice.sessionId, f.bob.sessionId] },
      alice,
    )
    f.presence.execute(
      'tabs.setOrder',
      { worktree: '/work', sessionIds: [f.bob.sessionId, f.alice.sessionId] },
      bob,
    )
    expect(f.o.store.sessions.listSnoozes(ALICE)).toEqual({
      [f.alice.sessionId]: aliceUntil,
    })
    expect(f.o.store.sessions.listSnoozes(BOB)).toEqual({
      [f.alice.sessionId]: bobUntil,
    })
    expect(f.o.store.sessions.listPins(ALICE).panels).toEqual([f.alice.sessionId])
    expect(f.o.store.sessions.listPins(BOB).panels).toEqual([f.bob.sessionId])
    expect(f.o.store.sessions.listTabOrders(ALICE)).toEqual({
      '/work': [f.alice.sessionId, f.bob.sessionId],
    })
    expect(f.o.store.sessions.listTabOrders(BOB)).toEqual({
      '/work': [f.bob.sessionId, f.alice.sessionId],
    })
  })

  it(`${provisional('POD-393', 'markRead currently routes through the single broadcast viewer instead of the calling user')}: two principals both mutate user:sole readAt while their own rows stay absent`, () => {
    const f = twoUserOracle()
    f.presence.execute(
      'sessions.markRead',
      { sessionId: f.alice.sessionId },
      presencePrincipal(f.agents.alice),
    )
    expect(f.o.store.sessions.listReadAt(ALICE)).toEqual({})
    expect(f.o.store.sessions.listReadAt(BOB)).toEqual({})
    expect(f.o.store.sessions.listReadAt(FIRST_ADMIN_USER_ID)[f.alice.sessionId]).toEqual(
      expect.any(String),
    )
    f.presence.execute(
      'sessions.markUnread',
      { sessionId: f.alice.sessionId },
      presencePrincipal(f.agents.bob),
    )
    expect(f.o.store.sessions.listReadAt(FIRST_ADMIN_USER_ID)).toEqual({})
  })
})

describe('oracle: activity flush and cumulative compute', () => {
  it(`${MUST_NOT_CHANGE}: frame activity writes once at flush, a clean flush writes nothing, and daemon counter resets accumulate`, () => {
    const o = makeOracle()
    const { sessionId } = o.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/work',
    })
    o.reg.gateway.routeDaemonFrame('local', {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/work',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    const writes = vi.spyOn(o.store.sessions, 'upsertSession')
    for (let seq = 0; seq < 3; seq++) {
      o.reg.gateway.routeDaemonFrame('local', {
        type: 'agentFrame',
        sessionId,
        seq,
        data: 'eA==',
      })
    }
    expect(writes).not.toHaveBeenCalled()
    o.reg.modules.sessions.flushActivity()
    expect(writes).toHaveBeenCalledTimes(1)
    expect(
      o.store.sessions.loadSessions().find((row) => row.id === sessionId)?.lastOutputAt,
    ).not.toBeNull()
    writes.mockClear()
    o.reg.modules.sessions.flushActivity()
    expect(writes).not.toHaveBeenCalled()

    const state = (phase: 'working' | 'idle', workingMsTotal: number, since: string) => ({
      phase,
      since,
      workingMsTotal,
      nativeSubagentCount: 0,
      ...(phase === 'idle' ? { idle: { kind: 'done' as const } } : {}),
    })
    for (const next of [
      state('working', 0, '2026-08-01T00:00:00.000Z'),
      state('idle', 5_000, '2026-08-01T00:00:05.000Z'),
      state('working', 0, '2026-08-01T00:01:00.000Z'),
      state('idle', 2_000, '2026-08-01T00:01:02.000Z'),
    ]) {
      o.reg.gateway.routeDaemonFrame('local', { type: 'agentState', sessionId, state: next })
    }
    expect(
      o.store.sessions.loadSessions().find((row) => row.id === sessionId)?.workingMsTotal,
    ).toBe(7_000)
    expect(o.meta(sessionId).agentState?.workingMsTotal).toBe(7_000)
  })
})

describe('oracle: priority pushes', () => {
  const priorities = (messages: ControlMessage[]) =>
    messages.filter(
      (message): message is Extract<ControlMessage, { type: 'sessionPriority' }> =>
        message.type === 'sessionPriority',
    )

  it(`${provisional('readiness-3.3', 'the priority-push flag is not yet classified as session-owned or per-user')}: focused is tier 0, visible is tier 1, unchanged view state sends no duplicate, and reconnect replays the map`, () => {
    const o = makeOracle()
    const first = o.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/one',
    }).sessionId
    const second = o.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/two',
    }).sessionId
    const clientId = o.reg.clientGateway.attachClient(() => {})
    o.daemon.length = 0

    const viewState = { type: 'viewState' as const, visible: [first, second], focused: second }
    o.reg.clientGateway.routeClientFrame(clientId, viewState)
    expect(priorities(o.daemon)).toEqual(
      expect.arrayContaining([
        { type: 'sessionPriority', sessionId: first, priority: 1 },
        { type: 'sessionPriority', sessionId: second, priority: 0 },
      ]),
    )
    o.daemon.length = 0
    o.reg.clientGateway.routeClientFrame(clientId, viewState)
    expect(priorities(o.daemon)).toEqual([])

    o.reg.gateway.detachDaemon('local')
    const reconnected: ControlMessage[] = []
    o.reg.gateway.attachDaemon('local', (message) => reconnected.push(message))
    expect(priorities(reconnected)).toEqual(
      expect.arrayContaining([
        { type: 'sessionPriority', sessionId: first, priority: 1 },
        { type: 'sessionPriority', sessionId: second, priority: 0 },
      ]),
    )
  })
})

describe('oracle: queued sends re-authorize at drain', () => {
  it(`${MUST_NOT_CHANGE}: a send accepted before revocation dead-letters at drain and never reaches the target PTY`, () => {
    let revoked = false
    const h = mailHarness({
      authorizeAtApply: () =>
        revoked ? { ok: false, reason: 'sender no longer has access to the target' } : { ok: true },
    })
    try {
      const target = h.createIssue({ title: 'target' })
      const sender = h.createIssue({ title: 'sender' })
      h.put({ sessionId: asSessionId('sender-agent'), issueId: sender.id, phase: 'idle' })
      const sent = h.svc.send(
        { kind: 'agent', issueId: sender.id, sessionId: asSessionId('sender-agent') },
        { to: { kind: 'issue', id: target.id }, body: 'queued before revoke' },
      )
      expect(sent.disposition).toBe('held')

      revoked = true
      h.put({ sessionId: asSessionId('target-agent'), issueId: target.id, phase: 'idle' })
      h.svc.sweep()

      expect(h.svc.message(sent.message.id)?.status).toBe('dead_letter')
      expect(h.pushes.filter((push) => push.sessionId === 'target-agent')).toEqual([])
      expect(
        h.svc
          .inbox([{ kind: 'session', id: 'sender-agent' }], { limit: 50 })
          .some((message) => message.body.includes('sender no longer has access')),
      ).toBe(true)
    } finally {
      h.store.close()
    }
  })
})

describe('oracle: native identity receipts', () => {
  it(`${provisional('readiness-3.1.3-A4', 'receipt owner still comes from the user:sole session ownership answer')}: an exact Codex identity is persisted before the owner-scoped ack, and a Bob binding still receives user:sole`, () => {
    const f = twoUserOracle()
    f.o.daemon.length = 0

    f.o.reg.gateway.routeDaemonFrame('local', {
      type: 'sessionResumeRef',
      sessionId: f.bob.sessionId,
      resume: { kind: 'codex-thread', value: 'thread-bob' },
      confidence: 'exact',
      ackRequested: true,
    })

    expect(f.o.meta(f.bob.sessionId).resume).toEqual({
      kind: 'codex-thread',
      value: 'thread-bob',
    })
    expect(f.o.daemon).toContainEqual({
      type: 'sessionResumeRefAck',
      sessionId: f.bob.sessionId,
      resume: { kind: 'codex-thread', value: 'thread-bob' },
      ownerId: FIRST_ADMIN_USER_ID,
    })
  })
})

describe('oracle: browser-open forwarding', () => {
  it(`${MUST_NOT_CHANGE}: forwards an owning-daemon intent and stamps callback identity from the authenticated browser, never payload`, () => {
    const o = makeOracle()
    const { sessionId } = o.reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/work',
    })
    const browser: ServerMessage[] = []
    const clientId = o.reg.clientGateway.attachClient((message) => browser.push(message))
    o.reg.gateway.attachDaemon('foreign', () => {})
    o.daemon.length = 0
    browser.length = 0

    o.reg.gateway.routeDaemonFrame('foreign', {
      type: 'sessionOpenUrl',
      sessionId,
      requestId: 'forged-open',
      url: 'https://auth.example/forged',
      callbackTarget: { host: 'localhost', port: 1455, path: '/callback' },
      expiresAt: Date.now() + 60_000,
    })
    expect(browser).not.toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'forged-open' }),
    )

    o.reg.gateway.routeDaemonFrame('local', {
      type: 'sessionOpenUrl',
      sessionId,
      requestId: 'open-1',
      url: 'https://auth.example/authorize',
      callbackTarget: { host: 'localhost', port: 1455, path: '/callback' },
      expiresAt: Date.now() + 60_000,
    })
    expect(browser).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-1' }),
    )

    const forged = {
      actor: actorUser(asUserId('user:attacker')),
      onBehalfOf: asUserId('user:attacker'),
    } satisfies Attribution
    o.reg.clientGateway.routeClientFrame(clientId, {
      type: 'sessionOpenUrlCallback',
      sessionId,
      requestId: 'open-1',
      url: 'http://localhost:1455/callback?code=x',
      resolvedBy: forged,
    })

    expect(o.daemon).toContainEqual({
      type: 'sessionOpenUrlCallback',
      sessionId,
      requestId: 'open-1',
      url: 'http://localhost:1455/callback?code=x',
      resolvedBy: {
        actor: actorUser(FIRST_ADMIN_USER_ID),
        onBehalfOf: FIRST_ADMIN_USER_ID,
      },
    })
    expect(o.daemon).not.toContainEqual(expect.objectContaining({ resolvedBy: forged }))
  })
})

describe('oracle: spawn placement fails closed', () => {
  it(`${MUST_NOT_CHANGE}: denied and offline are distinct, neither spawns, and the same online machine succeeds when use is allowed`, async () => {
    const o = makeOracle({
      machineId: 'online',
      offlineMachines: [
        { id: 'online', name: 'Online' },
        { id: 'offline', name: 'Offline' },
      ],
    })
    const sessions = () => o.reg.modules.sessions.listSessions().length

    expect(
      await messageOf(() =>
        o.reg.modules.sessions.createSession({
          agentKind: 'claude-code',
          cwd: '/work',
          machineId: 'online',
          use: () => 'denied',
        }),
      ),
    ).toBe("you do not have access to run agents on machine 'Online'")
    expect(sessions()).toBe(0)

    expect(
      await messageOf(() =>
        o.reg.modules.sessions.createSession({
          agentKind: 'claude-code',
          cwd: '/work',
          machineId: 'offline',
          use: () => 'granted',
        }),
      ),
    ).toBe("machine 'Offline' is offline")
    expect(sessions()).toBe(0)

    expect(
      o.reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/work',
        machineId: 'online',
        use: () => 'granted',
      }).sessionId,
    ).toEqual(expect.any(String))
    expect(sessions()).toBe(1)
  })
})
