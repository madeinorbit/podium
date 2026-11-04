/**
 * Named commands for the issue page (P5d, issue #264): every tRPC call site the
 * page fires lives here as a verb over the store surface — server-only `trpc`,
 * optimistic issue-write actions, plus the page's error-reporting mutation
 * runner — so `IssuePage.tsx` and
 * `issue-page-properties.tsx` stay composition + JSX. Curation callbacks
 * (`onDeleted`, `onDeferred`) now follow overlay publication rather than the
 * server round trip; server-only callbacks such as `onPosted` keep their direct
 * mutation ordering.
 *
 * Read-side loaders (`loadIssueComments`, `loadIssueEventsPage`) live here too
 * so the model hook has no raw call sites.
 */

import type { ActivityComment, IssueEvent, RelationEntry } from '@podium/client-core/values'
import type { IssueActivityPorts } from '@podium/client-graph/issue-activity'
import type { IssueUpdatePatch } from '@podium/commands'
import { type IssueId, parseIssueStatusValue, type StoredIssueDepType } from '@podium/model/browser'
import type { IssueViewModel } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import type { IssueAgentKind } from '@/lib/issue-agents'
import { saveIssueText, type TextBase, TextConflict, type TextSaveApi } from './issue-text-save'

/** The page's mutation runner: busy-gates and surfaces thrown errors verbatim
 *  as an error toast (owned by `useIssuePageModel`). */
export type RunMutation = (fn: () => Promise<unknown>) => Promise<void>

export type GitActionKind = 'rebase' | 'pr' | 'merge'

export interface IssuePageDeps {
  trpc: Trpc
  issue: IssueViewModel
  run: RunMutation
  updateIssue: (id: string, patch: IssueUpdatePatch) => Promise<unknown>
  deleteIssue: (id: string) => Promise<unknown>
  closeIssue: (id: string, reason?: string) => Promise<unknown>
  deferIssue: (id: string, until: string | null) => Promise<unknown>
  undeferIssue: (id: string) => Promise<unknown>
  setIssueLabels: (id: string, labels: string[]) => Promise<unknown>
  restoreIssue: (id: string) => Promise<unknown>
}

export type IssuePageCommands = ReturnType<typeof issuePageCommands>

/** Build the page's command set for the currently open issue. Rebuilt per
 *  render (like the closures it replaces) so every command sees the live row. */
export function issuePageCommands({
  trpc,
  issue,
  run,
  updateIssue,
  deleteIssue,
  closeIssue,
  deferIssue,
  undeferIssue,
  setIssueLabels,
  restoreIssue,
}: IssuePageDeps) {
  const id = issue.id

  /** Generic field patch — the single `issues.update` call site. This page's
   *  established clear-value surface is intentionally broader than the
   *  generated patch type; this transport-only swap preserves it at the seam. */
  const update = (patch: Record<string, unknown>): void => {
    void run(() => updateIssue(id, patch as IssueUpdatePatch))
  }

  return {
    update,
    /** The task's parent branch (POD-2153). Resolves once the edit is durably
     *  queued, not when the server settles it: the picker awaits it so a failed
     *  enqueue shows inline, and a later server refusal reaches the user as the
     *  outbox's "Couldn't save issue branch" notice like every other edit. */
    setParentBranch: (parentBranch: string): Promise<unknown> => updateIssue(id, { parentBranch }),

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
    /** Save the description. On a shared instance the editor passes the
     *  `base` it opened on, and the edit names that revision (POD-6295): a
     *  real conflict reaches `onConflict` with the current text, the draft
     *  unsaved. Without a base (one member) the edit queues as before. */
    commitDescription: (
      value: string,
      base?: TextBase,
      onConflict?: (conflict: TextConflict) => void,
    ): void => {
      if (value === issue.description) return
      if (!base) {
        update({ description: value })
        return
      }
      void run(async () => {
        try {
          await saveIssueText(trpc as unknown as TextSaveApi, id, 'description', value, base)
        } catch (err) {
          if (err instanceof TextConflict && onConflict) onConflict(err)
          else throw err
        }
      })
    },
    /** Put a recorded description or brief back (POD-6289); the restore is
     *  itself a new revision. */
    restoreTextRevision: (revisionId: number, onDone: () => void): void => {
      void run(async () => {
        await trpc.issues.restoreTextRevision.mutate({ id, revisionId })
        onDone()
      })
    },
    /** Long-form spec field agents write via `podium issue update` — same
     *  inline-editor pattern as the description. */
    commitLongForm: (field: 'acceptance', value: string): void => {
      if (value === (issue[field] ?? '')) return
      update({ [field]: value })
    },

    // NO `toggleTodo` (POD-1163). The page stopped rendering an agent's own
    // todo list, so the command that checked one off went with it rather than
    // lingering as an unreachable write. `issues.panelApply`'s `todo-done` /
    // `todo-undone` ops are untouched — the CLI and the dock still use them.

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
        await trpc.issues.addComment.mutate({ id, body })
        onPosted(body)
      })
    },
    /** Edit one of the reader's own comments (POD-6289). The control is drawn
     *  only on comments the server marked `mayEdit`. */
    editComment: (commentId: string, body: string, onDone: () => void): void => {
      void run(async () => {
        await trpc.issues.editComment.mutate({ id, commentId, body })
        onDone()
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
        await deleteIssue(id)
        onDeleted()
      })
    },
    restoreIssue: (onRestored: () => void): void => {
      void run(async () => {
        await restoreIssue(id)
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
    /** Status menu value: `stage:<lane>` patches the stage, `close:<reason>`
     *  closes. The encoding and the fork both belong to the model (POD-1074) —
     *  this only routes the two arms at the two different mutations. Legacy
     *  `close:wontfix` still parses, as `cancelled`. */
    selectStatus: (value: string): void => {
      const intent = parseIssueStatusValue(value)
      if (!intent) return
      if (intent.kind === 'stage') update({ stage: intent.stage })
      else void run(() => closeIssue(id, intent.reason))
    },
    addLabel: (label: string): void => {
      const next = label.trim()
      if (!next || issue.labels.includes(next)) return
      void run(() => setIssueLabels(id, [...issue.labels, next]))
    },
    removeLabel: (label: string): void => {
      void run(() =>
        setIssueLabels(
          id,
          issue.labels.filter((l) => l !== label),
        ),
      )
    },
    /** Date-input value (yyyy-mm-dd) → local-midnight ISO; '' clears. */
    setDueDate: (value: string): void => {
      update({ dueAt: value ? new Date(`${value}T00:00:00`).toISOString() : '' })
    },
    defer: (until: string, onDeferred: () => void): void => {
      void run(async () => {
        await deferIssue(id, until)
        onDeferred()
      })
    },
    undefer: (): void => {
      void run(() => undeferIssue(id))
    },
    setParent: (parentId: string | null): void => {
      void run(() => trpc.issues.reparent.mutate({ id, parentId }))
    },
    // ---- relations ----
    addRelation: (type: StoredIssueDepType, toId: string): void => {
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

    // ---- git workflow ----
    gitAction: (kind: GitActionKind): Promise<void> =>
      run(async () => {
        await trpc.issues.action.mutate({ id, kind })
      }),
  }
}

// ---------------------------------------------------------------------------
// Read-side loaders.
// ---------------------------------------------------------------------------

/** One revision of a task's description or brief (POD-6289). */
export interface IssueTextRevision {
  id: number
  field: 'description' | 'brief'
  body: string
  source: 'create' | 'baseline' | 'edit' | 'restore'
  restoredFrom: number | null
  issueRevision: number | null
  actor: string | null
  onBehalfOf: string | null
  createdAt: string
}

/** A task's description or brief history, oldest first. */
export const loadIssueTextRevisions = (
  trpc: Trpc,
  id: string,
  field: 'description' | 'brief',
): Promise<IssueTextRevision[]> =>
  trpc.issues.textRevisions.query({ id, field }) as Promise<IssueTextRevision[]>

/** The lazy comment thread (#175: bodies no longer ride IssueViewModel). */
export const loadIssueComments = (trpc: Trpc, id: string): Promise<ActivityComment[]> =>
  trpc.issues.comments.query({ id })

/** One cursor-paged slice of one issue's event log, narrowed to its subject in
 *  SQL (POD-532): ascending from `since`, or newest first below `before` when
 *  `order` is `desc` (POD-5832). */
export const loadIssueEventsPage = (
  trpc: Trpc,
  args: Parameters<IssueActivityPorts['events']>[0],
): Promise<IssueEvent[]> =>
  trpc.issues.events.query({ ...args, excludeKinds: [...args.excludeKinds] }) as Promise<
    IssueEvent[]
  >

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

/** The issue's agent mailbox. `mailInbox` is a mutation (recipients consume
 *  unread status on list), but the web client is an operator peek — the server
 *  only marks mail read for the recipient issue's own scope. */
export const loadIssueMail = (trpc: Trpc, id: string): Promise<IssueMailMessage[]> =>
  trpc.issues.mailInbox.mutate({ id }) as Promise<IssueMailMessage[]>
