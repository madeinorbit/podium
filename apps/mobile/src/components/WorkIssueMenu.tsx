import { discoveredPlacement, type IssueNavigationModel } from '@podium/client-core/viewmodels'
import {
  type IssueCloseReason,
  type IssueWire,
  issueStatusMenuEntries,
  issueStatusValueOf,
  parseIssueStatusValue,
  type SessionMeta,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useEffect, useMemo, useState } from 'react'
import { useStoreActions } from '../client/hooks'
import { issueCloseBlockers } from '../lib/issue-close'
import { type WorkMenuActionId, type WorkMenuLane, workMenuActionIds } from '../lib/work-menu'
import { color } from '../theme/theme'
import { ActionSheet, type SheetAction } from './ActionSheet'
import { IssueCloseSheet } from './IssueCloseSheet'
import { IssueColorSheet } from './IssueColorSheet'
import { StageGlyph } from './StageGlyph'
import { PromptSheet } from './task-detail/PromptSheet'

export interface WorkIssueMenuTarget {
  issue: IssueNavigationModel
  lane: WorkMenuLane
  canBringBack?: boolean
}

type MenuSheet =
  | null
  | { kind: 'menu' }
  | { kind: 'rename' }
  | { kind: 'status' }
  | { kind: 'color' }
  | { kind: 'confirm-delete' }
  | { kind: 'confirm-close'; reason: IssueCloseReason }

/**
 * Work's long-press surface. Once the desktop sidebar vocabulary in full, and
 * trimmed by the 2026-08-27 device review to the acts a long-press is actually
 * for — see {@link workMenuActionIds} for what survived and why (the Move
 * reorder pair went in the 2026-08-28 follow-up review). Nested desktop
 * flyouts become one-at-a-time bottom sheets.
 */
export function WorkIssueMenu({
  target,
  issues,
  sessions,
  onClose,
}: {
  target: WorkIssueMenuTarget
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  onClose: () => void
}) {
  // Actions only — identity-stable, so the open menu does not re-render on
  // every store publish while an agent streams underneath it.
  const store = useStoreActions()
  const [sheet, setSheet] = useState<MenuSheet>({ kind: 'menu' })
  const issue = target.issue
  const closeIf = (kind: NonNullable<MenuSheet>['kind']) => () =>
    setSheet((current) => (current?.kind === kind ? null : current))

  // `null` means the active sheet finished. A stale onClose from the root menu
  // cannot reach this state after it has handed off to a nested sheet because
  // closeIf checks the current kind first.
  useEffect(() => {
    if (sheet === null) onClose()
  }, [onClose, sheet])

  const placement = useMemo(
    () => discoveredPlacement(issue, new Map(issues.map((candidate) => [candidate.id, candidate]))),
    [issue, issues],
  )
  const agentSessions = useMemo(
    () => sessions.filter((session) => session.issueId === issue.id && !session.archived),
    [issue.id, sessions],
  )
  const sessionCount = new Set(issue.memberSessionIds ?? agentSessions.map((s) => s.sessionId)).size
  const actionIds = workMenuActionIds(issue, target.lane, {
    placement: placement?.originId != null,
  })

  const finish = (result?: Promise<unknown>): void => {
    setSheet(null)
    void result?.catch(() => {})
  }

  const rootActions = actionIds.flatMap((id): SheetAction[] => {
    const action = actionFor(id)
    return action ? [action] : []
  })

  return (
    <>
      <ActionSheet
        visible={sheet?.kind === 'menu'}
        title={`${issueDisplayRef(issue)} ${issue.title}`}
        actions={rootActions}
        onClose={closeIf('menu')}
      />

      <PromptSheet
        visible={sheet?.kind === 'rename'}
        title="Rename task"
        placeholder="Task title"
        confirmLabel="Rename"
        initialValue={issue.title}
        multiline={false}
        onConfirm={(title) => {
          if (title && title !== issue.title) {
            finish(store.updateIssue(issue.id, { title }))
          } else {
            finish()
          }
        }}
        onClose={closeIf('rename')}
      />

      <ActionSheet
        visible={sheet?.kind === 'status'}
        title="Status"
        actions={issueStatusMenuEntries().map((entry) => ({
          label: entry.label,
          ...(entry.hint ? { hint: entry.hint } : {}),
          icon: <StageGlyph stage={entry.status} size={15} ground={color.surface} />,
          selected: entry.value === issueStatusValueOf(issue),
          onPress: () => {
            const intent = parseIssueStatusValue(entry.value)
            if (!intent) return
            if (intent.kind === 'stage') {
              finish(store.updateIssue(issue.id, { stage: intent.stage }))
            } else if (issueCloseBlockers(issue, sessions).length > 0) {
              setSheet({ kind: 'confirm-close', reason: intent.reason })
            } else {
              finish(store.closeIssue(issue.id, intent.reason))
            }
          },
        }))}
        onClose={closeIf('status')}
      />

      <ActionSheet
        visible={sheet?.kind === 'confirm-delete'}
        title="Delete this task?"
        subtitle={`${describeCascade(1, sessionCount)} Tasks and sessions can be restored; running agents will be stopped.`}
        actions={[
          {
            label: 'Delete',
            destructive: true,
            onPress: () => finish(store.deleteIssue(issue.id)),
          },
        ]}
        onClose={closeIf('confirm-delete')}
      />

      <IssueCloseSheet
        issue={issue}
        sessions={sessions}
        reason={sheet?.kind === 'confirm-close' ? sheet.reason : null}
        onConfirm={(reason) => finish(store.closeIssue(issue.id, reason))}
        onClose={closeIf('confirm-close')}
      />

      <IssueColorSheet issue={sheet?.kind === 'color' ? issue : null} onClose={closeIf('color')} />
    </>
  )

  function actionFor(id: WorkMenuActionId): SheetAction | null {
    switch (id) {
      case 'rename':
        return { label: 'Rename', onPress: () => setSheet({ kind: 'rename' }) }
      case 'read':
        return {
          label: issue.unread ? 'Mark as read' : 'Mark as unread',
          onPress: () =>
            finish(issue.unread ? store.markIssueRead(issue.id) : store.markIssueUnread(issue.id)),
        }
      case 'status':
        return { label: 'Set status', onPress: () => setSheet({ kind: 'status' }) }
      case 'color':
        return { label: 'Set colour', onPress: () => setSheet({ kind: 'color' }) }
      case 'placement': {
        if (!placement) return null
        const originId = placement.originId
        if (!originId) return null
        return {
          label:
            placement.placement === 'mission'
              ? `Move to top level (out of ${placement.originRef ?? 'this mission'})`
              : `Move into ${placement.originRef ?? 'the task that found it'}`,
          onPress: () =>
            finish(
              store.setIssuePlacement(
                issue.id,
                placement.placement === 'mission' ? 'own' : 'mission',
                originId,
              ),
            ),
        }
      }
      case 'bringBack':
        return {
          label: 'Bring back from Closed',
          ...(target.canBringBack === false
            ? { disabled: true, hint: 'The fold keeps closures older than a day' }
            : {}),
          onPress: () => finish(store.setIssueTucked(issue.id, false)),
        }
      case 'undefer':
        return { label: 'Unsnooze', onPress: () => finish(store.undeferIssue(issue.id)) }
      case 'delete':
        return {
          label: 'Delete…',
          destructive: true,
          onPress: () => setSheet({ kind: 'confirm-delete' }),
        }
    }
  }
}

function describeCascade(taskCount: number, sessionCount: number): string {
  const tasks = `${taskCount} task${taskCount === 1 ? '' : 's'}`
  if (sessionCount === 0) return `This affects ${tasks}.`
  return `This affects ${tasks} and ${sessionCount} agent${sessionCount === 1 ? '' : 's'}.`
}
