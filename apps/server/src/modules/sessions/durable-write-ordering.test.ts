import { asMachineId, asSessionId, type MachineId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { Session } from './session'
import type { HandoffPorts } from './handoff/ports'
import { HandoffTransfer, type HandoffTransferPorts } from './handoff/transfer'
import type { HandoffPlacement } from './handoff/placement'
import type { HandoffPreflightResult } from './handoff/preflight'
import type { SessionRepository } from './repository'
import { SessionRevival, type SessionRevivalPorts } from './session-revival'
import { SessionTeardown, type SessionTeardownPorts } from './session-teardown'
import { SessionClientPlane, type SessionClientPlanePorts } from './session-client-plane'
import { SessionMachineReconciler, type MachineReconcilerPorts } from './machine-reconciler'
import { SessionClientControl, type SessionClientControlPorts } from './client-control'
import { SessionStateService, type SessionStatePorts } from './session-state/service'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const session = new Session({
    sessionId: asSessionId('durable-order'),
    durableLabel: 'podium-durable-order',
    agentKind: 'claude-code',
    cwd: '/source',
    title: 'Durable ordering',
    origin: { kind: 'spawn' },
    createdAt: '2026-09-08T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: asMachineId('machine'),
    toDaemon: () => {},
  })
  session.status = 'live'
  session.resume = { kind: 'claude-session', value: 'conversation' }
  const events: string[] = []
  const entered = deferred()
  const commit = deferred()
  const repository: Pick<SessionRepository, 'write'> = {
    async write(subject, mutate) {
      const draft = subject.captureDurableState()
      mutate(draft)
      entered.resolve()
      await commit.promise
      subject.restoreDurableState(draft)
      events.push('commit')
    },
  }
  return { session, events, entered, commit, repository }
}

describe('durable session write ordering', () => {
  it('requires a promise from the handoff durable write port', () => {
    type RequiresPromise<T extends Promise<void>> = T
    const committed: RequiresPromise<ReturnType<HandoffPorts['write']>> = Promise.resolve()
    expect(committed).toBeInstanceOf(Promise)
  })
  it('hibernate commits parked state before kill and successful return', async () => {
    const f = fixture()
    const teardown = new SessionTeardown({
      sessions: new Map([[f.session.sessionId, f.session]]),
      repository: f.repository,
      now: () => 0,
      autoContinue: { onSessionGone() {} },
      toMachine: () => { f.events.push(`kill:${f.session.status}`) },
      broadcastSessions() {},
    } as unknown as SessionTeardownPorts)
    const pending = teardown.hibernateSession({ sessionId: f.session.sessionId })
      .then(result => { f.events.push(`return:${f.session.status}`); return result })
    await f.entered.promise
    f.commit.resolve()
    expect(await pending).toEqual({ ok: true })
    expect(f.events).toEqual(['commit', 'kill:hibernated', 'return:hibernated'])
  })

  it('handoff rechecks grants after parking and restores an un-killed source on revocation', async () => {
    const f = fixture()
    let revoked = false
    const transfer = new HandoffTransfer({
      write: f.repository.write,
      onSessionGone() {},
      broadcastSessions() {},
      toMachine: () => { f.events.push('kill') },
    } as unknown as HandoffTransferPorts)
    const pending = transfer.apply(
      { session: f.session } as HandoffPlacement,
      {} as HandoffPreflightResult,
      { sessionId: f.session.sessionId, machineId: asMachineId('target') },
      {} as Parameters<HandoffTransfer['apply']>[3],
      () => { if (revoked) throw new Error('machine grant revoked') },
    )
    await f.entered.promise
    revoked = true
    f.commit.resolve()
    await expect(pending).rejects.toThrow('machine grant revoked')
    expect(f.session.status).toBe('live')
    expect(f.events).toEqual(['commit', 'commit'])
  })

  function revival(f: ReturnType<typeof fixture>) {
    return new SessionRevival({
      repository: f.repository,
      instructionsForStart: async () => ({ instructions: [], commit: async () => {} }),
      terminalProof: { fence: async () => { f.events.push(`fence:${f.session.status}`) } },
      toMachine: (_machine: MachineId, message: ControlMessage) => {
        if (message.type === 'spawn') f.events.push(`spawn:${message.cwd}`)
      },
      launchConfig: { modelDefaults: async () => ({}), accountEnv: async () => ({}) },
      state: { draftSyncEnabled: () => false },
      broadcastSessions() {},
    } as unknown as SessionRevivalPorts)
  }

  it('revival commits starting state and cwd before fence and spawn', async () => {
    const f = fixture()
    f.session.status = 'hibernated'
    const pending = revival(f).finishResurrect(f.session, { ok: true, cwd: '/target' })
    await f.entered.promise
    f.commit.resolve()
    expect(await pending).toEqual({ ok: true })
    expect(f.events).toEqual(['commit', 'fence:starting', 'spawn:/target'])
  })

  it('revival refuses a session archived while its commit was pending', async () => {
    const f = fixture()
    f.session.status = 'hibernated'
    // Retirement is visible when the write completes, before the continuation.
    const write = f.repository.write
    f.repository.write = async (...args) => {
      await write(...args)
      f.session.archived = true
    }
    const pending = revival(f).finishResurrect(f.session, { ok: true, cwd: '/target' })
    await f.entered.promise
    f.commit.resolve()
    expect(await pending).toEqual({ ok: false, reason: 'session is archived' })
    expect(f.events).toEqual(['commit'])
  })
})


describe('async session port boundaries', () => {
  it('reattach includes the committed fence identity and resolved transcript hint', async () => {
    const f = fixture()
    const plane = new SessionClientPlane({
      terminalProof: { fence: async () => {
        await Promise.resolve()
        return { observationGeneration: 7, bindingVersion: 4, providerSessionId: 'provider' }
      } },
      rpc: { transcriptPathHint: async () => {
        await Promise.resolve()
        return { pathHint: '/recorded/transcript' }
      } },
      machines: { ownershipRows: async () => [], grantsForMachine: async () => [] },
      state: { draftSyncEnabled: () => false },
    } as unknown as SessionClientPlanePorts)
    expect(await plane.reattachMessageFor(f.session, f.session.machineId)).toMatchObject({
      type: 'reattach', observationGeneration: 7, observationBindingVersion: 4,
      observationProviderSessionId: 'provider', pathHint: '/recorded/transcript',
      binding: { transitionId: `reattach:${f.session.sessionId}:7` },
    })
  })

  it('census repair commits reconnecting before preparing its reattach', async () => {
    const f = fixture()
    f.session.status = 'hibernated'
    const reconciler = new SessionMachineReconciler({
      sessions: () => [f.session],
      write: f.repository.write,
      markVolatileSessionDirty() {},
      reattachMessage: async () => {
        f.events.push(`reattach:${f.session.status}`)
        return { type: 'reattach' } as ControlMessage
      },
      toMachine: () => { f.events.push('send') },
      broadcastSessions() {},
    } as unknown as MachineReconcilerPorts)
    const pending = reconciler.reviveParkedButAlive(f.session, f.session.machineId, 'test census', { measuredPtyHost: true })
    await f.entered.promise
    f.commit.resolve()
    await pending
    expect(f.events).toEqual(['commit', 'reattach:reconnecting', 'send'])
  })

  it.each(['setSessionDraft', 'draftEdit'] as const)('%s frame waits for its draft port', async (type) => {
    const entered = deferred(), release = deferred()
    const events: string[] = []
    const write = async () => {
      entered.resolve()
      await release.promise
      events.push('draft saved')
    }
    const control = new SessionClientControl({ setDraft: write, editDraft: write } as unknown as SessionClientControlPorts)
    const pending = control.onFrame(
      {} as Parameters<SessionClientControl['onFrame']>[0],
      { id: 'client' } as Parameters<SessionClientControl['onFrame']>[1],
      { type, sessionId: asSessionId('draft'), text: '', baseRev: 0 },
    ).then(() => { events.push('frame returned') })
    await entered.promise
    release.resolve()
    await pending
    expect(events).toEqual(['draft saved', 'frame returned'])
  })

  it.each(['archive', 'shell', 'stale'] as const)('%s parking commits before killing the process', async (kind) => {
    const f = fixture()
    if (kind === 'shell') Object.assign(f.session, { agentKind: 'shell' })
    const teardown = new SessionTeardown({
      sessions: new Map([[f.session.sessionId, f.session]]),
      repository: f.repository,
      now: () => 0,
      autoContinue: { onSessionGone() {} },
      rearmUnread: async () => {},
      toMachine: () => { f.events.push(`kill:${f.session.status}`) },
      broadcastSessions() {},
    } as unknown as SessionTeardownPorts)
    const pending = kind === 'archive' ? teardown.parkArchivedSession(f.session.sessionId)
      : kind === 'shell' ? teardown.parkShellSession(f.session.sessionId)
      : teardown.parkStaleSession({ sessionId: f.session.sessionId })
    await f.entered.promise
    f.commit.resolve()
    await pending
    expect(f.events).toEqual(['commit', 'kill:hibernated'])
  })

  it('a draft clear cannot overtake an older pending DRAFT-tag commit', async () => {
    const f = fixture()
    const persisted: string[] = []
    const state = new SessionStateService({
      store: { sessions: { setDraftDoc: async (_id: string, doc: { text: string }) => { persisted.push(doc.text) } } },
      getSession: () => f.session,
      writeSession: async (_id: Parameters<SessionStatePorts['writeSession']>[0], mutate: Parameters<SessionStatePorts['writeSession']>[1]) => { await f.repository.write(f.session, mutate) },
      broadcastToClients() {},
      broadcastSessions() {},
    } as unknown as SessionStatePorts)
    try {
      const older = state.setDraft({ sessionId: f.session.sessionId, text: 'older' })
      await f.entered.promise
      const clear = state.setDraft({ sessionId: f.session.sessionId, text: '' })
      f.commit.resolve()
      await Promise.all([older, clear])
      expect(state.draftText(f.session.sessionId)).toBe('')
      expect(f.session.draftUpdatedAt).toBeUndefined()
      expect(persisted.at(-1)).toBe('')
    } finally {
      state.removeSession(f.session.sessionId)
    }
  })
})
