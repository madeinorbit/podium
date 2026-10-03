/** Sidebar-check comparison: only counts and positions leave this module.
 * The legacy publication is an oracle input, never a production pool reader. */
import type { Store } from '@podium/client-core/engine'
import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { groupRelations, sessionCardModel } from '@podium/client-core/viewmodels'
import { issueDisplayRef } from '@podium/protocol'
import { createMobileSessionReader } from '../src/mobile-session-context'
import { MOBILE_SESSION_SCHEMA } from '../src/mobile-session-schema'
import type { MobxPool } from '../src/pool'
import { LOADING } from '../src/worklist/rollup'
import { type CheckSection, compareSidebarSnapshots } from './sidebar-check'

const pending = (row: unknown): row is symbol => typeof row === 'symbol'
const sessionFacts = (row: SessionView | undefined) =>
  row
    ? Object.fromEntries(
        MOBILE_SESSION_SCHEMA.session.summary.map((key) => [key, Reflect.get(row, key)]),
      )
    : undefined
const issueFacts = (row: IssueViewModel | undefined) =>
  row
    ? {
        id: row.id,
        ref: issueDisplayRef(row),
        title: row.title,
        stage: row.stage,
        color: row.color,
        priority: row.priority,
        pinned: row.pinned,
        needsHuman: row.needsHuman,
        isDraftVessel: row.isDraftVessel,
        description: row.description,
        activityNotes: row.activityNotes,
        notesUpdatedAt: row.notesUpdatedAt,
        branch: row.branch,
        worktreePath: row.worktreePath,
        gitState: row.gitState,
        panel: row.panel,
        relations: groupRelations(row),
      }
    : undefined

export function checkMobileSessionContext(
  pool: MobxPool,
  state: Store,
  issues: readonly IssueViewModel[],
  ids: readonly string[] = state.sessions.map((row) => row.sessionId),
) {
  const reader = createMobileSessionReader(pool),
    expected: CheckSection[] = [],
    actual: CheckSection[] = []
  let waits = 0
  function compare(key: string, before: unknown, after: unknown, waiting = false) {
    expected.push({ key, fields: { value: before }, rows: [] })
    actual.push({
      key,
      fields: { value: after },
      pendingFields: waiting ? ['value'] : [],
      rows: [],
    })
    if (waiting) waits++
  }
  const sessions = reader.sessions(),
    references = reader.issues()
  const roster = (rows: readonly SessionView[], tasks: readonly IssueViewModel[]) => {
    const groups = groupSessions(withoutShells([...rows]))
    return Object.fromEntries(
      (['needsYou', 'working', 'idle'] as const).map((key) => [
        key,
        groups[key].map((row) =>
          sessionCardModel(
            row,
            tasks.find((issue) => issue.id === row.issueId),
            state.coarseNow,
          ),
        ),
      ]),
    )
  }
  compare(
    'sessionOrder',
    state.sessions.map((row) => row.sessionId),
    sessions.sessions.map((row) => row.sessionId),
    sessions.pending > 0,
  )
  compare(
    'roster',
    roster(state.sessions, issues),
    roster(sessions.sessions, references.issues),
    sessions.pending > 0 || references.pending > 0,
  )
  compare(
    'referenceIssues',
    issues
      .filter((row) => !row.deletedAt)
      .map((row) => ({
        id: row.id,
        ref: issueDisplayRef(row),
        seq: row.seq,
        title: row.title,
        stage: row.stage,
        color: row.color,
      })),
    references.issues.map((row) => ({
      id: row.id,
      ref: issueDisplayRef(row),
      seq: row.seq,
      title: row.title,
      stage: row.stage,
      color: row.color,
    })),
    references.pending > 0,
  )
  compare('machines', state.machines, reader.machines())
  compare(
    'booting',
    state.replica.getCursor() === null &&
      state.sessions.length === 0 &&
      state.issueProjections.length === 0,
    reader.booting(),
    pool.row('mobileSessionWindow', 'window') === LOADING ||
      pool.row('chatSessionOrder', 'order') === LOADING ||
      pool.row('chatIssueOrder', 'order') === LOADING,
  )
  for (const id of ids) {
    const old = state.sessions.find((row) => row.sessionId === id),
      row = reader.session(id)
    compare(
      `session:${id}`,
      sessionFacts(old),
      sessionFacts(row === LOADING ? undefined : row),
      row === LOADING,
    )
    const issue = reader.issue(old?.issueId)
    compare(
      `issue:${id}`,
      issueFacts(issues.find((issue) => issue.id === old?.issueId && !issue.deletedAt)),
      issueFacts(issue === LOADING ? undefined : issue),
      issue === LOADING,
    )
    const spawn = reader.spawnPending(id),
      prompt = reader.spawnPrompt(id),
      exit = reader.exit(id)
    compare(`spawn:${id}`, state.pendingSpawnIds.has(id as never), spawn, pending(spawn))
    compare(`prompt:${id}`, state.pendingSpawnPrompts.get(id as never), prompt, pending(prompt))
    compare(`exit:${id}`, state.replica.exitKind?.('session', id), exit, pending(exit))
    const draft = reader.draft(id),
      question = reader.question(id),
      ports = reader.conversation(id)
    compare(`draft:${id}`, state.drafts[id] ?? '', draft, pending(draft))
    compare(
      `question:${id}`,
      (state.pendingInteractions ?? []).find(
        (row) => row.sessionId === id && row.kind === 'question' && row.status === 'asked',
      ),
      question.question,
      question.pending > 0,
    )
    compare(
      `records:${id}`,
      (state.messageRecords ?? []).filter((row) => row.sessionId === id),
      ports.records,
      !ports.ready,
    )
    const sends = (values: Readonly<ReturnType<Store['chatSendsFor']>>) =>
      values.map(({ failure, ...send }) => ({
        ...send,
        failure: failure ? { message: failure.message, retryable: failure.retryable } : undefined,
      }))
    compare(`held:${id}`, sends(state.chatSendsFor(id as never)), sends(ports.sends), !ports.ready)
  }
  const result = compareSidebarSnapshots(
    { sections: expected, pending: 0 },
    { sections: actual, pending: waits },
  )
  return {
    differences: result.differences,
    pending: result.pending,
    positions: expected.length,
    first: result.first
      ? {
          sectionIndex: result.first.sectionIndex,
          rowIndex: result.first.rowIndex,
          field: result.first.field,
        }
      : null,
  }
}
