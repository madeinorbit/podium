/** Synthetic regression outputs. These helpers read only the pool; expected
 * values were captured while the independent pilot parity controls were green. */
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { groupRelations, sessionCardModel } from '@podium/client-core/viewmodels'
import { mobileInboxViews } from '@podium/client-graph/mobile-inbox'
import { createMobileSessionReader } from '@podium/client-graph/mobile-session-context'
import { MOBILE_SESSION_SCHEMA } from '@podium/client-graph/mobile-session-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { issueDisplayRef, type PodiumTarget } from '@podium/protocol'

const cardFields = ['id', 'seq', 'title', 'stage', 'description', 'brief', 'color',
  'repoPath', 'displayRef', 'priority', 'type', 'createdAt', 'defaultAgent',
  'defaultModel', 'defaultEffort', 'parentBranch', 'parentId', 'dependencyNote',
  'blockedByNotes', 'childCount', 'childDoneCount', 'intentOrigin', 'isDraftVessel'] as const
const card = (row: IssueViewModel | undefined) =>
  row ? Object.fromEntries(cardFields.map(key => [key, row[key]])) : null
const issueFacts = (row: IssueViewModel | undefined) => row ? {
  id: row.id, ref: issueDisplayRef(row), title: row.title, stage: row.stage,
  color: row.color, priority: row.priority, pinned: row.pinned, needsHuman: row.needsHuman,
  isDraftVessel: row.isDraftVessel, description: row.description,
  activityNotes: row.activityNotes, notesUpdatedAt: row.notesUpdatedAt,
  branch: row.branch, worktreePath: row.worktreePath, gitState: row.gitState,
  panel: row.panel, relations: groupRelations(row),
} : undefined
const sessionFacts = (row: SessionView | undefined) => row ? Object.fromEntries(
  MOBILE_SESSION_SCHEMA.session.summary.map(key => [key, Reflect.get(row, key)]),
) : undefined

export function mobileSessionSnapshot(pool: MobxPool, ids: readonly string[], now: number) {
  const reader = createMobileSessionReader(pool)
  const sessions = reader.sessions(), references = reader.issues()
  const groups = groupSessions(withoutShells([...sessions.sessions]))
  return {
    sessionOrder: sessions.sessions.map(row => row.sessionId),
    roster: Object.fromEntries((['needsYou', 'working', 'idle'] as const).map(key => [key,
      groups[key].map(row => sessionCardModel(row, references.issues.find(issue => issue.id === row.issueId), now)),
    ])),
    referenceIssues: references.issues.map(row => ({ id: row.id, ref: issueDisplayRef(row),
      seq: row.seq, title: row.title, stage: row.stage, color: row.color })),
    machines: reader.machines(), booting: reader.booting(),
    contexts: ids.map(id => {
      const session = reader.session(id)
      const issue = reader.issue(session && session !== LOADING ? session.issueId : undefined)
      const ports = reader.conversation(id)
      return { id, session: sessionFacts(session === LOADING ? undefined : session),
        issue: issueFacts(issue === LOADING ? undefined : issue),
        spawn: reader.spawnPending(id), prompt: reader.spawnPrompt(id), exit: reader.exit(id),
        draft: reader.draft(id), question: reader.question(id), records: ports.records,
        held: ports.sends.map(({ failure, ...send }) => ({ ...send,
          failure: failure ? { message: failure.message, retryable: failure.retryable } : undefined,
        })), ready: ports.ready,
      }
    }),
    pending: sessions.pending + references.pending,
  }
}

export function mobileInboxSnapshot(pool: MobxPool, input: {
  now: number
  tokens: readonly { token: string; kind: 'issue' | 'session'; prefix: string }[]
  targets: readonly PodiumTarget[]
  screeningIds: readonly string[]
}) {
  const views = mobileInboxViews(pool)
  if (!views) return { pending: true }
  const inbox = views.inbox(), screening = views.screening(), rows = views.screeningRows(input.screeningIds)
  return {
    window: { booting: inbox.booting, outboxSize: inbox.outboxSize },
    groups: Object.fromEntries((['needsYou', 'idle', 'working'] as const).map(key => [key,
      inbox.groups[key].map(session => ({ id: session.sessionId,
        ...sessionCardModel(session, inbox.issues[session.issueId ?? ''], input.now),
        issue: card(inbox.issues[session.issueId ?? '']), agentState: session.agentState,
        offer: session.offer, agentColor: session.agentColor, busy: session.busy,
      })),
    ])),
    screening: screening.queue,
    cards: input.screeningIds.map(id => ({ id, card: card(rows.issues[id]) })),
    chips: input.tokens.map(({ token, kind, prefix }) => views.chip(token, kind, prefix)),
    routes: input.targets.map(target => views.route(target)),
    loading: rows.loading,
  }
}
