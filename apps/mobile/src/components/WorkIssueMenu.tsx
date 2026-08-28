import {
  discoveredPlacement,
  type IssueNavigationModel,
  spawnIssueAgent,
} from '@podium/client-core/viewmodels'
import {
  DEFER_NEXT_MESSAGE,
  type IssueCloseReason,
  type IssueWire,
  issueStatusMenuEntries,
  issueStatusValueOf,
  parseIssueStatusValue,
  type SessionMeta,
  snoozeUntil1h,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useEffect, useMemo, useState } from 'react'
import { useMobileStore } from '../client/hooks'
import { ISSUE_AGENT_KINDS, ISSUE_AGENT_LABELS, issueAgentKind } from '../lib/agent-models'
import { issueCloseBlockers } from '../lib/issue-close'
import {
  type WorkMenuActionId,
  type WorkMenuLane,
  workDeferDateFromNow,
  workIssueStartable,
  workMenuActionIds,
} from '../lib/work-menu'
import { color } from '../theme/theme'
import { ActionSheet, type SheetAction } from './ActionSheet'
import { IssueCloseSheet } from './IssueCloseSheet'
import { IssueColorSheet } from './IssueColorSheet'
import { PriorityGlyph, StageGlyph } from './StageGlyph'
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
  | { kind: 'priority' }
  | { kind: 'agent' }
  | { kind: 'labels' }
  | { kind: 'defer' }
  | { kind: 'color' }
  | { kind: 'confirm-archive' }
  | { kind: 'confirm-delete' }
  | { kind: 'confirm-close'; reason: IssueCloseReason }

interface MoveCapabilities {
  top: boolean
  up: boolean
  down: boolean
}

/**
 * Work's long-press surface, projected from the desktop sidebar vocabulary.
 * Nested desktop flyouts become one-at-a-time bottom sheets; their actions and
 * ordering stay the same. Phone-only Peek and Move controls remain because they
 * replace a second pane and a mouse drag respectively.
 */
export function WorkIssueMenu({
  target,
  issues,
  sessions,
  moves,
  onOpen,
  onPeek,
  onMove,
  onClose,
}: {
  target: WorkIssueMenuTarget
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  moves: MoveCapabilities
  onOpen: (issue: IssueWire) => void
  onPeek: (issue: IssueWire) => void
  onMove: (issue: IssueWire, to: 'top' | 'up' | 'down') => void
  onClose: () => void
}) {
  const store = useMobileStore()
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
  const allLabels = useMemo(
    () => [...new Set(issues.flatMap((candidate) => candidate.labels))].sort(),
    [issues],
  )
  const agentSessions = useMemo(
    () => sessions.filter((session) => session.issueId === issue.id && !session.archived),
    [issue.id, sessions],
  )
  const sessionCount = new Set(issue.memberSessionIds ?? agentSessions.map((s) => s.sessionId)).size
  const archiveTaskCount = 1 + issue.childCount
  const startable = workIssueStartable(issue)
  const actionIds = workMenuActionIds(issue, target.lane, {
    placement: placement?.originId != null,
    moveTop: moves.top,
    moveUp: moves.up,
    moveDown: moves.down,
  })

  const finish = (result?: Promise<unknown>): void => {
    setSheet(null)
    void result?.catch(() => {})
  }

  const archive = (): void => {
    if (issue.childCount > 0 || sessionCount > 0) {
      setSheet({ kind: 'confirm-archive' })
      return
    }
    finish(store.updateIssue(issue.id, { archived: true }))
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
        visible={sheet?.kind === 'priority'}
        title="Priority"
        actions={[0, 1, 2, 3, 4].map((priority) => ({
          label: `P${priority}`,
          icon: <PriorityGlyph priority={priority} size={15} />,
          selected: issue.priority === priority,
          onPress: () => finish(store.updateIssue(issue.id, { priority })),
        }))}
        onClose={closeIf('priority')}
      />

      <ActionSheet
        visible={sheet?.kind === 'agent'}
        title={startable ? 'Run now' : 'Assign agent'}
        actions={agentActions()}
        onClose={closeIf('agent')}
      />

      <ActionSheet
        visible={sheet?.kind === 'labels'}
        title="Labels"
        subtitle={allLabels.length === 0 ? 'No labels in this repository yet.' : undefined}
        actions={
          allLabels.length === 0
            ? [{ label: 'No labels', disabled: true, onPress: () => {} }]
            : allLabels.map((label) => ({
                label,
                selected: issue.labels.includes(label),
                onPress: () =>
                  finish(
                    store.setIssueLabels(
                      issue.id,
                      issue.labels.includes(label)
                        ? issue.labels.filter((candidate) => candidate !== label)
                        : [...issue.labels, label],
                    ),
                  ),
              }))
        }
        onClose={closeIf('labels')}
      />

      <ActionSheet
        visible={sheet?.kind === 'defer'}
        title="Snooze / defer"
        actions={[
          {
            label: 'For 1 hour',
            onPress: () => finish(store.deferIssue(issue.id, snoozeUntil1h(Date.now()))),
          },
          {
            label: 'Until tomorrow',
            onPress: () => finish(store.deferIssue(issue.id, workDeferDateFromNow(Date.now(), 1))),
          },
          {
            label: 'For a week',
            onPress: () => finish(store.deferIssue(issue.id, workDeferDateFromNow(Date.now(), 7))),
          },
          {
            label: 'Until next message',
            onPress: () => finish(store.deferIssue(issue.id, DEFER_NEXT_MESSAGE)),
          },
          ...(issue.deferUntil != null
            ? [{ label: 'Unsnooze', onPress: () => finish(store.undeferIssue(issue.id)) }]
            : []),
        ]}
        onClose={closeIf('defer')}
      />

      <ActionSheet
        visible={sheet?.kind === 'confirm-archive'}
        title="Archive this task?"
        subtitle={`${describeCascade(archiveTaskCount, sessionCount)} They leave active views, and any running agents are stopped. Unarchiving brings the task back but does not restart them.`}
        actions={[
          {
            label: 'Archive',
            onPress: () => finish(store.updateIssue(issue.id, { archived: true })),
          },
        ]}
        onClose={closeIf('confirm-archive')}
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
      case 'open':
        return { label: 'Open', onPress: () => finishAnd(() => onOpen(issue)) }
      case 'peek':
        return {
          label: 'Peek',
          hint: 'The task inspector, without leaving Work',
          onPress: () => finishAnd(() => onPeek(issue)),
        }
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
      case 'priority':
        return { label: 'Set priority', onPress: () => setSheet({ kind: 'priority' }) }
      case 'agent':
        return {
          label: startable ? 'Run now' : 'Assign agent',
          onPress: () => setSheet({ kind: 'agent' }),
        }
      case 'labels':
        return { label: 'Labels', onPress: () => setSheet({ kind: 'labels' }) }
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
      case 'defer':
        return { label: 'Snooze / defer', onPress: () => setSheet({ kind: 'defer' }) }
      case 'pin':
        return {
          label: issue.pinned ? 'Unpin' : 'Pin',
          onPress: () => finish(store.updateIssue(issue.id, { pinned: !issue.pinned })),
        }
      case 'moveTop':
        return { label: 'Move to top', onPress: () => finishAnd(() => onMove(issue, 'top')) }
      case 'moveUp':
        return { label: 'Move up', onPress: () => finishAnd(() => onMove(issue, 'up')) }
      case 'moveDown':
        return { label: 'Move down', onPress: () => finishAnd(() => onMove(issue, 'down')) }
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
      case 'archive':
        return { label: 'Archive…', onPress: archive }
      case 'delete':
        return {
          label: 'Delete…',
          destructive: true,
          onPress: () => setSheet({ kind: 'confirm-delete' }),
        }
    }
  }

  function finishAnd(action: () => void): void {
    finish()
    action()
  }

  function agentActions(): SheetAction[] {
    const defaultKind = issueAgentKind(issue.defaultAgent) ?? 'claude-code'
    const kinds = [defaultKind, ...ISSUE_AGENT_KINDS.filter((kind) => kind !== defaultKind)]
    return kinds.map((kind, index) => ({
      label: `${ISSUE_AGENT_LABELS[kind]}${index === 0 ? ' (default)' : ''}`,
      onPress: () => {
        const input = index === 0 ? { id: issue.id } : { id: issue.id, agentKind: kind }
        finish(spawnIssueAgent(store.trpc.issues, input))
      },
    }))
  }
}

function describeCascade(taskCount: number, sessionCount: number): string {
  const tasks = `${taskCount} task${taskCount === 1 ? '' : 's'}`
  if (sessionCount === 0) return `This affects ${tasks}.`
  return `This affects ${tasks} and ${sessionCount} agent${sessionCount === 1 ? '' : 's'}.`
}
