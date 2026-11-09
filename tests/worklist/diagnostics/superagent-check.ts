import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import {
  superagentCursor,
  superagentFeed,
  superagentFocus,
  superagentQuestion,
  superagentState,
  superagentThread,
} from '@podium/client-graph/superagent'
/** Fixture and private-replay comparison. Reference values stay in memory; only
 * counts, positions and field paths leave a replay or browser fixture. */
import type { ReferenceState as Store } from './reference-state'
import { type CheckSection, compareSidebarSnapshots } from './sidebar-check'

type State = Pick<
  Store,
  | 'superagentThreads'
  | 'superThreadId'
  | 'issueEvents'
  | 'pendingInteractions'
  | 'sessions'
  | 'repos'
  | 'paneA'
  | 'selectedWorktree'
  | 'readPosition'
>
/** One reference thread record as the superagent screens render it: the
 * synced `superagentThread` row (POD-6675), named by its thread id. */
function expectedThread(row: State['superagentThreads'][number]) {
  return {
    id: row.threadId,
    kind: row.kind,
    archived: row.archived,
    resumable: row.resumable,
    turnRunning: row.turnRunning,
    lastTurnFailure: row.lastTurnFailure,
    ...(row.originSessionId ? { originSessionId: row.originSessionId } : {}),
    ...(row.title !== undefined ? { title: row.title } : {}),
    ...(row.repoPath !== undefined ? { repoPath: row.repoPath } : {}),
    ...(row.podiumSessionId ? { podiumSessionId: row.podiumSessionId } : {}),
    ...(row.agentKind !== undefined ? { agentKind: row.agentKind } : {}),
    ...(row.model !== undefined ? { model: row.model } : {}),
    ...(row.effort !== undefined ? { effort: row.effort } : {}),
  }
}

/** My open threads, newest write first: the order `superagentState` lists. */
export function expectedThreads(rows: readonly State['superagentThreads'][number][]) {
  return rows
    .filter((row) => !row.archived)
    .sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? a.threadId < b.threadId
          ? -1
          : 1
        : a.updatedAt < b.updatedAt
          ? 1
          : -1,
    )
    .map(expectedThread)
}

export function checkSuperagent(pool: MobxPool, state: State) {
  const threads = superagentState(pool),
    global = superagentThread(pool, 'global'),
    feed = superagentFeed(pool),
    cursor = superagentCursor(pool),
    focus = superagentFocus(pool)
  const threadRows = expectedThreads(state.superagentThreads ?? [])
  // `global` under the server's rule: the bare row, else `global:<owner>`.
  const owners = new Map((state.superagentThreads ?? []).map((row) => [row.threadId, row.ownerUserId]))
  const named = (id: string) =>
    id !== 'global'
      ? threadRows.find((row) => row.id === id)
      : (threadRows.find((row) => row.kind === 'global' && row.id === 'global') ??
        threadRows.find((row) => row.kind === 'global' && row.id === `global:${owners.get(row.id)}`))
  const active = named(state.superThreadId)
  const expected: CheckSection[] = [
    {
      key: 'threads',
      fields: {
        active,
        activeSessionId: active?.podiumSessionId,
        global: named('global'),
      },
      rows: threadRows.map((row) => ({ id: row.id, fields: { ...row } })),
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
    { key: 'position', fields: { ...state.readPosition.get('issueEvents') }, rows: [] },
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
      rows: threads.threads.map((row) => ({ id: row.id, fields: { ...row } })),
    },
    {
      key: 'events',
      fields: {},
      rows: feed.events.map((row) => ({ id: String(row.id), fields: { ...row } })),
    },
    { key: 'position', fields: { ...cursor.cursor }, rows: [] },
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
      ...threadRows.flatMap((row) => (row.podiumSessionId ? [row.podiumSessionId] : [])),
      ...state.pendingInteractions.map((row) => row.sessionId),
    ]),
  ]
  for (const id of ids) {
    const question = superagentQuestion(pool, id),
      session = omitGone(pool.row('session', id))
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
