import type { IssueUpdatePatch } from '@podium/commands'
import {
  asMachineId,
  DEFER_NEXT_MESSAGE,
  isIssueColorSlot,
  issueStatusIntent,
  type MachineId,
  snoozeUntil1h,
} from '@podium/model/browser'
import type { Trpc } from '@/app/trpc'
import { deferDateFromNow, toggleLabelAcross } from './issue-context-menu'
import type { IssueMenuConfig, IssueMenuData } from './issue-menu-config'
import { ISSUE_MENU_COLOR_NONE, statusValue } from './issue-menu-config'

export interface IssueMenuCommandDeps {
  trpc: Trpc
  markIssueRead: (id: string) => Promise<unknown>
  markIssueUnread: (id: string) => Promise<unknown>
  /** Optimistic + outboxed (POD-781) — the store action, not `trpc.issues.update`.
   *  Passed in rather than reached for, like the two mark-read actions above, so
   *  this module stays a pure descriptor runner with no store dependency.
   *
   *  Typed against the CONTRACT's whole patch rather than the one key the archive
   *  toggle sends: the stage, priority and colour entries below are the same
   *  command and now ride this action too. */
  updateIssue: (id: string, patch: IssueUpdatePatch) => Promise<unknown>
  /** Optimistic + outboxed (POD-781): tombstones the issue AND its sessions. */
  deleteIssue: (id: string) => Promise<unknown>
  /** The four curation commands that are NOT `issues.update`, each optimistic +
   *  outboxed (POD-781): the row reaches the Closed fold, the snooze, the
   *  unsnooze and the label change all paint on the press. */
  closeIssue: (id: string, reason?: string) => Promise<unknown>
  deferIssue: (id: string, until: string | null) => Promise<unknown>
  undeferIssue: (id: string) => Promise<unknown>
  setIssueLabels: (id: string, labels: string[]) => Promise<unknown>
  /** Optimistic + outboxed (POD-781): the undo of a delete. A delete still in the
   *  queue collapses against it rather than round-tripping out and back. */
  restoreIssue: (id: string) => Promise<unknown>
  setOpenIssueId: (id: string) => void
  setView: (view: 'issues') => void
  handoff?: (machineId: MachineId) => void
  confirm?: (message: string) => boolean
}

/** Execute one descriptor from the shared tree for the command-palette host. */
export function runIssueMenuCommand(
  data: IssueMenuData,
  entry: IssueMenuConfig,
  value: string | undefined,
  deps: IssueMenuCommandDeps,
): undefined | Promise<unknown> {
  const id = data.first.id
  if (entry.kind === 'action') {
    switch (entry.id) {
      case 'open':
        deps.setOpenIssueId(id)
        deps.setView('issues')
        return
      case 'start':
        return deps.trpc.issues.start.mutate({ id })
      case 'rename':
        return
      case 'markUnread':
        return deps.markIssueUnread(id)
      case 'markRead':
        return deps.markIssueRead(id)
      case 'pin':
        return deps.updateIssue(id, { pinned: !data.first.pinned })
      case 'archive': {
        // THE TOGGLE, not the dismiss (POD-781). `issues.archive` is one-way, so
        // the menu's archive/unarchive pair has always gone through the patch —
        // two commands for one word, and both are outboxed now.
        if (!data.first.archived && data.first.childCount > 0) {
          const confirm = deps.confirm ?? ((text: string) => window.confirm(text))
          if (
            !confirm(
              'Archive this issue and every sub-task beneath it? They will leave active views.',
            )
          ) {
            return
          }
        }
        return deps.updateIssue(id, { archived: !data.first.archived })
      }
      case 'restore':
        return deps.restoreIssue(id)
      case 'delete': {
        const count = data.issues.length
        const sessions = new Set(data.issues.flatMap((issue) => issue.memberSessionIds ?? []))
        const message = `Delete ${count} task${count > 1 ? 's' : ''} and ${sessions.size} session${sessions.size === 1 ? '' : 's'}? Tasks and sessions can be restored; running processes will be stopped.`
        const confirm = deps.confirm ?? ((text: string) => window.confirm(text))
        if (!confirm(message)) return
        return Promise.all(data.issues.map((issue) => deps.deleteIssue(issue.id)))
      }
    }
  }

  if (value === undefined) return
  switch (entry.id) {
    case 'status': {
      // The lane arm bulk-applies across the selection, exactly as "Set stage"
      // did; the close arm is single-issue by construction (the option is
      // disabled unless the selection is one open task).
      const status = statusValue(value)
      if (!status) return
      const intent = issueStatusIntent(status)
      if (!intent) return
      if (intent.kind === 'close') return deps.closeIssue(id, intent.reason)
      return Promise.all(
        data.issues.map((issue) => deps.updateIssue(issue.id, { stage: intent.stage })),
      )
    }
    case 'priority': {
      const priority = Number(value)
      if (!Number.isInteger(priority) || priority < 0 || priority > 4) return
      return Promise.all(data.issues.map((issue) => deps.updateIssue(issue.id, { priority })))
    }
    case 'color': {
      if (value !== ISSUE_MENU_COLOR_NONE && !isIssueColorSlot(value)) return
      const color = value === ISSUE_MENU_COLOR_NONE ? null : value
      return Promise.all(data.issues.map((issue) => deps.updateIssue(issue.id, { color })))
    }
    case 'agent':
      return data.first.worktreePath
        ? deps.trpc.issues.addSession.mutate(value ? { id, agentKind: value } : { id })
        : deps.trpc.issues.start.mutate(value ? { id, agentKind: value } : { id })
    case 'labels':
      return Promise.all(
        toggleLabelAcross(data.issues, value).map((patch) =>
          deps.setIssueLabels(patch.id, patch.labels),
        ),
      )
    case 'handoff':
      deps.handoff?.(asMachineId(value))
      return
    case 'defer':
      if (value === 'hour') return deps.deferIssue(id, snoozeUntil1h(Date.now()))
      if (value === 'tomorrow') return deps.deferIssue(id, deferDateFromNow(Date.now(), 1))
      if (value === 'week') return deps.deferIssue(id, deferDateFromNow(Date.now(), 7))
      if (value === 'next-message') return deps.deferIssue(id, DEFER_NEXT_MESSAGE)
      if (value === 'undefer') return deps.undeferIssue(id)
      return
    case 'duplicate':
      return deps.trpc.issues.duplicate.mutate({ id, canonicalId: value })
  }
}
