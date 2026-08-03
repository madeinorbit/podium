import { DEFER_NEXT_MESSAGE, snoozeUntil1h } from '@podium/model'
import type { Trpc } from '@/app/trpc'
import { deferDateFromNow, toggleLabelAcross } from './issue-context-menu'
import type { IssueMenuConfig, IssueMenuData } from './issue-menu-config'
import { stageValue } from './issue-menu-config'

export interface IssueMenuCommandDeps {
  trpc: Trpc
  markIssueRead: (id: string) => Promise<unknown>
  markIssueUnread: (id: string) => Promise<unknown>
  setOpenIssueId: (id: string) => void
  setView: (view: 'issues') => void
  handoff?: (machineId: string) => void
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
      case 'rename':
        return
      case 'markUnread':
        return deps.markIssueUnread(id)
      case 'markRead':
        return deps.markIssueRead(id)
      case 'closeDone':
        return deps.trpc.issues.close.mutate({ id, reason: 'done' })
      case 'closeWontfix':
        return deps.trpc.issues.close.mutate({ id, reason: 'wontfix' })
      case 'pin':
        return deps.trpc.issues.update.mutate({ id, patch: { pinned: !data.first.pinned } })
      case 'archive':
        return deps.trpc.issues.update.mutate({
          id,
          patch: { archived: !data.first.archived },
        })
      case 'restore':
        return deps.trpc.issues.restore.mutate({ id })
      case 'delete': {
        const count = data.issues.length
        const sessions = new Set(data.issues.flatMap((issue) => issue.memberSessionIds ?? []))
        const message = `Delete ${count} task${count > 1 ? 's' : ''} and ${sessions.size} session${sessions.size === 1 ? '' : 's'}? Tasks and sessions can be restored; running processes will be stopped.`
        const confirm = deps.confirm ?? ((text: string) => window.confirm(text))
        if (!confirm(message)) return
        return Promise.all(
          data.issues.map((issue) => deps.trpc.issues.delete.mutate({ id: issue.id })),
        )
      }
    }
  }

  if (value === undefined) return
  switch (entry.id) {
    case 'stage': {
      const stage = stageValue(value)
      if (stage) {
        return Promise.all(
          data.issues.map((issue) =>
            deps.trpc.issues.update.mutate({ id: issue.id, patch: { stage } }),
          ),
        )
      }
      return
    }
    case 'priority': {
      const priority = Number(value)
      if (!Number.isInteger(priority) || priority < 0 || priority > 4) return
      return Promise.all(
        data.issues.map((issue) =>
          deps.trpc.issues.update.mutate({ id: issue.id, patch: { priority } }),
        ),
      )
    }
    case 'agent':
      return data.first.worktreePath
        ? deps.trpc.issues.addSession.mutate(value ? { id, agentKind: value } : { id })
        : deps.trpc.issues.start.mutate(value ? { id, agentKind: value } : { id })
    case 'labels':
      return Promise.all(
        toggleLabelAcross(data.issues, value).map((patch) =>
          deps.trpc.issues.setLabels.mutate(patch),
        ),
      )
    case 'handoff':
      deps.handoff?.(value)
      return
    case 'defer':
      if (value === 'hour')
        return deps.trpc.issues.defer.mutate({ id, until: snoozeUntil1h(Date.now()) })
      if (value === 'tomorrow') {
        return deps.trpc.issues.defer.mutate({ id, until: deferDateFromNow(Date.now(), 1) })
      }
      if (value === 'week') {
        return deps.trpc.issues.defer.mutate({ id, until: deferDateFromNow(Date.now(), 7) })
      }
      if (value === 'next-message') {
        return deps.trpc.issues.defer.mutate({ id, until: DEFER_NEXT_MESSAGE })
      }
      if (value === 'undefer') return deps.trpc.issues.undefer.mutate({ id })
      return
    case 'duplicate':
      return deps.trpc.issues.duplicate.mutate({ id, canonicalId: value })
  }
}
