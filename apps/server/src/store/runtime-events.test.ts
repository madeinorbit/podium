import { asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import type { RuntimeEvent } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import {
  RuntimeEventGate,
  type RuntimeEventGatePorts,
} from '../modules/sessions/runtime-event-gate'
import {
  mergeLatestTranscriptPage,
  mergeTranscriptItems,
} from '../modules/sessions/terminal'
import { SessionRegistry } from '../relay'
import { SessionStore } from '../store'
import type { RuntimeEventLogRecord } from './events'

function stateEvent(input: {
  at: string
  seq: number
  observerGeneration: number
  turnEpoch?: number
  provenance?: RuntimeEvent['provenance']
  segmentId?: string
  predecessorSegmentId?: string
  change?: Record<string, unknown>
}): RuntimeEvent {
  return {
    t: 'state',
    change: input.change ?? { kind: 'activity' },
    at: input.at,
    provenance: input.provenance ?? 'live',
    cursor: {
      segmentId: input.segmentId ?? 'runtime-segment',
      ...(input.predecessorSegmentId ? { predecessorSegmentId: input.predecessorSegmentId } : {}),
      components: { seq: input.seq },
    },
    observerGeneration: input.observerGeneration,
    turnEpoch: input.turnEpoch ?? 1,
  }
}

function turnEvent(input: {
  at: string
  seq: number
  turnEpoch: number
  ev: 'started' | 'completed' | 'failed'
  provenance?: RuntimeEvent['provenance']
}): RuntimeEvent {
  const ev =
    input.ev === 'failed'
      ? ({
          ev: 'failed',
          turnEpoch: input.turnEpoch,
          reason: 'provider-error',
          disposition: 'needs-human',
        } as const)
      : input.ev === 'completed'
        ? ({ ev: 'completed', turnEpoch: input.turnEpoch, verdict: 'done' } as const)
        : ({ ev: 'started', turnEpoch: input.turnEpoch, origin: 'human' } as const)
  return {
    t: 'turn',
    ev,
    at: input.at,
    provenance: input.provenance ?? 'live',
    cursor: { segmentId: 'runtime-segment', components: { seq: input.seq } },
    observerGeneration: 1,
    turnEpoch: input.turnEpoch,
  }
}

function terminalItemEvent(input: {
  at: string
  seq: number
  item: {
    id: string
    cursor: string
    role: 'user' | 'assistant'
    text: string
    ts: string
  }
}): RuntimeEvent {
  return {
    t: 'item',
    item: { kind: 'complete', item: input.item },
    at: input.at,
    provenance: 'live',
    cursor: { segmentId: 'runtime-segment', components: { seq: input.seq } },
    observerGeneration: 1,
    turnEpoch: 1,
  }
}

function bindContract(registry: SessionRegistry, store: SessionStore) {
  registry.gateway.attachDaemon(store.hostMachineId, () => {})
  const { sessionId } = registry.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: '/project',
  })
  registry.gateway.routeDaemonFrame(store.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'codex app-server',
    cwd: '/project',
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
    runtimeContract: true,
    driverId: 'codex-app-server',
  })
  return sessionId
}

describe('durable runtime observation gate', () => {
  it('accepts a generation-one live event after an empty bootstrap snapshot', () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)

    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'first-live-after-empty-bootstrap',
      sessionId,
      event: stateEvent({
        at: '2026-08-30T00:00:00.000Z',
        seq: 1,
        observerGeneration: 1,
        change: { kind: 'session_started' },
      }),
    })

    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(1)
    expect(store.events.runtimeEventCheckpoint(sessionId)).toMatchObject({
      observerGeneration: 1,
      cursor: { components: { seq: 1 } },
    })

    const replacementSessionId = bindContract(registry, store)
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'replacement-live-without-bootstrap',
      sessionId: replacementSessionId,
      event: stateEvent({
        at: '2026-08-30T00:00:01.000Z',
        seq: 1,
        observerGeneration: 2,
      }),
    })
    expect(store.events.listRuntimeEvents(replacementSessionId)).toHaveLength(0)
    expect(store.events.runtimeEventCheckpoint(replacementSessionId)).toBeNull()

    registry.dispose()
    store.close()
  })

  it('bridges real terminal items live and after reload without duplicate replay', async () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)

    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'bootstrap-terminal-transcript',
      sessionId,
      event: stateEvent({
        at: '2026-08-23T00:00:00.000Z',
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
        change: { kind: 'session_started' },
      }),
    })
    // Shape emitted by TerminalRuntime for a native Grok transcript tail: the
    // provider item identity rides inside a complete runtime item event.
    const items = [
      {
        id: 'grok-message-user-1',
        cursor: 'grok:messages.jsonl:0:91',
        role: 'user' as const,
        text: 'IDLE-DC53VW',
        ts: '2026-08-23T00:00:01.000Z',
      },
      {
        id: 'grok-message-assistant-1',
        cursor: 'grok:messages.jsonl:92:207',
        role: 'assistant' as const,
        text: 'Bridge control reply',
        ts: '2026-08-23T00:00:02.000Z',
      },
    ]
    // Either alias is sufficient: provider-derived ids can drift while cursors
    // stay stable, and a rewritten record can rotate its cursor under one id.
    expect(
      mergeTranscriptItems([{ ...items[0], id: 'derived-user-id' }], [items[0]], 50),
    ).toEqual([items[0]])
    expect(
      mergeTranscriptItems([{ ...items[0], cursor: 'grok:old-cursor' }], [items[0]], 50),
    ).toEqual([items[0]])
    // An unmatched older runtime row must not displace the true newest provider
    // row after cursor-based overlap is collapsed, and hasMore reflects the two
    // logical rows rather than the three physical inputs.
    expect(
      mergeLatestTranscriptPage(
        [{ ...items[1], id: 'provider-derived-assistant' }],
        [
          {
            ...items[0],
            id: 'older-runtime-only',
            cursor: 'grok:older-runtime-only',
          },
          items[1],
        ],
        1,
      ),
    ).toEqual({ items: [items[1]], hasMore: true })
    // The same shared merge bounds both the visible transcript and the runtime
    // overlay; the oldest row falls away while the newest rows survive.
    expect(
      mergeTranscriptItems(
        [],
        [
          { ...items[0], id: 'oldest', cursor: 'grok:0' },
          items[0],
          items[1],
        ],
        2,
      ),
    ).toEqual(items)
    // The production restart bound is exercised functionally without a timing
    // threshold: one over the cap retains exactly the newest 12,000 rows.
    const bounded = mergeTranscriptItems(
      [],
      Array.from({ length: 12_001 }, (_, index) => ({
        id: `bounded-${index}`,
        cursor: `bounded-cursor-${index}`,
        role: 'assistant' as const,
        text: `bounded ${index}`,
      })),
      12_000,
    )
    expect(bounded).toHaveLength(12_000)
    expect(bounded[0]?.id).toBe('bounded-1')
    expect(bounded.at(-1)?.id).toBe('bounded-12000')

    // A bridge can join two formerly separate alias roots. Both roots' old
    // aliases survive on the winner, so a later replay through the retired id
    // is absorbed rather than reopening a duplicate row.
    const bridged = mergeTranscriptItems(
      [
        {
          id: 'chain-left',
          cursor: 'chain-cursor-left',
          role: 'assistant' as const,
          text: 'left',
        },
        {
          id: 'chain-right',
          cursor: 'chain-cursor-right',
          role: 'assistant' as const,
          text: 'right',
        },
      ],
      [
        {
          id: 'chain-left',
          cursor: 'chain-cursor-right',
          role: 'assistant' as const,
          text: 'bridge',
        },
      ],
      50,
    )
    const replay = {
      id: 'chain-right',
      cursor: 'chain-cursor-new',
      role: 'assistant' as const,
      text: 'replay through retained alias',
    }
    expect(mergeTranscriptItems(bridged, [replay], 50)).toEqual([replay])
    for (const [index, item] of items.entries()) {
      const event = terminalItemEvent({ at: item.ts, seq: index + 2, item })
      registry.gateway.routeDaemonFrame(store.hostMachineId, {
        type: 'runtimeEvent',
        deliveryId: `terminal-item-${index}`,
        sessionId,
        event,
      })
      // An outbox replay of the same causal event is a duplicate, not a row.
      registry.gateway.routeDaemonFrame(store.hostMachineId, {
        type: 'runtimeEvent',
        deliveryId: `terminal-item-replay-${index}`,
        sessionId,
        event,
      })
    }
    // Chat-originated sends can also arrive through the legacy transcript tail;
    // identical cursor identity must upsert rather than duplicate.
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'transcriptDelta',
      sessionId,
      items,
    })
    // A tail replay/reset must not erase the already committed runtime bridge.
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'transcriptDelta',
      sessionId,
      items: [],
      reset: true,
    })

    const liveTranscript = await registry.modules.rpc.readTranscript(
      { sessionId, direction: 'before', limit: 50 },
      { kind: 'user', id: FIRST_ADMIN_USER_ID },
    )
    expect(liveTranscript.items).toEqual(items)
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId),
    ).toMatchObject({ transcriptAvailable: true })
    expect(store.events.listRuntimeTranscriptEvents(sessionId)).toHaveLength(2)
    const newest = store.events.listRuntimeTranscriptEvents(sessionId, 1)
    expect(newest).toHaveLength(1)
    expect(newest[0]).toMatchObject({
      t: 'item',
      item: { kind: 'complete', item: items[1] },
    })

    registry.dispose()
    const restarted = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const rehydrated = restarted.modules.sessions.sessionById(sessionId)
    expect(rehydrated?.transcriptAvailable).toBe(true)

    const transcript = await restarted.modules.rpc.readTranscript(
      { sessionId, direction: 'before', limit: 50 },
      { kind: 'user', id: FIRST_ADMIN_USER_ID },
    )
    expect(transcript.items).toEqual(items)

    restarted.dispose()
    store.close()
  })

  it('never projects a rejected complete event and preserves one interrupt across restart', async () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)
    const rejectedItem = {
      id: 'rejected-before-gate',
      cursor: 'grok:rejected:1',
      role: 'assistant' as const,
      text: 'must never appear',
      ts: '2026-08-23T01:00:00.000Z',
    }
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'rejected-complete-item',
      sessionId,
      event: {
        ...terminalItemEvent({ at: rejectedItem.ts, seq: 1, item: rejectedItem }),
        observerGeneration: 2,
      },
    })
    expect(store.events.listRuntimeTranscriptEvents(sessionId)).toEqual([])
    expect(registry.modules.sessions.transcriptFor(sessionId)).toEqual([])

    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'bootstrap-before-interrupt',
      sessionId,
      event: stateEvent({
        at: '2026-08-23T01:00:01.000Z',
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
        change: { kind: 'session_started' },
      }),
    })
    const interruptItem = {
      id: 'terminal-interrupt-1',
      cursor: 'grok:interrupt:2',
      role: 'user' as const,
      text: '[Request interrupted by user]',
      ts: '2026-08-23T01:00:02.000Z',
      event: 'interrupt' as const,
    }
    const interruptEvent = terminalItemEvent({ at: interruptItem.ts, seq: 2, item: interruptItem })
    for (const deliveryId of ['interrupt-once', 'interrupt-replay']) {
      registry.gateway.routeDaemonFrame(store.hostMachineId, {
        type: 'runtimeEvent',
        deliveryId,
        sessionId,
        event: interruptEvent,
      })
    }
    const live = registry.modules.sessions.transcriptFor(sessionId)
    expect(live).toEqual([interruptItem])
    expect(live.some((item) => item.id === rejectedItem.id)).toBe(false)

    registry.dispose()
    const restarted = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const reloaded = restarted.modules.sessions.transcriptFor(sessionId)
    expect(reloaded).toEqual([interruptItem])
    expect(reloaded.some((item) => item.id === rejectedItem.id)).toBe(false)

    restarted.dispose()
    store.close()
  })

  it('projects causal failure detail into SessionMeta, beside the turn event', () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)
    const detail = 'API error (status 402 Payment Required): Grok Build usage balance exhausted'

    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'bootstrap-state',
      sessionId,
      event: stateEvent({
        at: '2026-08-23T00:00:00.000Z',
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
        change: { kind: 'session_started' },
      }),
    })
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'failure-state',
      sessionId,
      event: stateEvent({
        at: '2026-08-23T00:00:01.000Z',
        seq: 2,
        observerGeneration: 1,
        change: {
          kind: 'turn_failed',
          errorClass: 'usage_limit',
          retryable: false,
          detail,
        },
      }),
    })
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'failure-turn',
      sessionId,
      event: {
        t: 'turn',
        ev: {
          ev: 'failed',
          turnEpoch: 1,
          reason: 'provider-error',
          disposition: 'needs-human',
          detail,
        },
        at: '2026-08-23T00:00:01.000Z',
        provenance: 'live',
        cursor: { segmentId: 'runtime-segment', components: { seq: 3 } },
        observerGeneration: 1,
        turnEpoch: 1,
      },
    })

    expect(registry.modules.sessions.sessionById(sessionId)?.agentState).toMatchObject({
      phase: 'errored',
      error: { class: 'usage_limit', retryable: false, detail },
    })
    expect(store.events.listRuntimeEvents(sessionId)).toContainEqual(
      expect.objectContaining({
        t: 'turn',
        ev: expect.objectContaining({ ev: 'failed', detail }),
      }),
    )

    registry.dispose()
    store.close()
  })

  it('owns recency/board after readiness and enforces restart, segment, epoch, and terminal fences', async () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)
    const initial = registry.modules.sessions.sessionById(sessionId)
    expect(initial).toBeDefined()
    const legacyAt = new Date(Date.parse(initial?.lastActiveAt ?? '') + 1_000).toISOString()
    const runtimeBoard: string[] = []
    const legacyBoard: string[] = []
    registry.bus.on('issue.runtimeDerived', (event) => runtimeBoard.push(event.kind))
    registry.bus.on('issue.sessionDerived', (event) => legacyBoard.push(event.kind))

    // A bind flag alone is not a cutover. Mixed-version legacy facts remain the
    // fallback until the first coarse event has committed its restart head.
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: {
        phase: 'working',
        since: legacyAt,
        nativeSubagentCount: 0,
      },
    })
    expect(registry.modules.sessions.sessionById(sessionId)?.lastActiveAt).toBe(legacyAt)
    expect(legacyBoard).toEqual(['activity'])

    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'bootstrap-1',
      sessionId,
      event: stateEvent({
        at: legacyAt,
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
      }),
    })
    expect(runtimeBoard).toEqual([])

    const firstAt = new Date(Date.parse(legacyAt) + 1_000).toISOString()
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-1',
      sessionId,
      event: stateEvent({ at: firstAt, seq: 2, observerGeneration: 1 }),
    })
    expect(registry.modules.sessions.sessionById(sessionId)?.lastActiveAt).toBe(firstAt)
    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(2)
    expect(store.events.runtimeEventCheckpoint(sessionId)).toMatchObject({
      observerGeneration: 1,
      turnEpoch: 1,
      cursor: { components: { seq: 2 } },
    })
    expect(runtimeBoard).toEqual([])

    // After readiness, compatibility state still feeds its unmigrated consumers
    // but can no longer own board or recency.
    const ignoredLegacyAt = new Date(Date.parse(firstAt) + 1_000).toISOString()
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: {
        phase: 'idle',
        since: ignoredLegacyAt,
        nativeSubagentCount: 0,
        idle: { kind: 'done' },
      },
    })
    expect(registry.modules.sessions.sessionById(sessionId)?.lastActiveAt).toBe(firstAt)
    expect(legacyBoard).toEqual(['activity', 'activity'])

    await registry.modules.sessions.runtimeGateway.replayBoardProjection()
    registry.dispose()
    const restarted = new SessionRegistry(store, undefined, { instanceId: 'default' })
    restarted.gateway.attachDaemon(store.hostMachineId, () => {})
    const restartedBoard: string[] = []
    restarted.bus.on('issue.runtimeDerived', (event) => restartedBoard.push(event.kind))

    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-1-replay',
      sessionId,
      event: stateEvent({
        at: firstAt,
        seq: 2,
        observerGeneration: 2,
        provenance: 'bootstrap',
      }),
    })
    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(2)
    expect(store.events.runtimeEventCheckpoint(sessionId)).toMatchObject({
      observerGeneration: 2,
      cursor: { components: { seq: 2 } },
    })

    const secondAt = new Date(
      Math.ceil((Date.parse(ignoredLegacyAt) + 1) / 1_000) * 1_000,
    ).toISOString()
    const secondAtWire = secondAt.replace('.000Z', 'Z')
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-2',
      sessionId,
      event: stateEvent({ at: secondAtWire, seq: 3, observerGeneration: 2 }),
    })
    expect(restarted.modules.sessions.sessionById(sessionId)?.lastActiveAt).toBe(secondAt)
    expect(restartedBoard).toEqual([])

    const fineSeen: string[] = []
    const stopFine = restarted.modules.sessions.runtimeGateway.onEvent((_id, event) =>
      fineSeen.push(event.t),
    )
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeFineEvent',
      sessionId,
      event: {
        t: 'item',
        item: { kind: 'delta', itemId: 'item-1', textDelta: 'token' },
        at: new Date(Date.parse(secondAt) + 1_000).toISOString(),
        provenance: 'live',
        cursor: { segmentId: 'runtime-segment', components: { seq: 4 } },
        observerGeneration: 2,
        turnEpoch: 1,
      },
    })
    stopFine()
    expect(fineSeen).toEqual(['item'])
    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(3)
    expect(restartedBoard).toEqual([])

    const completedAt = new Date(Date.parse(secondAt) + 2_000).toISOString()
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-3',
      sessionId,
      event: {
        t: 'turn',
        ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' },
        at: completedAt,
        provenance: 'live',
        cursor: { segmentId: 'runtime-segment', components: { seq: 4 } },
        observerGeneration: 2,
        turnEpoch: 1,
      },
    })
    await restarted.modules.sessions.runtimeGateway.replayBoardProjection()
    expect(restartedBoard).toEqual(['turnEnd'])

    // The terminal fence absorbs every later arm in the closed epoch, not just
    // a duplicate turn.started edge.
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-after-terminal',
      sessionId,
      event: stateEvent({
        at: new Date(Date.parse(completedAt) + 1_000).toISOString(),
        seq: 5,
        observerGeneration: 2,
      }),
    })
    // Nor may a sender skip an epoch without its immediate turn.started edge.
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-epoch-jump',
      sessionId,
      event: {
        t: 'turn',
        ev: { ev: 'started', turnEpoch: 3, origin: 'human' },
        at: new Date(Date.parse(completedAt) + 2_000).toISOString(),
        provenance: 'live',
        cursor: { segmentId: 'runtime-segment', components: { seq: 6 } },
        observerGeneration: 2,
        turnEpoch: 3,
      },
    })
    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(4)

    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-turn-2',
      sessionId,
      event: {
        t: 'turn',
        ev: { ev: 'started', turnEpoch: 2, origin: 'human' },
        at: new Date(Date.parse(completedAt) + 3_000).toISOString(),
        provenance: 'live',
        cursor: { segmentId: 'runtime-segment', components: { seq: 6 } },
        observerGeneration: 2,
        turnEpoch: 2,
      },
    })
    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(5)

    // Envelope/body epoch disagreement is rejected before it can fence a turn.
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-epoch-mismatch',
      sessionId,
      event: {
        t: 'turn',
        ev: { ev: 'completed', turnEpoch: 3, verdict: 'done' },
        at: new Date(Date.parse(completedAt) + 4_000).toISOString(),
        provenance: 'live',
        cursor: { segmentId: 'runtime-segment', components: { seq: 7 } },
        observerGeneration: 2,
        turnEpoch: 2,
      },
    })

    // A replacement observer must begin with the immediate next generation's
    // bootstrap and an ordered cursor succession.
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-live-reset',
      sessionId,
      event: stateEvent({
        at: new Date(Date.parse(completedAt) + 5_000).toISOString(),
        seq: 8,
        observerGeneration: 3,
        turnEpoch: 2,
      }),
    })
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-unrelated-reset',
      sessionId,
      event: stateEvent({
        at: new Date(Date.parse(completedAt) + 6_000).toISOString(),
        seq: 1,
        observerGeneration: 3,
        turnEpoch: 2,
        provenance: 'bootstrap',
        segmentId: 'unrelated',
      }),
    })
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-generation-jump',
      sessionId,
      event: stateEvent({
        at: new Date(Date.parse(completedAt) + 7_000).toISOString(),
        seq: 1,
        observerGeneration: 5,
        turnEpoch: 2,
        provenance: 'bootstrap',
        segmentId: 'future',
        predecessorSegmentId: 'runtime-segment',
      }),
    })
    expect(store.events.runtimeEventCheckpoint(sessionId)?.observerGeneration).toBe(2)

    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-proven-reset',
      sessionId,
      event: stateEvent({
        at: new Date(Date.parse(completedAt) + 8_000).toISOString(),
        seq: 1,
        observerGeneration: 3,
        turnEpoch: 2,
        provenance: 'bootstrap',
        segmentId: 'successor',
        predecessorSegmentId: 'runtime-segment',
      }),
    })
    expect(store.events.runtimeEventCheckpoint(sessionId)).toMatchObject({
      observerGeneration: 3,
      cursor: { segmentId: 'successor', predecessorSegmentId: 'runtime-segment' },
    })
    restarted.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'event-stale-generation',
      sessionId,
      event: stateEvent({
        at: new Date(Date.parse(completedAt) + 9_000).toISOString(),
        seq: 8,
        observerGeneration: 2,
        turnEpoch: 2,
      }),
    })
    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(6)

    await restarted.modules.sessions.runtimeGateway.replayBoardProjection()
    restarted.dispose()
    store.close()
  })

  it('rolls event, checkpoint, and session recency back together when ingress persistence fails', () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)
    const before = registry.modules.sessions.sessionById(sessionId)?.lastActiveAt ?? ''
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'rollback-bootstrap',
      sessionId,
      event: stateEvent({
        at: before,
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
      }),
    })
    const originalSave = store.events.saveRuntimeEventCheckpoint
    store.events.saveRuntimeEventCheckpoint = () => {
      throw new Error('injected checkpoint failure')
    }
    try {
      expect(() =>
        registry.gateway.routeDaemonFrame(store.hostMachineId, {
          type: 'runtimeEvent',
          deliveryId: 'rollback-live',
          sessionId,
          event: stateEvent({
            at: new Date(Date.parse(before) + 1_000).toISOString(),
            seq: 2,
            observerGeneration: 1,
          }),
        }),
      ).toThrow('injected checkpoint failure')
    } finally {
      store.events.saveRuntimeEventCheckpoint = originalSave
    }
    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(1)
    expect(store.events.runtimeEventCheckpoint(sessionId)?.cursor.components.seq).toBe(1)
    expect(registry.modules.sessions.sessionById(sessionId)?.lastActiveAt).toBe(before)

    registry.dispose()
    store.close()
  })

  it('replays after a server kill while an asynchronous board effect is pending', async () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)
    const initial = registry.modules.sessions.sessionById(sessionId)
    const at = new Date(Date.parse(initial?.lastActiveAt ?? '') + 1_000).toISOString()
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'crash-bootstrap',
      sessionId,
      event: stateEvent({
        at: registry.modules.sessions.sessionById(sessionId)?.lastActiveAt ?? at,
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
      }),
    })
    await registry.modules.sessions.runtimeGateway.replayBoardProjection()
    const baselineCursor = store.events.runtimeEventProjectionCursor('runtime.board.v1')
    let markEffectStarted: (() => void) | undefined
    const effectStarted = new Promise<void>((resolve) => {
      markEffectStarted = resolve
    })
    const neverCompletes = new Promise<void>(() => {})
    registry.bus.on('issue.runtimeDerived', (event) => {
      if (event.kind !== 'turnEnd') return
      markEffectStarted?.()
      return neverCompletes
    })

    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'crash-event',
      sessionId,
      event: {
        t: 'turn',
        ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' },
        at,
        provenance: 'live',
        cursor: { segmentId: 'runtime-segment', components: { seq: 2 } },
        observerGeneration: 1,
        turnEpoch: 1,
      },
    })
    await effectStarted
    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(2)
    expect(store.events.runtimeEventProjectionCursor('runtime.board.v1')).toBe(baselineCursor)
    const prune = store.events.planEventPrune({ maxAgeDays: 0, maxRows: 0 })
    expect(store.events.pruneEventBatch(prune)).toBeGreaterThan(0)
    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(1)

    // Dispose without resolving the listener: this is the server-kill window.
    registry.dispose()
    const restarted = new SessionRegistry(store, undefined, { instanceId: 'default' })
    await restarted.modules.sessions.runtimeGateway.replayBoardProjection()
    expect(store.events.runtimeEventProjectionCursor('runtime.board.v1')).toBeGreaterThan(
      baselineCursor,
    )
    expect(restarted.modules.sessions.sessionById(sessionId)?.lastActiveAt).toBe(at)

    restarted.dispose()
    store.close()
  })

  it('accepts a process exit after the final turn epoch is closed', async () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)

    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'exit-bootstrap',
      sessionId,
      event: stateEvent({
        at: '2026-08-23T00:00:00.000Z',
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
      }),
    })
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'exit-turn-complete',
      sessionId,
      event: turnEvent({
        at: '2026-08-23T00:00:01.000Z',
        seq: 2,
        turnEpoch: 1,
        ev: 'completed',
      }),
    })
    expect(store.events.runtimeEventCheckpoint(sessionId)?.closedTurnEpoch).toBe(1)

    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: 'exit-after-turn',
      sessionId,
      event: {
        t: 'process',
        ev: { ev: 'exited', code: null, signal: null, classification: 'crashed' },
        at: '2026-08-23T00:00:02.000Z',
        provenance: 'live',
        cursor: { segmentId: 'runtime-segment', components: { seq: 3 } },
        observerGeneration: 1,
        turnEpoch: 1,
      },
    })

    expect(store.events.listRuntimeEvents(sessionId)).toHaveLength(3)
    expect(registry.modules.sessions.sessionById(sessionId)?.status).toBe('exited')

    // The relay's interaction cleanup is intentionally fire-and-forget. Let
    // that listener finish before this test closes the in-memory database.
    await new Promise((resolve) => setImmediate(resolve))
    registry.dispose()
    store.close()
  })

  it('starts a new drain for a request arriving during prior drain teardown', async () => {
    const sessionId = asSessionId('teardown-session')
    const event = stateEvent({
      at: '2026-08-20T00:00:00.000Z',
      seq: 1,
      observerGeneration: 1,
    })
    let cursor = 0
    let records: RuntimeEventLogRecord[] = []
    let armed = true
    let lateReplay: Promise<void> | undefined
    let gate: RuntimeEventGate
    const events = {
      appendEvent: () => 1,
      announceEvent: () => {},
      listRuntimeEvents: () => [],
      runtimeEventCheckpoint: () => null,
      saveRuntimeEventCheckpoint: () => {},
      runtimeEventProjectionCursor: () => cursor,
      saveRuntimeEventProjectionCursor: (_projector: string, eventId: number) => {
        cursor = eventId
      },
      listRuntimeEventsAfter: (afterId: number) => {
        if (armed) {
          armed = false
          queueMicrotask(() =>
            queueMicrotask(() => {
              records = [{ id: 1, sessionId, event }]
              lateReplay = gate.replayBoardProjection()
            }),
          )
        }
        return records.filter((record) => record.id > afterId)
      },
    } as unknown as RuntimeEventGatePorts['events']
    gate = new RuntimeEventGate({
      events,
      session: () => undefined,
      persist: () => {},
      board: () => {},
      now: () => 0,
    })

    await gate.replayBoardProjection()
    await Promise.resolve()
    await Promise.resolve()
    if (!lateReplay) throw new Error('late replay was not scheduled')
    await lateReplay

    expect(cursor).toBe(1)
    expect(records.filter((record) => record.id > cursor)).toEqual([])
  })
})

/**
 * WHAT COUNTS AS "THE CAUSAL STREAM OWNS THIS FAILURE" (POD-2414 third pass).
 *
 * The aggregate suppresses the compatibility `errored` shadow of a failure the
 * driver already reported causally. The predicate deciding that used to be
 * "does a checkpoint exist", and these tests exist because that was wrong in a
 * way no service-level test could see: the service takes the predicate as a
 * boolean, so the breadth bug lived entirely in what computes it.
 */
describe('causal failure ownership', () => {
  const send = (
    registry: SessionRegistry,
    store: SessionStore,
    sessionId: ReturnType<typeof bindContract>,
    deliveryId: string,
    event: RuntimeEvent,
  ) =>
    registry.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId,
      sessionId,
      event,
    })

  it('a state/turn-completed session owns NO failure, though it has a checkpoint', () => {
    // THE REGRESSION. A terminal runtime-contract session emits `state` and
    // `turn/completed` and never a `turn/failed` in its life. Under the old
    // predicate its checkpoint alone claimed ownership, so its `errored`
    // recovery ask was dropped as a duplicate of a causal failure that does not
    // exist, and a session waiting on a human went silent.
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)
    send(
      registry,
      store,
      sessionId,
      'bootstrap-1',
      stateEvent({
        at: '2026-08-22T00:00:00.000Z',
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
      }),
    )
    send(
      registry,
      store,
      sessionId,
      'state-1',
      stateEvent({ at: '2026-08-22T00:00:01.000Z', seq: 2, observerGeneration: 1 }),
    )
    send(
      registry,
      store,
      sessionId,
      'completed-1',
      turnEvent({ at: '2026-08-22T00:00:02.000Z', seq: 3, turnEpoch: 1, ev: 'completed' }),
    )

    const checkpoint = store.events.runtimeEventCheckpoint(sessionId)
    // The old predicate's whole input, and it is satisfied.
    expect(checkpoint).not.toBeNull()
    expect(store.events.hasCausalTurnFailure(sessionId, checkpoint?.turnEpoch ?? 0)).toBe(false)
  })

  it('a LIVE turn/failed in the current turn is ownership', () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)
    send(
      registry,
      store,
      sessionId,
      'bootstrap-1',
      stateEvent({
        at: '2026-08-22T00:00:00.000Z',
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
      }),
    )
    send(
      registry,
      store,
      sessionId,
      'failed-1',
      turnEvent({ at: '2026-08-22T00:00:01.000Z', seq: 2, turnEpoch: 1, ev: 'failed' }),
    )
    const checkpoint = store.events.runtimeEventCheckpoint(sessionId)
    expect(store.events.hasCausalTurnFailure(sessionId, checkpoint?.turnEpoch ?? 0)).toBe(true)
  })

  it('a failure in a PREVIOUS turn is not ownership of the current one', () => {
    // A session that failed, recovered, and later goes `errored` through the
    // legacy path must still be able to ask: the old failure is not evidence
    // about this one.
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)
    send(
      registry,
      store,
      sessionId,
      'bootstrap-1',
      stateEvent({
        at: '2026-08-22T00:00:00.000Z',
        seq: 1,
        observerGeneration: 1,
        provenance: 'bootstrap',
      }),
    )
    send(
      registry,
      store,
      sessionId,
      'failed-1',
      turnEvent({ at: '2026-08-22T00:00:01.000Z', seq: 2, turnEpoch: 1, ev: 'failed' }),
    )
    send(
      registry,
      store,
      sessionId,
      'started-2',
      turnEvent({ at: '2026-08-22T00:00:02.000Z', seq: 3, turnEpoch: 2, ev: 'started' }),
    )
    const checkpoint = store.events.runtimeEventCheckpoint(sessionId)
    expect(checkpoint?.turnEpoch).toBe(2)
    expect(store.events.hasCausalTurnFailure(sessionId, 2)).toBe(false)
    // The earlier turn's failure is still on the record; it is simply not this
    // turn's evidence.
    expect(store.events.hasCausalTurnFailure(sessionId, 1)).toBe(true)
  })

  it('a BOOTSTRAP turn/failed is not ownership — it never minted an ask', () => {
    // `projectBoard` materializes failures from live events only, so counting a
    // replayed failure as ownership would silence the shadow with nothing
    // standing in its place.
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionId = bindContract(registry, store)
    send(
      registry,
      store,
      sessionId,
      'bootstrap-failed',
      turnEvent({
        at: '2026-08-22T00:00:00.000Z',
        seq: 1,
        turnEpoch: 1,
        ev: 'failed',
        provenance: 'bootstrap',
      }),
    )
    const checkpoint = store.events.runtimeEventCheckpoint(sessionId)
    expect(checkpoint).not.toBeNull()
    expect(store.events.hasCausalTurnFailure(sessionId, checkpoint?.turnEpoch ?? 0)).toBe(false)
  })
})
