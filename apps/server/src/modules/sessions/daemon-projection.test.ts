import { firstAdminMemberId } from '@podium/model'
import { asIssueId, asMachineId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { SessionDaemonProjection, type SessionDaemonProjectionPorts, type SessionProjectionDaemonFrame } from './daemon-projection'
import { Session } from './session'
import { SessionBindingReceipts } from './session-binding'

const machineId = asMachineId('projection-machine')
const sessionId = asSessionId('projection-session')
const cases: { name: string; frame: SessionProjectionDaemonFrame; fallback?: boolean }[] = [
  { name: 'color', frame: { type: 'agentColor', sessionId, color: 'blue' } },
  { name: 'model', frame: { type: 'agentModel', sessionId, model: 'new-model' } },
  { name: 'context', frame: { type: 'agentContext', sessionId, percent: 42 } },
  { name: 'title', frame: { type: 'title', sessionId, title: 'New title' } },
  { name: 'cwd', frame: { type: 'sessionCwd', sessionId, cwd: '/new' } },
  { name: 'transcript', frame: { type: 'transcriptDelta', sessionId, items: [] } },
  { name: 'prompt title', frame: { type: 'transcriptDelta', sessionId, items: [] }, fallback: true },
]

function fixture(fallback = false, agentKind: 'claude-code' | 'codex' = 'claude-code') {
  const session = new Session({
    ownerUserId: firstAdminMemberId(),
    sessionId, machineId, durableLabel: 'projection-session', agentKind,
    cwd: '/old', title: 'Old title', origin: { kind: 'spawn' },
    createdAt: '2026-09-07T00:00:00.000Z', geometry: { cols: 80, rows: 24 },
    toDaemon: vi.fn(), issueId: asIssueId('projection-issue'),
  })
  session.titleLocked = !fallback
  vi.spyOn(session.terminal, 'applyDelta').mockReturnValue(!fallback)
  vi.spyOn(session.terminal, 'transcriptItems').mockReturnValue([
    { id: 'prompt', role: 'user', text: 'A useful prompt title', cursor: 'c1' },
  ])
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const pending = { promise, resolve, reject }
  const published: string[] = []
  const save = vi.fn(async () => { await pending.promise })
  const ports: SessionDaemonProjectionPorts = {
    sessions: new Map([[sessionId, session]]),
    binding: new SessionBindingReceipts({
      memory: { ensureConversationIdentity: vi.fn(), linkConversationSegment: vi.fn() },
      now: () => 0, sessions: () => [session], session: () => session,
      sessionOwner: async () => undefined, write: save, broadcastSessions: vi.fn(), toMachine: vi.fn(),
    }),
    draft: (s) => s.captureDurableState(),
    persist: save,
    persistDraft: async (s, draft) => { await save(); s.installDurableState(draft) },
    write: async (s, mutate) => {
      const draft = s.captureDurableState()
      mutate(draft)
      await save()
      s.installDurableState(draft)
    },
    broadcastSessions: () => { published.push('sessions') },
    broadcastToClients: () => { published.push('title') },
    transcriptDelta: () => { published.push('transcript') },
    adoptWorktree: () => { published.push('adopt') },
    recordSessionGitActivity: vi.fn(),
  }
  return { projection: new SessionDaemonProjection(ports), pending, published, save, session }
}

describe('daemon projection write completion', () => {
  for (const { name, frame, fallback } of cases) {
    it(`${name} waits for persistence before completion and dependent publication`, async () => {
      const f = fixture(fallback)
      let completed = false
      const handled = f.projection.handle(machineId, frame).then(() => { completed = true })
      try {
        await Promise.resolve()
        expect(f.save).toHaveBeenCalledTimes(1)
        expect(completed).toBe(false)
        // The already-existing transcript event precedes only the fallback title write.
        expect(f.published).toEqual(fallback ? ['transcript'] : [])
        f.pending.resolve()
        await handled
        expect(f.published).toEqual(
          name === 'title' ? ['title'] : name === 'cwd' ? ['sessions', 'adopt'] :
          name === 'transcript' ? ['sessions', 'transcript'] : fallback ? ['transcript', 'title'] : ['sessions'],
        )
      } finally {
        f.pending.resolve()
        await handled
        f.projection.disposeTitle(sessionId)
      }
    })

    it(`${name} propagates the write rejection without dependent publication`, async () => {
      const f = fixture(fallback)
      const failure = new Error(`projection-${name}-write-failed`)
      const handled = f.projection.handle(machineId, frame)
      const rejected = expect(handled).rejects.toBe(failure)
      f.pending.reject(failure)
      try {
        await rejected
        expect(f.published).toEqual(fallback ? ['transcript'] : [])
      } finally {
        f.projection.disposeTitle(sessionId)
      }
    })
  }
})


describe('contract metadata projection', () => {
  const observation = (seq: number, change: import('@podium/protocol/daemon').SessionMetadataChange,
    generation = 1): import('@podium/protocol/daemon').SessionMetadataObservation => ({
    t: 'metadata', change, at: '2026-09-01T00:00:00.000Z', provenance: 'live',
    cursor: { segmentId: 'metadata', components: { seq } }, observerGeneration: generation, turnEpoch: 1,
  })

  it('deduplicates compatibility frames and native events without changing requested settings or user naming', async () => {
    const f = fixture()
    f.pending.resolve()
    f.session.name = 'User name'
    f.session.nameSource = 'user'
    f.session.requestedModel = 'requested-model'
    f.session.requestedEffort = 'low'
    const event = observation(1, { kind: 'model', source: 'native', model: 'actual-model', effort: 'high' })
    await f.projection.handle(machineId, { type: 'agentModel', sessionId, model: 'actual-model', effort: 'high' })
    await f.projection.runtimeEvent(sessionId, event)
    await f.projection.runtimeEvent(sessionId, event)
    expect(f.save).toHaveBeenCalledTimes(1)
    await f.projection.runtimeEvent(sessionId, observation(2, { kind: 'title', source: 'native', title: 'Agent summary' }))
    expect(f.session).toMatchObject({ name: 'User name', nameSource: 'user', title: 'Agent summary',
      observedModel: 'actual-model', observedEffort: 'high', requestedModel: 'requested-model', requestedEffort: 'low' })
    f.projection.disposeTitle(sessionId)
  })

  it('hydrates snapshot metadata but rejects stale bootstrap racing a live update', async () => {
    const f = fixture()
    f.pending.resolve()
    const old = observation(1, { kind: 'context', source: 'transcript', percent: 80 })
    const snapshot: import('@podium/protocol/daemon').SessionSnapshot = {
      binding: { sessionId, driver: 'terminal-claude', family: 'terminal', harness: 'claude-code',
        workdir: '/repo', resume: null, process: { key: 'process' }, bindingVersion: 1 },
      metadata: [old], state: {}, cursor: old.cursor, observerGeneration: 1, turnEpoch: 1,
      interactions: [], at: old.at,
    }
    await f.projection.metadataSnapshot(sessionId, snapshot)
    expect(f.session.contextUsagePercent).toBe(80)
    await f.projection.runtimeEvent(sessionId, observation(2, { kind: 'context', source: 'transcript', percent: 0 }))
    await f.projection.metadataSnapshot(sessionId, snapshot)
    expect(f.session.contextUsagePercent).toBe(0)
    expect(f.save).toHaveBeenCalledTimes(2)
    await f.projection.runtimeEvent(sessionId, observation(3, { kind: 'color', source: 'transcript', color: 'blue' }))
    await f.projection.runtimeEvent(sessionId, observation(4, { kind: 'color', source: 'transcript', color: 'default' }))
    expect(f.session.agentColor).toBeUndefined()
  })

  it('keeps first-prompt fallback and stable title debounce on the contract path', async () => {
    vi.useFakeTimers()
    const f = fixture(true)
    f.pending.resolve()
    try {
      await f.projection.promptTitle(sessionId)
      expect(f.session.title).toBe('A useful prompt title')
      await f.projection.runtimeEvent(sessionId, observation(1, { kind: 'title', source: 'osc', title: 'Claude Code' }))
      expect(f.session.title).toBe('A useful prompt title')
      await f.projection.runtimeEvent(sessionId, observation(2, { kind: 'title', source: 'osc', title: '◐ Better summary' }))
      await f.projection.runtimeEvent(sessionId, observation(3, { kind: 'title', source: 'osc', title: '◑ Better summary' }))
      expect(f.session.title).toBe('Better summary')
      await vi.advanceTimersByTimeAsync(500)
      expect(f.published.filter((entry) => entry === 'title')).toHaveLength(2)
    } finally { f.projection.disposeTitle(sessionId); vi.useRealTimers() }
  })

  it('refuses OSC titles for Codex even if the host forwards a spinner', async () => {
    const f = fixture(false, 'codex')
    f.pending.resolve()
    await f.projection.runtimeEvent(sessionId, observation(1, { kind: 'title', source: 'native', title: 'Native summary' }))
    await f.projection.runtimeEvent(sessionId, observation(2, { kind: 'title', source: 'osc', title: '◐ project' }))
    expect(f.session.title).toBe('Native summary')
    f.projection.disposeTitle(sessionId)
  })
})
