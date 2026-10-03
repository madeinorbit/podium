/** Synthetic metadata for the real StoreProvider. No backend or operator rows. */
import type { ClientRuntime } from '@podium/client-core/engine'
import type { SuperThreadView } from '@podium/client-core/viewmodels'
import { asSessionId, issueEventRowId } from '@podium/model'
import { createHeaderFixture } from '../../../test/header-fixture'

export function createSuperagentFixture(issues = 32, sessions = 32) {
  const base = createHeaderFixture(issues, sessions)
  let threads: SuperThreadView[] = [
    { id: 'global', kind: 'global', podiumSessionId: asSessionId('synthetic-session-0'), harnessSessionId: 'synthetic-harness', turnRunning: false, agentKind: 'codex' },
    { id: 'btw-private', kind: 'btw', podiumSessionId: asSessionId('synthetic-session-1'), originSessionId: asSessionId('synthetic-session-2') },
  ]
  for (const eventId of [100, 9, 99]) {
    const id = issueEventRowId(eventId, 'synthetic-0')
    base.records.set(`issueEvent:${id}`, { entity: 'issueEvent', entityId: id, provenance: { seq: 1 }, value: {
      id, eventId, ts: '2026-10-03T00:00:00Z', kind: 'issue.closed', subject: 'synthetic-0', repoPath: null, payload: null,
    } })
  }
  const question = { id: 'z-first-question', sessionId: 'synthetic-session-0', kind: 'question', status: 'asked',
    source: 'tool-call', answerable: 'structured', fingerprint: 'synthetic-question', askedAt: '2026-10-03T00:00:00Z',
    payload: { v: 1, questions: [{ question: 'Which approach?', header: 'Approach', options: [{ label: 'Small', description: 'Small change' }], multiSelect: false }] } }
  base.records.set(`pendingInteraction:${question.id}`, { entity: 'pendingInteraction', entityId: question.id, provenance: { seq: 1 }, value: question })
  const actions = { ensured: 0, cleared: 0, opened: 0, sent: 0, answered: 0 }
  const api = base.api as unknown as Record<string, unknown>
  const sessionApi = api.sessions as Record<string, unknown>
  Object.assign(sessionApi, {
    transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
    answerAskUserQuestion: { mutate: async () => { actions.answered++; return { ok: true } } },
  })
  api.readPosition = { get: { query: async () => ({ issueEvents: { lastEventId: 9, seenAt: '2026-10-02T00:00:00Z' } }) },
    advance: { mutate: async ({ streamId, lastEventId, seenAt }: { streamId: string; lastEventId: number; seenAt: string | null }) => ({ [streamId]: { lastEventId, seenAt } }) } }
  api.superagent = {
    listThreads: { query: async () => threads },
    ensureSession: { mutate: async () => { actions.ensured++; return { threadId: 'global', podiumSessionId: asSessionId('synthetic-session-0') } } },
    latestTurnFailure: { query: async () => null },
    clear: { mutate: async () => { actions.cleared++ } },
    sendTurn: { mutate: async () => { actions.sent++; return { threadId: 'global', podiumSessionId: asSessionId('synthetic-session-0') } } },
    interruptTurn: { mutate: async () => ({ ok: true }) },
    openInTerminal: { mutate: async () => { actions.opened++; return { sessionId: asSessionId('synthetic-session-3') } } },
  }
  return { ...base, get replica() { return base.replica }, actions, get threads() { return threads },
    async updateThread(runtime: ClientRuntime, running: boolean) {
      threads = threads.map(row => row.id === 'global' ? { ...row, turnRunning: running } : row)
      await runtime.getSnapshot().refreshSuperThreads()
    },
  }
}
