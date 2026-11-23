import { fieldConflict } from '@podium/commands/records'
import type { SessionId } from '@podium/model'
import { asIssueId, UNSNOOZE_BACKDATE_MS } from '@podium/model'
import type { PodiumClientApi } from '../api'
import { type RecordPatch, recordKinds, UNSET } from '../records'
import { resolvedWorkspaceKey } from '../ui/state'
import { workspaceKeyFor } from '../values'
import type { CommandDeps } from './context'
import { reportCommandFailure } from './failures'
import type { IssuesCommands } from './issues-types'
import type { CommandWrites } from './writes'

/** An `issues.update` patch split by home (POD-6405): the plain fields an issue
 *  record edit carries, and the keys that keep their command. */
function splitIssuePatch(patch: Record<string, unknown>): {
  plain: Record<string, unknown>
  rest: Record<string, unknown>
} {
  const plain: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (ISSUE_PLAIN_FIELDS.has(key)) plain[key] = value
    else rest[key] = value
  }
  return { plain, rest }
}

/** Read on first use: the record table is not ready while modules load. */
let issuePlainFields: ReadonlySet<string> | undefined
const ISSUE_PLAIN_FIELDS = {
  has: (name: string): boolean => {
    issuePlainFields ??= new Set(
      Object.keys(recordKinds().issueProjection.fields).filter(
        (field) => fieldConflict(recordKinds().issueProjection, field) === 'field-LWW',
      ),
    )
    return issuePlainFields.has(name)
  },
}

export function createIssuesCommands<TApi extends PodiumClientApi>(
  rt: CommandDeps<TApi>,
  shared: CommandWrites,
): IssuesCommands<TApi> {
  const { editRecord, myIssueState, markRead, pendingReads } = shared

  const commands: IssuesCommands<TApi> = {
    // The curation writes (POD-781). Nothing here but the enqueue: the queued
    // entry IS the optimistic apply (#263), so there is no local mirror to keep
    // and no rollback to write — the overlay retires itself on covering truth or
    // drops on a definitive refusal, and the poison toast is the failure surface.
    // The plain fields are a generic edit, last writer wins per field
    // (POD-6405); stage, close, the parent link, the agent and the order keep
    // `issues.update`, whose rules they carry. Both ride the issue's partition,
    // in this order.
    update: async (id, patch) => {
      const { plain, rest } = splitIssuePatch(patch as Record<string, unknown>)
      const writes: Promise<void>[] = []
      if (Object.keys(plain).length > 0) {
        writes.push(
          editRecord({ kind: 'issueProjection', id }, plain as RecordPatch<'issueProjection'>),
        )
      }
      if (Object.keys(rest).length > 0) {
        writes.push(Promise.resolve(rt.write('issueUpdate', { id, patch: rest })))
      }
      await Promise.all(writes)
    },
    archive: async (id) => editRecord({ kind: 'issueProjection', id }, { archived: true }),
    delete: async (id) => rt.write('issueDelete', { id }),
    close: async (id, reason) => rt.write('issueClose', { id, reason }),
    // A cleared `deferUntil` ends a snooze quietly; a past one is an unsnooze,
    // which floats the row back with its "Unsnoozed" tag (issue #133). The
    // server backdates from its own clock; this device paints its own.
    defer: async (id, until) =>
      editRecord({ kind: 'issueProjection', id }, { deferUntil: until ?? UNSET }),
    undefer: async (id) =>
      editRecord(
        { kind: 'issueProjection', id },
        { deferUntil: new Date(Date.now() - UNSNOOZE_BACKDATE_MS).toISOString() },
      ),
    restore: async (id) => rt.write('issueRestore', { id }),
    setLabels: async (id, labels) => editRecord({ kind: 'issueProjection', id }, { labels }),
    setPlacement: async (id, placement, originId) =>
      rt.write('issueSetPlacement', { id, placement, originId }),
    /**
     * TUCKING THE TASK ON SCREEN LEAVES IT (POD-2293).
     *
     * A tucked task folds out of the sidebar, so staying on it would leave the
     * operator looking at finished work that no row points back to. Tucking
     * the selected task's mission root therefore clears the selection right
     * after the tuck is enqueued, and the workspace shows the cold deck.
     *
     * Optimistic, like the fold: the row folds and the operator leaves at once.
     * A refused tuck brings the row back to the sidebar; nothing was closed, so
     * nothing else needs undoing. Workspaces are kept per task, so its tabs,
     * files and sessions are there again on a bring-back.
     *
     * Only the selected task clears. The worktree stays, as every other way back
     * to the composer keeps it: clearing it hands the selection to the worktree
     * fallback, which shows another worktree's tabs. The view is kept too.
     *
     * The operator's own click is the only trigger. A tuck from the phone,
     * another window or the CLI folds the row here but does not move this
     * screen. Tucking a sub-task never moves it either: the strip on screen
     * belongs to the mission, not the sub-task. A selection still loading
     * cannot be matched and stays put.
     */
    setTucked: async (id, tucked) => {
      // The server keeps the first tuck's stamp; the paint is this press's.
      const written = editRecord(myIssueState(id), {
        tuckedAt: tucked ? new Date().toISOString() : null,
      })
      // "The task on screen" is the workspace the selection resolves to, the
      // same key the strip is filed under.
      const shown = tucked ? resolvedWorkspaceKey(rt.ui.screen) : null
      const own =
        shown === workspaceKeyFor({ missionRootId: id }) ||
        shown === workspaceKeyFor({ issueId: asIssueId(id) })
      // The tuck is the newest gesture, so like any click it replaces one still
      // on its way (a pending navigation, session jump or pane link).
      if (own) rt.ui.navigate({ view: rt.router.current().view, selectedIssueId: null })
      return written
    },
    markRead: (id, readAt) => {
      if (readAt === undefined) rt.ui.screen.navigation.readIntent?.('issue', id, true)
      return markRead('issue', id, readAt ? { readAt } : {})
    },
    markUnread: async (id) => {
      pendingReads.delete(`issue:${id}`)
      rt.ui.screen.navigation.readIntent?.('issue', id, false)
      return editRecord(myIssueState(id), { readAt: null })
    },
    // `write`, like its neighbours, since POD-1110. It used to be a
    // bare mutate under `offline: 'direct-only'`, which made "none of these" the
    // one row edit in the app that failed outright on a dropped connection —
    // the offer popped back wearing an error. The queued entry IS the optimistic
    // apply now (#263): it paints the offer away on enqueue, so no caller needs a
    // local hide or a rollback, and the entry replays under the server's
    // `offerCreatedAt` guard, which refuses a dismissal aimed at an offer that
    // has since been replaced.
    dismissOffer: async (sessionId: SessionId, offerCreatedAt: string) =>
      rt.write('dismissOffer', { sessionId, offerCreatedAt }),
  }
  return {
    update: reportCommandFailure(commands.update, shared.reportFailure),
    archive: reportCommandFailure(commands.archive, shared.reportFailure),
    delete: reportCommandFailure(commands.delete, shared.reportFailure),
    close: reportCommandFailure(commands.close, shared.reportFailure),
    defer: reportCommandFailure(commands.defer, shared.reportFailure),
    undefer: reportCommandFailure(commands.undefer, shared.reportFailure),
    restore: reportCommandFailure(commands.restore, shared.reportFailure),
    setLabels: reportCommandFailure(commands.setLabels, shared.reportFailure),
    setPlacement: reportCommandFailure(commands.setPlacement, shared.reportFailure),
    setTucked: reportCommandFailure(commands.setTucked, shared.reportFailure),
    markRead: reportCommandFailure(commands.markRead, shared.reportFailure),
    markUnread: reportCommandFailure(commands.markUnread, shared.reportFailure),
    dismissOffer: reportCommandFailure(commands.dismissOffer, shared.reportFailure),
  }
}
