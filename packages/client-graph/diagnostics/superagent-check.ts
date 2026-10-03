/** Fixture and private-replay comparison. Reference values stay in memory; only
 * counts, positions and field paths leave a replay or browser fixture. */
import type { Store } from '@podium/client-core/engine'
import type { MobxPool } from '../src/pool'
import {
  superagentCursor,
  superagentFeed,
  superagentFocus,
  superagentQuestion,
  superagentState,
  superagentThread,
} from '../src/superagent'
import { type CheckSection, compareSidebarSnapshots } from './sidebar-check'

type State = Pick<
  Store,
  | 'superThreads'
  | 'superThreadId'
  | 'issueEvents'
  | 'pendingInteractions'
  | 'sessions'
  | 'repos'
  | 'paneA'
  | 'selectedWorktree'
  | 'readPosition'
>
export function checkSuperagent(pool: MobxPool, state: State) {
  const threads = superagentState(pool),
    global = superagentThread(pool, 'global'),
    feed = superagentFeed(pool),
    cursor = superagentCursor(pool),
    focus = superagentFocus(pool)
  const active = state.superThreads.find((row) => row.id === state.superThreadId)
  const expected: CheckSection[] = [
    {
      key: 'threads',
      fields: {
        active,
        activeSessionId: active?.podiumSessionId,
        global: state.superThreads.find((row) => row.id === 'global'),
      },
      rows: state.superThreads.map((row) => ({
        id: row.id,
        fields: {
          ...row,
          session: row.podiumSessionId ? [row.podiumSessionId] : [],
          originSession: row.originSessionId ? [row.originSessionId] : [],
        },
      })),
    },
    {
      key: 'events',
      fields: {},
      rows: [...state.issueEvents]
        .sort((a, b) => a.eventId - b.eventId)
        .slice(-40)
        .map((row) => ({
          id: String(row.eventId),
          fields: {
            id: row.eventId,
            ts: row.ts,
            kind: row.kind,
            subject: row.subject,
            repoPath: row.repoPath,
            payload: row.payload,
          },
        })),
    },
    { key: 'cursor', fields: { ...state.readPosition.get('issueEvents') }, rows: [] },
    {
      key: 'focus',
      fields: {
        repos: state.repos,
        selectedWorktree: state.selectedWorktree,
        paneA: state.paneA,
        cwd: state.sessions.find((row) => row.sessionId === state.paneA)?.cwd,
      },
      rows: [],
    },
  ]
  const actual: CheckSection[] = [
    {
      key: 'threads',
      fields: {
        active: threads.active,
        activeSessionId: threads.activeSessionId,
        global: global.thread,
      },
      rows: threads.threads.map((row) => ({
        id: row.id,
        fields: {
          ...row,
          session: pool.sources.related('superThread', row.id, 'session'),
          originSession: pool.sources.related('superThread', row.id, 'originSession'),
        },
      })),
    },
    {
      key: 'events',
      fields: {},
      rows: feed.events.map((row) => ({ id: String(row.id), fields: { ...row } })),
    },
    { key: 'cursor', fields: { ...cursor.cursor }, rows: [] },
    {
      key: 'focus',
      fields: {
        repos: focus.repos,
        selectedWorktree: focus.selectedWorktree,
        paneA: focus.paneA,
        cwd: focus.sessions[0]?.cwd,
      },
      rows: [],
    },
  ]
  let pending =
    Number(threads.loading) +
    Number(global.loading) +
    Number(feed.loading) +
    Number(cursor.loading) +
    Number(focus.loading)
  const ids = [
    ...new Set([
      ...state.superThreads.flatMap((row) => (row.podiumSessionId ? [row.podiumSessionId] : [])),
      ...state.pendingInteractions.map((row) => row.sessionId),
    ]),
  ]
  for (const id of ids) {
    const question = superagentQuestion(pool, id),
      session = pool.row('session', id)
    pending += Number(question.loading) + Number(typeof session === 'symbol')
    const referenceSession = state.sessions.find((row) => row.sessionId === id)
    const sessionFields = (row: typeof referenceSession) => ({
      cwd: row?.cwd,
      machineId: row?.machineId,
    })
    expected.push({
      key: `session:${id}`,
      fields: {
        question: state.pendingInteractions.find(
          (row) => row.sessionId === id && row.kind === 'question' && row.status === 'asked',
        ),
        ...sessionFields(referenceSession),
      },
      rows: [],
    })
    actual.push({
      key: `session:${id}`,
      pendingFields: typeof session === 'symbol' ? ['cwd', 'machineId'] : [],
      fields: {
        question: question.question,
        ...sessionFields(
          typeof session === 'symbol' ? undefined : (session as typeof referenceSession),
        ),
      },
      rows: [],
    })
  }
  const result = compareSidebarSnapshots(
    { sections: expected, pending: 0 },
    { sections: actual, pending },
  )
  return {
    differences: result.differences,
    pending: result.pending,
    positions: result.rows,
    first: result.first
      ? {
          sectionIndex: result.first.sectionIndex,
          rowIndex: result.first.rowIndex,
          field: result.first.field,
        }
      : null,
  }
}
