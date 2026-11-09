import { headerView } from '@podium/client-graph/header-views'
import { omitGone } from '@podium/client-graph/lookup'
/** Fixture comparison for pool regression tests. The report exports only counts
 * and positions; both sets of words and authored sends remain in memory. */

import type { IssueViewModel } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import {
  chatArtifactIssue,
  chatInteractions,
  chatIssue,
  chatMentionIssues,
  chatRecords,
  chatReferenceMachines,
  chatReferenceSessions,
} from '@podium/client-graph/chat-context'
import type { PendingInteractionModel } from '@podium/client-graph/message-models'
import type { ReferenceState } from '../../../../tests/worklist/diagnostics/reference-state'

type Store = ReferenceState & { drafts?: Record<string, string> }

import { issueMentions } from '@/lib/at-mention/mention-sources'
import { resolveRef, sessionForIssue } from '@/lib/ref-miniview.before.test.fixture'
import {
  type CheckSection,
  compareSidebarSnapshots,
} from '../../../../tests/worklist/diagnostics/sidebar-check'
import { expectedThreads } from '../../../../tests/worklist/diagnostics/superagent-check'

const loading = (row: unknown): row is symbol => typeof row === 'symbol'
export function checkChatContext(
  pool: MobxPool,
  state: Store,
  issues: readonly IssueViewModel[],
  ids: readonly string[],
  queries = ['', 'SYN', 'task', '1'],
) {
  const expected: CheckSection[] = [],
    actual: CheckSection[] = []
  let pending = 0
  const compare = (key: string, before: unknown, after: unknown, waiting = false) => {
    const fields = { value: before },
      next = { value: after }
    expected.push({ key, fields, rows: [] })
    actual.push({ key, fields: next, pendingFields: waiting ? ['value'] : [], rows: [] })
    if (waiting) pending++
  }
  const mentions = chatMentionIssues(pool)
  for (const query of queries)
    compare(
      `mentions:${queries.indexOf(query)}`,
      issueMentions(issues, query, 5),
      issueMentions(mentions.issues, query, 5),
      mentions.pending > 0,
    )
  const window = omitGone(pool.row('chatWindow', 'window'))
  compare(
    'window',
    {
      attachedSessionId: state.attachedSessionId ?? null,
    },
    window,
    loading(window),
  )
  for (const id of ids) {
    const asks = chatInteractions(pool, id),
      records = chatRecords(pool, id)
    const draft = omitGone(pool.row('chatDraft', id)),
      held = omitGone(pool.row('chatHeld', id))
    const exit = omitGone(pool.row('sessionExit', id))
    compare(
      `sessionExit:${id}`,
      state.replica.exitKind?.('session', id),
      exit && !loading(exit) ? exit.kind : undefined,
      loading(exit),
    )
    const session = state.sessions.find((row) => row.sessionId === id)
    compare(
      `draft:${id}`,
      state.drafts?.[id] ?? '',
      draft && !loading(draft) ? draft.text : '',
      loading(draft),
    )
    const mine = (state.pendingInteractions ?? []).filter(
      (row) => row.sessionId === id && row.status === 'asked',
    )
    compare(
      `pending:${id}`,
      { blocked: mine.length > 0, question: mine.find((row) => row.kind === 'question') },
      {
        blocked: asks.blocked,
        question: (asks.question as PendingInteractionModel | undefined)?.row,
      },
      asks.pending > 0,
    )
    compare(
      `records:${id}`,
      (state.messageRecords ?? []).filter((row) => row.sessionId === id),
      records.records.map((record) => record.row),
      records.pending > 0,
    )
    const serialSends = (
      sends:
        | ReturnType<import('@podium/client-core/conversation').ChatCommands['chatSendsFor']>
        | readonly import('@podium/client-core/engine').OutboxChatSend[],
    ) =>
      sends.map((send) => ({
        ...send,
        failure: send.failure
          ? { message: send.failure.message, retryable: send.failure.retryable }
          : undefined,
      }))
    compare(
      `outbox:${id}`,
      serialSends(state.chatSendsFor(id as never)),
      held && !loading(held) ? serialSends(held.sends) : [],
      loading(held),
    )
    if (session) {
      const artifact = chatArtifactIssue(pool, session)
      const old =
        issues.find((row) => row.id === session.issueId) ??
        issues.find((row) => row.memberSessionIds?.includes(session.sessionId))
      const facts = (issue: IssueViewModel | undefined) =>
        issue
          ? {
              id: issue.id,
              panel: issue.panel,
              root: issue.worktreePath ?? issue.repoPath,
              machineId: issue.machineId,
            }
          : undefined
      compare(
        `artifacts:${id}`,
        facts(old),
        facts(artifact && !loading(artifact) ? artifact : undefined),
        loading(artifact),
      )
    }
  }
  const sessions = chatReferenceSessions(pool)
  const sessionFacts = (rows: Store['sessions']) =>
    rows.map(
      ({
        sessionId,
        displayRef,
        cwd,
        issueId,
        title,
        name,
        archived,
        status,
        lastActiveAt,
        agentKind,
      }) => ({
        sessionId,
        displayRef,
        cwd,
        issueId,
        title,
        name,
        archived,
        status,
        lastActiveAt,
        agentKind,
      }),
    )
  compare(
    'referenceSessions',
    sessionFacts(state.sessions),
    sessionFacts(sessions.sessions),
    sessions.pending > 0,
  )
  // What the composer reads of a machine (POD-6644: the pool's are its facts).
  const machineView = (rows: readonly { id: string; name: string; online: boolean }[]) =>
    rows.map(({ id, name, online }) => ({ id, name, online }))
  compare(
    'referenceMachines',
    machineView(state.machines),
    machineView(chatReferenceMachines(pool)),
  )
  compare(
    'referenceRepos',
    state.repos
      .map((row) => row.path)
      .sort()
      .join('\n'),
    // This diagnostic compares path payloads, while the product's opaque
    // change token is guarded separately by chat-repository-key.test.ts.
    headerView(pool)
      .ids('repository')
      .flatMap((id) => {
        const row = headerView(pool).row('repository', id)
        return row ? [row.path] : []
      })
      .sort()
      .join('\n'),
  )
  const reader = omitGone(pool.row('chatContextReader', 'reader'))
  const threads = reader && !loading(reader) ? reader.threads() : { threads: [], pending: 1 }
  compare(
    'threads',
    expectedThreads(state.superagentThreads ?? []),
    threads.threads,
    threads.pending > 0,
  )
  const targetIdentity = (target: ReturnType<typeof sessionForIssue>) =>
    target ? { sessionId: target.session.sessionId, via: target.via.id } : null
  for (const issue of issues.slice(0, 8)) {
    compare(
      `sessionTarget:${issue.id}`,
      targetIdentity(sessionForIssue(issue, issues, state.sessions)),
      targetIdentity(sessionForIssue(issue, issues, sessions.sessions)),
      sessions.pending > 0,
    )
    const row = chatIssue(pool, issue.id)
    compare(`issueSeq:${issue.id}`, issue.seq, row && !loading(row) ? row.seq : null, loading(row))
  }
  const refIdentity = (target: ReturnType<typeof resolveRef>) =>
    target?.kind === 'session'
      ? { kind: target.kind, ref: target.ref, sessionId: target.session.sessionId }
      : target
  for (const session of state.sessions.filter((row) => row.displayRef).slice(0, 8))
    compare(
      `reference:${session.sessionId}`,
      refIdentity(resolveRef(session.displayRef!, [], state.sessions)),
      refIdentity(resolveRef(session.displayRef!, [], sessions.sessions)),
      sessions.pending > 0,
    )
  const result = compareSidebarSnapshots(
    { sections: expected, pending: 0 },
    { sections: actual, pending },
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
