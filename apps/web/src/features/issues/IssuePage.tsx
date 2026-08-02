import type { IssueId } from '@podium/model'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { cn } from '@/lib/utils'
import { IssueCloseDialog, type IssueCloseReason } from './issue-lifecycle'
import { issuePageCommands } from './issue-page-commands'
import { repoMatesOf, useIssuePageModel } from './issue-page-model'
import { IssueActivitySection, MailSection } from './issue-page/IssueActivity'
import { IssueAgentActivity } from './issue-page/IssueAgentActivity'
import { IssueBanners } from './issue-page/IssueBanners'
import {
  IssueBrief,
  IssueDescription,
  IssueTitle,
  LongFormFields,
  StatusStrip,
} from './issue-page/IssueBody'
import { IssueDetailHeader } from './issue-page/IssueDetailHeader'
import { IssueProperties } from './issue-page/IssueProperties'
import { IssueSubIssues } from './issue-page/IssueSubIssues'
import { useEvictionGuard } from './issue-page/use-eviction-guard'

/**
 * The full issue page — an in-view (not overlay) replacement for the detail
 * drawer. A header with breadcrumb + prev/next + overflow menu, a scrolling main
 * column (banners → inline-editable title → status strip → description →
 * long-form spec fields → agent activity → sub-issues → mail → activity feed),
 * and a desktop-only properties aside. The `issue` prop is the live store row, so
 * it re-renders as `issuesChanged` broadcasts land. Navigation re-points
 * `openIssueId` via `onNavigate`; `onBack` clears it.
 *
 * -------------------------------------------------------------------------
 * THIS FILE IS COMPOSITION AND PAGE-LEVEL STATE. NOTHING ELSE.
 * -------------------------------------------------------------------------
 *
 * The P5d split (POD-264) moved "what to show" into `useIssuePageModel` and every
 * mutation into a named command. POD-646 finished the job: each SECTION is now
 * its own module under `./issue-page/`, chosen by the question it answers rather
 * than by size —
 *
 *   IssueDetailHeader   breadcrumb, navigation, and the overflow menu, which is
 *                       a renderer over the declarative config in
 *                       `./issue-page/issue-page-menu.ts` and holds no
 *                       eligibility rules of its own.
 *   IssueBanners        deleted / superseded / suggestion / needs-human.
 *   IssueBody           title, status strip, description, brief, long-form.
 *   IssueAgentActivity  the agent-published panel + its attribution pair.
 *   IssueSubIssues      the child list, over the issues slice's `subIssuesOf`.
 *   IssueActivity       mail, the comment/event feed, the composer.
 *   IssueProperties     the aside, itself split by question (parent / relations
 *                       / sessions / git / about).
 *
 * What is LEFT here is the state that genuinely spans sections: the transient
 * compose/edit flags, the close-reason dialog, the Escape-to-board key handler,
 * and the eviction guard below. Pushing any of those down would duplicate them.
 */
export function IssuePage({
  issue,
  orderedIds,
  onBack,
  onNavigate,
}: {
  issue: IssueViewModel
  orderedIds: IssueId[]
  onBack: () => void
  onNavigate: (id: IssueId) => void
}): JSX.Element {
  const model = useIssuePageModel(issue, orderedIds)
  const { busy, toast, run, prev, next, repoName, feed, mail, children, issues } = model
  const commands = issuePageCommands({ trpc: model.trpc, issue, run })

  // If this issue is unshared while open (POD-1077 evict), leave — once, and
  // with no deletion affordance of any kind. See ./issue-page/use-eviction-guard.ts.
  useEvictionGuard(issue, onBack)

  const [commentBody, setCommentBody] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [addingChild, setAddingChild] = useState(false)
  const [childTitle, setChildTitle] = useState('')
  const [closeReason, setCloseReason] = useState<IssueCloseReason | null>(null)

  // Reset transient compose/edit state on issue switch so a half-typed comment or
  // an open editor never carries across to the next issue.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setCommentBody('')
    setEditingTitle(false)
    setEditingDesc(false)
    setAddingChild(false)
    setChildTitle('')
  }, [issue.id])

  // Post the composed comment, appending it optimistically so it shows without
  // waiting for the broadcast round-trip (the updatedAt-keyed refetch then
  // replaces the local copy with server truth).
  const postComment = (): void => {
    const body = commentBody.trim()
    if (!body) return
    commands.postComment(body, (posted) => {
      model.appendLocalComment(posted)
      setCommentBody('')
    })
  }

  // Escape returns to the board — but not while an editor/menu is open (Esc there
  // cancels the local edit), nor while a form field is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const el = document.activeElement as HTMLElement | null
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      )
        return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const commitTitle = (value: string): void => {
    setEditingTitle(false)
    commands.commitTitle(value)
  }

  const commitDescription = (value: string): void => {
    setEditingDesc(false)
    commands.commitDescription(value)
  }

  const createChild = (title: string): void => {
    commands.createSubIssue(title)
    setChildTitle('')
  }

  const targets = repoMatesOf(issues, issue)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="issue-page">
      <IssueDetailHeader
        issue={issue}
        repoName={repoName}
        busy={busy}
        commands={commands}
        targets={targets}
        prev={prev}
        next={next}
        onBack={onBack}
        onNavigate={onNavigate}
      />

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-5 md:px-8">
            <IssueBanners
              issue={issue}
              busy={busy}
              commands={commands}
              onBack={onBack}
              onNavigate={onNavigate}
            />

            <IssueTitle
              issue={issue}
              busy={busy}
              editing={editingTitle}
              onEditingChange={setEditingTitle}
              onCommit={commitTitle}
            />

            <StatusStrip issue={issue} />

            <IssueDescription
              issue={issue}
              busy={busy}
              editing={editingDesc}
              onEditingChange={setEditingDesc}
              onCommit={commitDescription}
            />

            <IssueBrief issue={issue} />

            {/* Long-form spec fields agents write via `podium issue update`. */}
            <LongFormFields issue={issue} busy={busy} commands={commands} />

            {/* The agent-published panel: todos / artifacts / deferred. */}
            <IssueAgentActivity issue={issue} busy={busy} commands={commands} />

            <IssueSubIssues
              issue={issue}
              children={children}
              busy={busy}
              addingChild={addingChild}
              childTitle={childTitle}
              onAddingChange={setAddingChild}
              onChildTitleChange={setChildTitle}
              onCreate={createChild}
              onNavigate={onNavigate}
            />

            <MailSection mail={mail} />

            {/* Properties (mobile) — the desktop aside is hidden <md, so mirror
                its rows in a collapsible disclosure above the activity feed. */}
            <details
              className="mb-4 rounded-lg border border-border md:hidden"
              data-testid="issue-details-mobile"
            >
              <summary className="cursor-pointer select-none px-3 py-2 font-medium text-[13px] text-foreground">
                Details
              </summary>
              <div className="border-border border-t px-3 py-2">
                <IssueProperties
                  issue={issue}
                  busy={busy}
                  commands={commands}
                  onNavigate={onNavigate}
                  onRequestClose={setCloseReason}
                />
              </div>
            </details>

            <IssueActivitySection
              issue={issue}
              busy={busy}
              commands={commands}
              feed={feed}
              commentBody={commentBody}
              onCommentBodyChange={setCommentBody}
              onPost={postComment}
            />
          </div>
        </div>

        <aside
          data-testid="issue-aside"
          className="hidden w-[280px] shrink-0 overflow-y-auto border-border border-l px-4 py-4 md:block"
        >
          <IssueProperties
            issue={issue}
            busy={busy}
            commands={commands}
            onNavigate={onNavigate}
            onRequestClose={setCloseReason}
          />
        </aside>
      </div>

      <IssueCloseDialog
        issue={issue}
        reason={closeReason}
        busy={busy}
        onOpenChange={(open) => !open && setCloseReason(null)}
        onConfirm={(reason) => commands.selectStatus(`close:${reason}`)}
      />

      {toast && (
        <div
          className={cn(
            'border-border border-t px-4 py-2 text-[12px]',
            'whitespace-pre-wrap break-words text-muted-foreground',
          )}
          role="status"
        >
          {toast}
        </div>
      )}
    </div>
  )
}
