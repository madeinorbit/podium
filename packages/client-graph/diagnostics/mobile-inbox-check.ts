import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { resolveIssueReference, sessionCardModel } from '@podium/client-core/viewmodels'
import type { PodiumTarget } from '@podium/protocol'
import { mobileInboxViews } from '../src/mobile-inbox'
import type { MobxPool } from '../src/pool'
import { type CheckSection, compareSidebarSnapshots, type SidebarDifference } from './sidebar-check'

export const MOBILE_CARD_FIELDS = [
  'id',
  'seq',
  'title',
  'stage',
  'description',
  'brief',
  'color',
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
const card = (issue: IssueViewModel | undefined) =>
  issue ? Object.fromEntries(MOBILE_CARD_FIELDS.map((key) => [key, issue[key]])) : null

export interface MobileInboxLegacy {
  issues: IssueViewModel[]
  sessions: SessionView[]
  queue: readonly string[]
  booting: boolean
  outboxSize: number
  routes: readonly (string | null)[]
}
export interface MobileInboxCheckInput {
  now: number
  tokens: readonly { token: string; kind: 'issue' | 'session'; prefix: string }[]
  targets: readonly PodiumTarget[]
  screeningIds: readonly string[]
}

/** Explicit differential only. Legacy inputs are supplied by the caller and
 * never touched by ordinary pool readers. Reports retain no authored values. */
export function checkMobileInbox(
  pool: MobxPool,
  legacy: MobileInboxLegacy,
  input: MobileInboxCheckInput,
  onDifference?: (
    difference: Pick<SidebarDifference, 'sectionIndex' | 'rowIndex' | 'field'>,
  ) => void,
) {
  const views = mobileInboxViews(pool)
  if (!views) return { differences: 0, pending: 1, positions: 0, first: null }
  const inbox = views.inbox(),
    screening = views.screening(),
    rows = views.screeningRows(input.screeningIds)
  const byId = new Map<string, IssueViewModel>(legacy.issues.map((issue) => [issue.id, issue]))
  const groups = groupSessions(withoutShells(legacy.sessions))
  const sections = (actual: boolean): CheckSection[] => {
    const value = actual ? inbox.groups : groups
    const result: CheckSection[] = [
      {
        key: 'window',
        fields: {
          booting: actual ? inbox.booting : legacy.booting,
          outboxSize: actual ? inbox.outboxSize : legacy.outboxSize,
        },
        rows: [],
      },
    ]
    for (const key of ['needsYou', 'idle', 'working'] as const)
      result.push({
        key,
        fields: {},
        rows: value[key].map((session) => {
          const issue = actual
            ? inbox.issues[session.issueId ?? '']
            : byId.get(session.issueId ?? '')
          return {
            id: session.sessionId,
            fields: {
              ...sessionCardModel(session, issue, input.now),
              issue: card(issue),
              agentState: session.agentState,
              offer: session.offer,
              agentColor: session.agentColor,
              busy: session.busy,
            },
          }
        }),
      })
    result.push({
      key: 'screening',
      fields: {},
      rows: (actual ? screening.queue : legacy.queue).map((id) => ({ id, fields: {} })),
    })
    result.push({
      key: 'cards',
      fields: {},
      rows: input.screeningIds.map((id) => ({
        id,
        fields: { card: card(actual ? rows.issues[id] : byId.get(id)) },
      })),
    })
    result.push({
      key: 'chips',
      fields: {},
      rows: input.tokens.map(({ token, kind, prefix }, index) => {
        const known = legacy.issues.some((issue) => issue.prefix === prefix)
        const chip = actual
          ? views.chip(token, kind, prefix)
          : {
              known,
              model: known && kind === 'issue' ? resolveIssueReference(token, legacy.issues) : null,
            }
        return { id: String(index), fields: { ...chip } }
      }),
    })
    result.push({
      key: 'routes',
      fields: {},
      rows: input.targets.map((target, index) => {
        const route = actual ? views.route(target) : legacy.routes[index]
        return {
          id: String(index),
          pending: typeof route === 'symbol',
          fields: { route: typeof route === 'symbol' ? null : (route ?? null) },
        }
      }),
    })
    return result
  }
  const actual = sections(true),
    expected = sections(false)
  const pending =
    Number(inbox.booting && !legacy.booting) +
    Number(screening.booting && !legacy.booting) +
    Number(rows.loading)
  const result = compareSidebarSnapshots(
    { sections: expected, pending: 0 },
    { sections: actual, pending },
    (difference) => {
      onDifference?.({
        sectionIndex: difference.sectionIndex,
        rowIndex: difference.rowIndex,
        field: difference.field,
      })
    },
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
