import { asSessionId, firstAdminMemberId } from "@podium/model"
import type { RuntimeEvent } from "@podium/protocol/daemon"
import { describe, expect, it } from "vitest"
import { SessionRegistry } from '../relay'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

function turnEvent(input: {
  at: string
  seq: number
  turnEpoch: number
  ev: 'started' | 'completed' | 'failed'
}): RuntimeEvent {
  const ev =
    input.ev === 'failed'
      ? ({ ev: 'failed', turnEpoch: input.turnEpoch, reason: 'provider-error', disposition: 'needs-human' } as const)
      : input.ev === 'completed'
        ? ({ ev: 'completed', turnEpoch: input.turnEpoch, verdict: 'done' } as const)
        : ({ ev: 'started', turnEpoch: input.turnEpoch, origin: 'human' } as const)
  return {
    t: 'turn',
    ev,
    at: input.at,
    provenance: 'live',
    cursor: { segmentId: 'runtime-segment', components: { seq: input.seq } },
    observerGeneration: 1,
    turnEpoch: input.turnEpoch,
  }
}

function workspaceGit(input: { at: string; seq: number; turnEpoch: number; commits: string[]; touched?: string[] }): RuntimeEvent {
  return {
    t: 'workspace',
    ev: { ev: 'git-activity', commits: input.commits, touchedFiles: input.touched ?? [] },
    at: input.at,
    provenance: 'live',
    cursor: { segmentId: 'runtime-segment', components: { seq: input.seq } },
    observerGeneration: 1,
    turnEpoch: input.turnEpoch,
  }
}

function workspaceCwd(input: { at: string; seq: number; turnEpoch: number; cwd: string }): RuntimeEvent {
  return {
    t: 'workspace',
    ev: { ev: 'cwd-changed', cwd: input.cwd, kind: 'worktree' },
    at: input.at,
    provenance: 'live',
    cursor: { segmentId: 'runtime-segment', components: { seq: input.seq } },
    observerGeneration: 1,
    turnEpoch: input.turnEpoch,
  }
}

function openUrl(input: { at: string; seq: number; turnEpoch: number; requestId: string }): RuntimeEvent {
  return {
    t: 'open-url',
    ev: { url: 'https://auth.example/authorize', intent: 'login', requestId: input.requestId, expiresAt: Date.parse(input.at) + 600_000 },
    at: input.at,
    provenance: 'live',
    cursor: { segmentId: 'runtime-segment', components: { seq: input.seq } },
    observerGeneration: 1,
    turnEpoch: input.turnEpoch,
  }
}

async function bindContract(registry: SessionRegistry, store: SessionStore) {
  await store.machines.upsertMachine({
    id: store.hostMachineId, name: 'Host', hostname: 'test', tokenHash: 'test',
    ownerUserId: firstAdminMemberId(), assignment: { server: true, agentExecution: true },
  })
  await registry.gateway.attachDaemon(store.hostMachineId, () => {})
  const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'codex', cwd: '/project' })
  await registry.gateway.routeDaemonFrame(store.hostMachineId, {
    type: 'bind', sessionId, cmd: 'codex app-server', cwd: '/project', agentKind: 'codex',
    geometry: { cols: 80, rows: 24 }, runtimeContract: true, driverId: 'codex-app-server',
  })
  return sessionId
}

describe('late workspace/browser admission (POD-4308 C16/C17)', () => {
  it('admits git-activity, cwd and open-url after turn completion without reopening the turn', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    try {
      const sessionId = await bindContract(registry, store)
      const board: string[] = []
      registry.bus.on('issue.runtimeDerived', (e) => board.push(e.kind))
      const send = (deliveryId: string, event: RuntimeEvent) =>
        registry.gateway.routeDaemonFrame(store.hostMachineId, { type: 'runtimeEvent', deliveryId, sessionId, event })
      // Bootstrap + turn 1 completion.
      await send('b1', {
        t: 'state', change: { kind: 'activity' }, at: '2026-09-18T00:00:00.000Z',
        provenance: 'bootstrap', cursor: { segmentId: 'runtime-segment', components: { seq: 1 } },
        observerGeneration: 1, turnEpoch: 1,
      })
      await send('t1', turnEvent({ at: '2026-09-18T00:00:01.000Z', seq: 2, turnEpoch: 1, ev: 'completed' }))
      expect((await store.events.runtimeEventCheckpoint(sessionId))?.closedTurnEpoch).toBe(1)
      // Late auxiliaries stamped with the closed epoch still admit.
      await send('g1', workspaceGit({ at: '2026-09-18T00:00:02.000Z', seq: 3, turnEpoch: 1, commits: ['sha-late'] }))
      await send('c1', workspaceCwd({ at: '2026-09-18T00:00:03.000Z', seq: 4, turnEpoch: 1, cwd: '/repo/.worktrees/feat' }))
      await send('o1', openUrl({ at: '2026-09-18T00:00:04.000Z', seq: 5, turnEpoch: 1, requestId: 'req-1' }))
      expect(await store.events.listRuntimeEvents(sessionId)).toHaveLength(5)
      // Turn stays closed; board saw the late git exactly once (plus turnEnd).
      expect((await store.events.runtimeEventCheckpoint(sessionId))?.closedTurnEpoch).toBe(1)
      await registry.modules.sessions.runtimeGateway.replayBoardProjection()
      expect(board.filter((k) => k === 'gitActivity')).toHaveLength(1)
      // Duplicate replay of the same seq is a duplicate, not a double count.
      const dup = await registry.modules.sessions.runtimeGateway.record(store.hostMachineId, {
        sessionId,
        event: workspaceGit({ at: '2026-09-18T00:00:02.000Z', seq: 3, turnEpoch: 1, commits: ['sha-late'] }),
      })
      expect(dup).toMatchObject({ kind: 'duplicate' })
      await registry.modules.sessions.runtimeGateway.replayBoardProjection()
      expect(board.filter((k) => k === 'gitActivity')).toHaveLength(1)
    } finally {
      await registry.dispose()
      await store.close()
    }
  })

  it('admits a late git result stamped before the next turn started (no relabel, no reopen)', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    try {
      const sessionId = await bindContract(registry, store)
      const board: string[] = []
      registry.bus.on('issue.runtimeDerived', (e) => board.push(e.kind))
      const send = (deliveryId: string, event: RuntimeEvent) =>
        registry.gateway.routeDaemonFrame(store.hostMachineId, { type: 'runtimeEvent', deliveryId, sessionId, event })
      await send('b1', {
        t: 'state', change: { kind: 'activity' }, at: '2026-09-18T00:00:00.000Z',
        provenance: 'bootstrap', cursor: { segmentId: 'runtime-segment', components: { seq: 1 } },
        observerGeneration: 1, turnEpoch: 1,
      })
      await send('t1', turnEvent({ at: '2026-09-18T00:00:01.000Z', seq: 2, turnEpoch: 1, ev: 'completed' }))
      // Next turn starts before the deferred git resolves.
      await send('t2', turnEvent({ at: '2026-09-18T00:00:02.000Z', seq: 3, turnEpoch: 2, ev: 'started' }))
      // Late result for the prior turn arrives (stamped with its origin epoch).
      // Lifecycle-independent admission accepts it without jumping the epoch.
      await send('g2', workspaceGit({ at: '2026-09-18T00:00:03.000Z', seq: 4, turnEpoch: 1, commits: ['sha-prior'] }))
      expect((await store.events.runtimeEventCheckpoint(sessionId))?.turnEpoch).toBe(2)
      expect((await store.events.runtimeEventCheckpoint(sessionId))?.closedTurnEpoch).toBe(1)
      await registry.modules.sessions.runtimeGateway.replayBoardProjection()
      expect(board.filter((k) => k === 'gitActivity')).toHaveLength(1)
    } finally {
      await registry.dispose()
      await store.close()
    }
  })
})
