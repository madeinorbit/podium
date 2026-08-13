import type { ActivityComment, IssueEvent } from '@podium/client-core/viewmodels'
import type { IssueUpdatePatch } from '@podium/commands'
import type { IssueId, IssueWire } from '@podium/model'
import type { MobileTrpc } from '../client/trpc'

/**
 * THE TASK PAGE'S CALL SURFACE [POD-724] — the phone half of the desktop's
 * `issue-page-commands.ts`.
 *
 * Every mutation the task page fires is a named verb here, so the screen and its
 * sections stay composition. Curation writes use the store's optimistic engine
 * actions; server-only commands retain the narrow tRPC seam. Same split, same reason: an inline
 * `trpc.issues.something.mutate` in a component is a call site nobody can audit
 * for what identity it carries, and the desktop's payload-identity test exists
 * precisely because of that. Nothing below sends an actor, an owner or an origin;
 * the server stamps those from the authenticated transport.
 *
 * -------------------------------------------------------------------------
 * WHY THE CLIENT IS RE-TYPED HERE RATHER THAN IN `client/trpc.ts`.
 * -------------------------------------------------------------------------
 *
 * `MobileTrpc` is deliberately NARROW: it is `PodiumClientApi` plus the handful
 * of hand-written extras Metro can afford, because importing the server's
 * `AppRouter` would pull the whole server into the phone's module graph. The
 * transport under it is `createTRPCClient<any>`, so every procedure the server
 * serves is reachable at runtime — what is missing is only the TYPE.
 *
 * So this module declares the task page's own slice of that surface and narrows
 * the client to it once, in one place, rather than casting at fifteen call
 * sites. The declarations below were read off `apps/server/src/modules/issues/
 * registry.ts`; if one drifts, the failure is a rejected promise that the page's
 * toast renders verbatim, not a silent no-op — every command runs through
 * {@link RunMutation}, and the read-side loaders are best-effort by design.
 */

/** A row of an issue's agent mailbox (issue #103). `wasUnread` carries the
 *  pre-read status; the server never marks mail read for an operator peek. */
export interface IssueMailMessage {
  id: string
  issueId: IssueId
  fromAuthor: string
  body: string
  createdAt: string
  status: 'unread' | 'read' | 'claimed'
  claimedBy: string | null
  wasUnread: boolean
}

interface Query<I, O> {
  query(input: I): Promise<O>
}
interface Mutate<I, O = unknown> {
  mutate(input: I): Promise<O>
}

/** The issue procedures this page uses that `MobileTrpc` does not name. */
interface IssueDetailProcs {
  issues: {
    comments: Query<{ id: string }, ActivityComment[]>
    events: Query<
      { since: number; repoPath?: string; subject?: string; limit?: number },
      IssueEvent[]
    >
    mailInbox: Mutate<{ id: string }, IssueMailMessage[]>
    create: Mutate<
      { repoPath: string; title: string; parentId?: string; startNow: boolean },
      IssueWire
    >
    supersede: Mutate<{ oldId: string; newId: string }>
    duplicate: Mutate<{ id: string; canonicalId: string }>
    reparent: Mutate<{ id: string; parentId: string | null }>
    depAdd: Mutate<{ fromId: string; toId: string; type: string }>
    depRemove: Mutate<{ fromId: string; toId: string; type: string }>
    setNeedsHuman: Mutate<{ id: string; question?: string }>
    applySuggestion: Mutate<{ id: string }>
    dismissSuggestion: Mutate<{ id: string }>
    refreshAssistant: Mutate<{ id: string }>
    addSession: Mutate<{ id: string; agentKind?: string }>
    addShell: Mutate<{ id: string }>
    action: Mutate<{ id: string; kind: 'rebase' | 'pr' | 'merge' }>
  }
}

/** Narrow the phone's client to the task page's slice — see the module note. */
export function issueProcs(trpc: MobileTrpc): IssueDetailProcs {
  return trpc as unknown as IssueDetailProcs
}

/** The page's mutation runner: busy-gates and surfaces thrown errors verbatim. */
export type RunMutation = (fn: () => Promise<unknown>) => Promise<void>

export type IssueCommands = ReturnType<typeof issueCommands>

export interface IssueWriteActions {
  updateIssue: (id: string, patch: IssueUpdatePatch) => Promise<unknown>
  deleteIssue: (id: string) => Promise<unknown>
  closeIssue: (id: string, reason?: string) => Promise<unknown>
  deferIssue: (id: string, until: string | null) => Promise<unknown>
  undeferIssue: (id: string) => Promise<unknown>
  setIssueLabels: (id: string, labels: string[]) => Promise<unknown>
  restoreIssue: (id: string) => Promise<unknown>
}

/** Build the page's command set for the currently open task. Rebuilt per render
 *  (like the closures it replaces) so every command sees the live row. */
export function issueCommands({
  trpc,
  issue,
  run,
  actions,
}: {
  trpc: MobileTrpc
  issue: IssueWire
  run: RunMutation
  actions: IssueWriteActions
}) {
  const id = issue.id
  const api = issueProcs(trpc).issues

  /** Generic field patch — the single `issues.update` call site. Keep the
   *  page's existing clear-value surface intact at this transport seam. */
  const update = (patch: Record<string, unknown>): void => {
    void run(() => actions.updateIssue(id, patch as IssueUpdatePatch))
  }

  return {
    update,

    // ---- banners ----
    applySuggestion: (): void => {
      void run(() => api.applySuggestion.mutate({ id }))
    },
    dismissSuggestion: (): void => {
      void run(() => api.dismissSuggestion.mutate({ id }))
    },
    resolveNeedsHuman: (): void => {
      void run(() => trpc.issues.clearNeedsHuman.mutate({ id }))
    },
    restoreIssue: (onRestored: () => void): void => {
      void run(async () => {
        await actions.restoreIssue(id)
        onRestored()
      })
    },

    // ---- the issue's own text ----
    commitTitle: (value: string): void => {
      const title = value.trim()
      if (!title || title === issue.title) return
      update({ title })
    },
    commitDescription: (value: string): void => {
      if (value === issue.description) return
      update({ description: value })
    },
    /** Long-form spec fields agents write via `podium issue update`. */
    commitLongForm: (field: 'design' | 'acceptance' | 'notes', value: string): void => {
      if (value === (issue[field] ?? '')) return
      update({ [field]: value })
    },

    // ---- agent panel (todos ride issues.panel; 1-based index API) ----
    toggleTodo: (index1: number, done: boolean): void => {
      void run(() =>
        trpc.issues.panelApply.mutate({
          id,
          op: done ? 'todo-done' : 'todo-undone',
          index: index1,
        }),
      )
    },

    // ---- sub-tasks ----
    createSubIssue: (title: string): void => {
      void run(() =>
        api.create.mutate({ repoPath: issue.repoPath, title, parentId: id, startNow: false }),
      )
    },

    // ---- activity ----
    postComment: (body: string, onPosted: (body: string) => void): void => {
      void run(async () => {
        await trpc.issues.addComment.mutate({ id, author: 'me', body })
        onPosted(body)
      })
    },
    refreshAssistant: (): void => {
      void run(() => api.refreshAssistant.mutate({ id }))
    },

    // ---- properties ----
    /** Status menu value: `stage:<stage>` patches the stage; `close:<reason>`
     *  closes. Mirrors the desktop verb exactly, including that reopen is not
     *  offered from the close arm. */
    selectStatus: (value: string): void => {
      if (value.startsWith('stage:')) update({ stage: value.slice('stage:'.length) })
      else if (value === 'close:done') void run(() => actions.closeIssue(id, 'done'))
      else if (value === 'close:wontfix') void run(() => actions.closeIssue(id, 'wontfix'))
    },
    addLabel: (label: string): void => {
      const next = label.trim()
      if (!next || issue.labels.includes(next)) return
      void run(() => actions.setIssueLabels(id, [...issue.labels, next]))
    },
    removeLabel: (label: string): void => {
      void run(() =>
        actions.setIssueLabels(
          id,
          issue.labels.filter((l) => l !== label),
        ),
      )
    },
    setParent: (parentId: string | null): void => {
      void run(() => api.reparent.mutate({ id, parentId }))
    },
    defer: (until: string): void => {
      void run(() => actions.deferIssue(id, until))
    },
    undefer: (): void => {
      void run(() => actions.undeferIssue(id))
    },

    // ---- relations ----
    addRelation: (type: string, toId: string): void => {
      void run(() => api.depAdd.mutate({ fromId: id, toId, type }))
    },
    removeRelation: (entry: { id: string; type: string; direction: 'dep' | 'dependent' }): void => {
      void run(() =>
        api.depRemove.mutate(
          entry.direction === 'dep'
            ? { fromId: id, toId: entry.id, type: entry.type }
            : { fromId: entry.id, toId: id, type: entry.type },
        ),
      )
    },

    // ---- overflow menu ----
    flagForHuman: (question: string | undefined): void => {
      void run(() => api.setNeedsHuman.mutate(question ? { id, question } : { id }))
    },
    togglePinned: (): void => {
      update({ pinned: !issue.pinned })
    },
    toggleArchived: (): void => {
      update({ archived: !issue.archived })
    },
    deleteIssue: (onDeleted: () => void): void => {
      void run(async () => {
        await actions.deleteIssue(id)
        onDeleted()
      })
    },
    supersedeWith: (newId: string): void => {
      void run(() => api.supersede.mutate({ oldId: id, newId }))
    },
    duplicateOf: (canonicalId: string): void => {
      void run(() => api.duplicate.mutate({ id, canonicalId }))
    },

    // ---- sessions / agent start ----
    startWork: (): void => {
      void run(() => trpc.issues.start.mutate({ id }))
    },
    addSession: (): void => {
      void run(() => api.addSession.mutate({ id }))
    },
    addShell: (): void => {
      void run(() => api.addShell.mutate({ id }))
    },

    // ---- git workflow ----
    gitAction: (kind: 'rebase' | 'pr' | 'merge'): void => {
      void run(() => api.action.mutate({ id, kind }))
    },
  }
}

// ---------------------------------------------------------------------------
// Read-side loaders. All three are BEST-EFFORT at the call site: a server that
// does not serve one of them leaves the section it feeds empty rather than
// failing the page, which is the same posture the desktop model takes.
// ---------------------------------------------------------------------------

/** The lazy comment thread (#175: bodies no longer ride the wire). */
export const loadIssueComments = (trpc: MobileTrpc, id: string): Promise<ActivityComment[]> =>
  issueProcs(trpc).issues.comments.query({ id })

/** Stop paging when the cursor does not advance, or after this many pages.
 *  A stuck `since` (same 200 rows forever) used to recurse without bound. */
export const ISSUE_EVENTS_MAX_PAGES = 20

export function shouldContinueEventDrain(args: {
  pageLength: number
  pageSize: number
  sinceBefore: number
  sinceAfter: number
  pages: number
  maxPages?: number
}): boolean {
  if (args.pageLength < args.pageSize) return false
  if (args.sinceAfter <= args.sinceBefore) return false
  if (args.pages >= (args.maxPages ?? ISSUE_EVENTS_MAX_PAGES)) return false
  return true
}

/** One ascending, cursor-paged slice of the issue event log, narrowed to a
 *  single issue's subject SERVER-side (POD-532) so a page holds only rows this
 *  feed will render. */
export const loadIssueEventsPage = (
  trpc: MobileTrpc,
  args: { since: number; repoPath: string; subject: string; limit: number },
): Promise<IssueEvent[]> => issueProcs(trpc).issues.events.query(args)

/** The issue's agent mailbox. `mailInbox` is a mutation (recipients consume
 *  unread status on list), but this is an operator peek — the server only marks
 *  mail read for the recipient issue's own scope. */
export const loadIssueMail = (trpc: MobileTrpc, id: string): Promise<IssueMailMessage[]> =>
  issueProcs(trpc).issues.mailInbox.mutate({ id })
