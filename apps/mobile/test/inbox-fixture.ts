import { createHeaderFixture } from '../../web/test/header-fixture'

/** Normalized synthetic rows only, shared by focused renders and Chromium.
 * Larger runs use the same twelve active agents and a cold issue history. */
export function createInboxFixture(count = 24, sessions = 12) {
  const base = createHeaderFixture(count, sessions)
  const patch = (entity: string, id: string, fields: Record<string, unknown>) => {
    const key = `${entity}:${id}`,
      record = base.records.get(key)
    if (!record) throw new Error('Missing synthetic fixture member')
    base.records.set(key, { ...record, value: { ...(record.value as object), ...fields } })
  }
  for (let index = 0; index < count; index++)
    patch('issueProjection', `synthetic-${index}`, {
      description: { value: `Summary ${index}` },
      brief: `Brief ${index}`,
      color: 'blue',
      ...(index >= 12
        ? { stage: 'done', closedReason: 'done', archived: true, worktreePath: null }
        : {}),
    })
  for (const index of [0, 1, 2, 3, 4, 6])
    patch('issueProjection', `synthetic-${index}`, {
      stage: 'proposed',
      priority: index % 2,
      intentOrigin: 'agent',
    })
  patch('issueProjection', 'synthetic-6', { audience: 'agent' })
  patch('session', 'synthetic-session-0', {
    agentState: {
      phase: 'needs_user',
      since: '2026-10-01T00:00:00Z',
      need: { kind: 'question', summary: 'Choose a direction.' },
    },
    refRepoId: 'synthetic-repo',
    refSeq: 1000,
    refLetter: 'A',
    refIssueId: 'synthetic-0',
  })
  patch('session', 'synthetic-session-1', {
    status: 'exited',
    agentState: { phase: 'working', since: '2026-10-01T00:00:00Z' },
  })
  patch('session', 'synthetic-session-2', {
    offer: { message: 'Ready for a decision.', actions: [], at: '2026-10-01T00:00:00Z' },
  })
  patch('session', 'synthetic-session-3', { headless: true })
  patch('session', 'synthetic-session-4', { agentKind: 'shell' })
  patch('session', 'synthetic-session-5', { archived: true })
  patch('session', 'synthetic-session-7', {
    status: 'hibernated',
    agentState: { phase: 'compacting', since: '2026-10-01T00:00:00Z' },
  })
  const api = base.api as unknown as Record<string, Record<string, unknown>>
  Object.assign(api.sessions!, {
    transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
    answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
  })
  Object.assign(api.quota!, { history: { query: async () => [] } })
  api.superagent = { listThreads: { query: async () => [] } }
  api.pins = { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } }
  api.tabs = { listOrders: { query: async () => ({}) } }
  api.layout = { get: { query: async () => [] } }
  api.repos = { list: { query: async () => [] } }
  api.issues = {
    update: { mutate: async () => {} },
    promote: { mutate: async () => {} },
    start: { mutate: async () => {} },
  }
  return {
    ...base,
    get replica() {
      return base.replica
    },
  }
}
