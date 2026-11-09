/** Synthetic metadata for the real StoreProvider. No backend or operator rows. */
import { DEFAULT_HARNESS_AGENT } from '@podium/model/browser'
import {
  asSessionId,
  asThreadId,
  asUserId,
  issueEventRowId,
  type SuperagentThreadWire,
  superagentThreadRowId,
} from '@podium/model'
import { createHeaderFixture } from '../header-fixture'

export function createSuperagentFixture(issues = 32, sessions = 32) {
  const base = createHeaderFixture(issues, sessions)
  // My synced thread records (POD-6675). The principal is the fixture's operator.
  const owner = asUserId('operator')
  const record = (patch: Partial<SuperagentThreadWire> & Pick<SuperagentThreadWire, 'threadId' | 'kind'>): SuperagentThreadWire => ({
    ownerUserId: owner, archived: false, resumable: false, turnRunning: false, lastTurnFailure: null,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...patch,
  })
  let threads: SuperagentThreadWire[] = [
    // The synthetic thread runs the product default harness, as an identifier:
    // the value is arbitrary fixture data, never vendor behaviour (POD-5613).
    record({ threadId: asThreadId('global'), kind: 'global', podiumSessionId: asSessionId('synthetic-session-0'), resumable: true, agentKind: DEFAULT_HARNESS_AGENT, updatedAt: '2026-10-02T00:00:00Z' }),
    record({ threadId: asThreadId('btw-private'), kind: 'btw', podiumSessionId: asSessionId('synthetic-session-1'), originSessionId: asSessionId('synthetic-session-2') }),
  ]
  const entityOf = (row: SuperagentThreadWire) => {
    const entityId = superagentThreadRowId(owner, row.threadId)
    return { entity: 'superagentThread', entityId, provenance: { seq: 1 }, value: row }
  }
  for (const row of threads) base.records.set(`superagentThread:${entityOf(row).entityId}`, entityOf(row))
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
    ensureSession: { mutate: async () => { actions.ensured++; return { threadId: 'global', podiumSessionId: asSessionId('synthetic-session-0') } } },
    clear: { mutate: async () => { actions.cleared++ } },
    sendTurn: { mutate: async () => { actions.sent++; return { threadId: 'global', podiumSessionId: asSessionId('synthetic-session-0') } } },
    interruptTurn: { mutate: async () => ({ ok: true }) },
    openInTerminal: { mutate: async () => { actions.opened++; return { sessionId: asSessionId('synthetic-session-3') } } },
  }
  return { ...base, get replica() { return base.replica }, actions, get threads() { return threads },
    /** The server moved my global thread's running status: the feed delivers it. */
    async updateThread(running: boolean) {
      threads = threads.map(row => row.threadId === 'global' ? { ...row, turnRunning: running } : row)
      const next = entityOf(threads.find(row => row.threadId === 'global')!)
      base.records.set(`superagentThread:${next.entityId}`, next)
      base.replica.onKernelEvent({ type: 'upserted', record: next as never, readmitted: false })
      await Promise.resolve()
    },
  }
}
