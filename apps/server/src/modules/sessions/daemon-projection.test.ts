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

function fixture(fallback = false) {
  const session = new Session({
    sessionId, machineId, durableLabel: 'projection-session', agentKind: 'claude-code',
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
  return { projection: new SessionDaemonProjection(ports), pending, published, save }
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
