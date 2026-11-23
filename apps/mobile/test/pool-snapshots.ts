/** Synthetic regression outputs. These helpers read only the pool; expected
 * values were captured while the independent pilot parity controls were green. */

import type { IssueViewModel, IssueWithBodies } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { groupRelations } from '@podium/client-core/values'
import { here } from '@podium/client-graph/lookup'
import { mobileInboxViews } from '@podium/client-graph/mobile-inbox'
import { createMobileSessionReader } from '@podium/client-graph/mobile-session-context'
import { MOBILE_SESSION_SCHEMA } from '@podium/client-graph/mobile-session-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { issueDisplayRef, type PodiumTarget } from '@podium/protocol'

const cardFields = [
  'id',
  'seq',
  'title',
  'stage',
  'description',
  'brief',
  'repoPath',
  'displayRef',
  'priority',
  'type',
  'createdAt',
  'defaultAgent',
  'defaultModel',
  'defaultEffort',
  'parentBranch',
  'parentId',
  'dependencyNote',
  'blockedByNotes',
  'childCount',
  'childDoneCount',
  'intentOrigin',
  'isDraftVessel',
] as const
/** A row's fields, its bodies read from the pool's model (POD-6767). */
const withBodies = (pool: MobxPool, row: IssueViewModel) =>
  pool.issueObject(row.id) as unknown as IssueWithBodies
const card = (pool: MobxPool, row: IssueViewModel | undefined) => {
  if (!row) return null
  const model = withBodies(pool, row)
  return Object.fromEntries(
    cardFields.map((key) => [
      key,
      key === 'description' || key === 'brief' ? model[key] : (row as Record<string, unknown>)[key],
    ]),
  )
}
const issueFacts = (pool: MobxPool, row: IssueViewModel | undefined, model = row && withBodies(pool, row)) =>
  row && model
    ? {
        id: row.id,
        ref: issueDisplayRef(row),
        title: row.title,
        stage: row.stage,
        priority: row.priority,
        pinned: row.pinned,
        needsHuman: row.needsHuman,
        isDraftVessel: row.isDraftVessel,
        description: model.description,
        activityNotes: model.activityNotes,
        notesUpdatedAt: row.notesUpdatedAt,
        branch: row.branch,
        worktreePath: row.worktreePath,
        gitState: row.gitState,
        panel: model.panel,
        relations: groupRelations(row),
      }
    : undefined
const sessionFacts = (row: SessionView | undefined) =>
  row
    ? Object.fromEntries(
        MOBILE_SESSION_SCHEMA.session.summary.map((key) => [key, Reflect.get(row, key)]),
      )
    : undefined

export function mobileSessionSnapshot(pool: MobxPool, ids: readonly string[], now: number) {
  const reader = createMobileSessionReader(pool)
  return {
    machines: reader.machines(),
    booting: reader.booting(),
    contexts: ids.map((id) => {
      const session = reader.session(id)
      const issue = reader.issue(session && session !== LOADING ? session.issueId : undefined)
      const ports = reader.conversation(id)
      const question = reader.question(id)
      return {
        id,
        session: sessionFacts(session === LOADING ? undefined : session),
        issue: issueFacts(pool, issue === LOADING ? undefined : issue),
        spawn: reader.spawnPending(id),
        prompt: reader.spawnPrompt(id),
        exit: reader.exit(id),
        draft: reader.draft(id),
        question: { ...question, question: question.question ? here(pool.row('pendingInteraction', question.question.id)) : undefined },
        records: ports.records.map(record => here(record.row)),
        held: ports.sends.map(({ failure, ...send }) => ({
          ...send,
          failure: failure ? { message: failure.message, retryable: failure.retryable } : undefined,
        })),
        ready: ports.ready,
      }
    }),
  }
}

export function mobileInboxSnapshot(
  pool: MobxPool,
  input: {
    now: number
    tokens: readonly { token: string; kind: 'issue' | 'session'; prefix: string }[]
    targets: readonly PodiumTarget[]
    screeningIds: readonly string[]
  },
) {
  const views = mobileInboxViews(pool)
  if (!views) return { pending: true }
  const screening = views.screening(),
    rows = input.screeningIds.map((id) => views.issue(id))
  return {
    screening: screening.queue,
    cards: input.screeningIds.map((id, at) => ({
      id,
      card: card(pool, typeof rows[at] === 'symbol' ? undefined : rows[at]),
    })),
    chips: input.tokens.map(({ token, kind, prefix }) => views.chip(token, kind, prefix)),
    routes: input.targets.map((target) => views.route(target)),
    loading: rows.some((row) => typeof row === 'symbol'),
  }
}
