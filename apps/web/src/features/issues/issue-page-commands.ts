/**
 * Named commands for the issue page (P5d, issue #264): every tRPC call site the
 * page fires lives here as a verb over the store surface — `trpc` plus the
 * page's toast-wrapping mutation runner — so `IssuePage.tsx` and
 * `issue-page-properties.tsx` stay composition + JSX. No behavior change vs the
 * inline closures these replace: each command wraps the exact same mutation,
 * and callbacks (`onPosted`, `onDeleted`, `onDeferred`) run inside the runner
 * right where the old inline `await` continuations did.
 *
 * Read-side loaders (`loadIssueComments`, `loadIssueEventsPage`,
 * `loadMergeStyle`) live here too so the model hook has no raw call sites.
 */
import type { IssueStage, IssueWire } from '@podium/protocol'
import type { Trpc } from '@/app/trpc'
import type { IssueAgentKind } from '@/lib/issue-agents'
import type { ActivityComment, IssueEvent } from './issue-events'
import type { RelationEntry } from './issue-relations'

/** The page's mutation runner: busy-gates and surfaces thrown errors verbatim
 *  as the inline toast (owned by `useIssuePageModel`). */
export type RunMutation = (fn: () => Promise<unknown>) => Promise<void>

export type MergeStyle = 'ff-only' | 'pr' | 'ask'
export type GitActionKind = 'rebase' | 'pr' | 'merge'

export interface IssuePageDeps {
  trpc: Trpc
  issue: IssueWire
  run: RunMutation
}

export type IssuePageCommands = ReturnType<typeof issuePageCommands>

/** Build the page's command set for the currently open issue. Rebuilt per
 *  render (like the closures it replaces) so every command sees the live row. */
export function issuePageCommands({ trpc, issue, run }: IssuePageDeps) {
  const id = issue.id

  /** Generic field patch — the single `issues.update` call site. */
  const update = (patch: Record<string, unknown>): void => {
    void run(() => trpc.issues.update.mutate({ id, patch }))
  }

  return {
    update,

    // ---- banners ----
    applySuggestion: (): void => {
      void run(() => trpc.issues.applySuggestion.mutate({ id }))
    },
    dismissSuggestion: (): void => {
      void run(() => trpc.issues.dismissSuggestion.mutate({ id }))
    },
    resolveNeedsHuman: (): void => {
      void run(() => trpc.issues.clearNeedsHuman.mutate({ id }))
    },

    // ---- title / description (inline editors) ----
    commitTitle: (value: string): void => {
      const title = value.trim()
      if (!title || title === issue.title) return
      update({ title })
    },
    commitDescription: (value: string): void => {
      if (value === issue.description) return
      update({ description: value })
    },
    /** Long-form spec fields agents write via `podium issue update` — same
     *  inline-editor pattern as the description. */
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

    // ---- sub-issues ----
    createSubIssue: (title: string): void => {
      void run(() =>
        trpc.issues.create.mutate({
          repoPath: issue.repoPath,
          title,
          parentId: id,
          startNow: false,
        }),
      )
    },

    // ---- activity ----
    /** Post a comment; `onPosted` runs after the mutation resolves (the page
     *  appends the local optimistic copy + clears the composer there). */
    postComment: (body: string, onPosted: (body: string) => void): void => {
      void run(async () => {
        await trpc.issues.addComment.mutate({ id, author: 'me', body })
        onPosted(body)
      })
    },
    refreshAssistant: (): void => {
      void run(() => trpc.issues.refreshAssistant.mutate({ id }))
    },

    // ---- overflow menu ----
    flagForHuman: (question: string | undefined): void => {
      void run(() => trpc.issues.setNeedsHuman.mutate({ id, question }))
    },
    togglePinned: (): void => {
      update({ pinned: !issue.pinned })
    },
    toggleArchived: (): void => {
      update({ archived: !issue.archived })
    },
    deleteIssue: (onDeleted: () => void): void => {
      void run(async () => {
        await trpc.issues.delete.mutate({ id })
        onDeleted()
      })
    },
    restoreIssue: (onRestored: () => void): void => {
      void run(async () => {
        await trpc.issues.restore.mutate({ id })
        onRestored()
      })
    },
    supersedeWith: (newId: string): void => {
      void run(() => trpc.issues.supersede.mutate({ oldId: id, newId }))
    },
    duplicateOf: (canonicalId: string): void => {
      void run(() => trpc.issues.duplicate.mutate({ id, canonicalId }))
    },

    // ---- properties ----
    /** Status menu value: `stage:<stage>` patches the stage; `close:<reason>`
     *  closes. (Reopen is intentionally not offered — see the status options.) */
    selectStatus: (value: string): void => {
      if (value.startsWith('stage:')) update({ stage: value.slice('stage:'.length) as IssueStage })
      else if (value === 'close:done')
        void run(() => trpc.issues.close.mutate({ id, reason: 'done' }))
      else if (value === 'close:wontfix')
        void run(() => trpc.issues.close.mutate({ id, reason: 'wontfix' }))
    },
    addLabel: (label: string): void => {
      const next = label.trim()
      if (!next || issue.labels.includes(next)) return
      void run(() => trpc.issues.setLabels.mutate({ id, labels: [...issue.labels, next] }))
    },
    removeLabel: (label: string): void => {
      void run(() =>
        trpc.issues.setLabels.mutate({ id, labels: issue.labels.filter((l) => l !== label) }),
      )
    },
    /** Date-input value (yyyy-mm-dd) → local-midnight ISO; '' clears. */
    setDueDate: (value: string): void => {
      update({ dueAt: value ? new Date(`${value}T00:00:00`).toISOString() : '' })
    },
    defer: (until: string, onDeferred: () => void): void => {
      void run(async () => {
        await trpc.issues.defer.mutate({ id, until })
        onDeferred()
      })
    },
    undefer: (): void => {
      void run(() => trpc.issues.undefer.mutate({ id }))
    },
    setParent: (parentId: string | null): void => {
      void run(() => trpc.issues.reparent.mutate({ id, parentId }))
    },
    setMachine: (machineId: string | null): void => {
      update({ machineId })
    },
    /** Effort is per-model — changing the model resets effort to auto. */
    setDefaultModel: (defaultModel: string): void => {
      update({ defaultModel, defaultEffort: 'auto' })
    },
    setDefaultEffort: (defaultEffort: string): void => {
      update({ defaultEffort })
    },

    // ---- relations ----
    addRelation: (type: string, toId: string): void => {
      void run(() => trpc.issues.depAdd.mutate({ fromId: id, toId, type }))
    },
    removeRelation: (entry: RelationEntry): void => {
      void run(() =>
        trpc.issues.depRemove.mutate(
          entry.direction === 'dep'
            ? { fromId: id, toId: entry.id, type: entry.type }
            : { fromId: entry.id, toId: id, type: entry.type },
        ),
      )
    },

    // ---- sessions / agent start ----
    startWork: (agentKind?: IssueAgentKind): void => {
      void run(() => trpc.issues.start.mutate(agentKind ? { id, agentKind } : { id }))
    },
    addSession: (agentKind?: IssueAgentKind): void => {
      void run(() => trpc.issues.addSession.mutate(agentKind ? { id, agentKind } : { id }))
    },
    addShell: (): void => {
      void run(() => trpc.issues.addShell.mutate({ id }))
    },

    // ---- git workflow ----
    gitAction: (kind: GitActionKind): Promise<void> =>
      run(async () => {
        await trpc.issues.action.mutate({ id, kind })
      }),
  }
}

// ---------------------------------------------------------------------------
// Read-side loaders (used by useIssuePageModel / useMergeStyle).
// ---------------------------------------------------------------------------

/** The lazy comment thread (#175: bodies no longer ride IssueWire). */
export const loadIssueComments = (trpc: Trpc, id: string): Promise<ActivityComment[]> =>
  trpc.issues.comments.query({ id })

/** One ascending, cursor-paged slice of the repo-scoped issue event log. */
export const loadIssueEventsPage = (
  trpc: Trpc,
  args: { since: number; repoPath: string; limit: number },
): Promise<IssueEvent[]> => trpc.issues.events.query(args) as Promise<IssueEvent[]>

/** The configured git merge style (drives which git action is primary). */
export const loadMergeStyle = async (trpc: Trpc): Promise<MergeStyle> =>
  (await trpc.settings.get.query()).gitWorkflow.mergeStyle

/** A row of an issue's agent mailbox (issue #103). `wasUnread` carries the
 *  pre-read status; the server never marks mail read for an operator peek. */
export interface IssueMailMessage {
  id: string
  issueId: string
  fromAuthor: string
  body: string
  createdAt: string
  status: 'unread' | 'read' | 'claimed'
  claimedBy: string | null
  wasUnread: boolean
}

/** The issue's agent mailbox. `mailInbox` is a mutation (recipients consume
 *  unread status on list), but the web client is an operator peek — the server
 *  only marks mail read for the recipient issue's own scope. */
export const loadIssueMail = (trpc: Trpc, id: string): Promise<IssueMailMessage[]> =>
  trpc.issues.mailInbox.mutate({ id }) as Promise<IssueMailMessage[]>
