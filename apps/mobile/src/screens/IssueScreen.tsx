import { withoutShells } from '@podium/client-core/focus'
import { resolveIssueEdge, subIssuesOf } from '@podium/client-core/viewmodels'
import {
  type IssueCloseReason,
  type IssueId,
  IssueType,
  type IssueWire,
  issueStatusMenuEntries,
  issueStatusValueOf,
  parseIssueStatusValue,
  type SessionId,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronDown, ChevronUp, MoreHorizontal } from '../components/icons'
import { useCallback, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import {
  useBooting,
  useConnected,
  useIssue,
  useIssues,
  useSessions,
  useStoreActions,
  useTrpc,
} from '../client/hooks'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { Composer } from '../components/Composer'
import { ConfiguredIssueLaunchSheet } from '../components/ConfiguredIssueLaunchSheet'
import { KeyboardAvoidingRoot } from '../components/KeyboardAvoidingRoot'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { IssueCloseSheet } from '../components/IssueCloseSheet'
import { IssueColorSheet } from '../components/IssueColorSheet'
import { IssueQuestionCard } from '../components/IssueQuestionCard'
import { IssueTargetSheet } from '../components/IssueTargetSheet'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { PressableScale } from '../components/PressableScale'
import { HeaderButton, Screen } from '../components/Screen'
import { PriorityGlyph, StageGlyph } from '../components/StageGlyph'
import { ErrorNote } from '../components/task-detail/chrome'
import { IssueActivitySection, MailSection } from '../components/task-detail/IssueActivity'
import { IssueAgentPanel } from '../components/task-detail/IssueAgentPanel'
import { IssueBanners } from '../components/task-detail/IssueBanners'
import { GitReviewSection } from '../components/task-detail/GitReviewSection'
import {
  IssueBrief,
  IssueDescription,
  IssueTitle,
  LongFormFields,
  StatusStrip,
} from '../components/task-detail/IssueBody'
import { IssueNow } from '../components/task-detail/IssueNow'
import { IssueProperties, PropertyBar } from '../components/task-detail/IssueProperties'
import { IssueSubIssues } from '../components/task-detail/IssueSubIssues'
import { PromptSheet } from '../components/task-detail/PromptSheet'
import { EmptyState } from '../components/ui'
import { useCollapsed } from '../hooks/useCollapsed'
import { useKeyboardLift } from '../hooks/useKeyboardHeight'
import { TASK_DETAILS_FOLD_KEY } from '../lib/fold-keys'
import { issueCommands, type RunMutation } from '../lib/issue-detail'
import { issueCloseBlockers } from '../lib/issue-close'
import { sessionHref } from '../lib/session-route'
import { useIssueActivity } from '../lib/use-issue-detail'
import { issueColorHex } from '../theme/issueColors'
import { color, space } from '../theme/theme'

/**
 * THE TASK PAGE, WITH THE DESKTOP'S POWER [POD-724].
 *
 * What this replaced was a thin page: a chip row, the description, a list of
 * sessions and a comment list. Everything else a task carries — its banners, its
 * agent-published artifacts, its sub-tasks, its mail, its relations,
 * its branch, its event history — was desk-only, which meant the phone could show
 * you that something needed you and then could not show you what it was.
 *
 * The section order is the desktop's, re-expressed for a 390pt one-handed screen:
 *
 *   banners → title → status strip → the everyday properties →
 *   NOW (live agents + branch) → description → brief → long-form spec fields →
 *   the agent-published panel → sub-tasks → mail → Details (folded) → activity,
 *   with the comment composer PINNED below the scroll.
 *
 * -------------------------------------------------------------------------
 * THIS FILE IS COMPOSITION AND PAGE-LEVEL STATE. NOTHING ELSE.
 * -------------------------------------------------------------------------
 *
 * Each section is its own module under `../components/task-detail/`, chosen by
 * the question it answers; every mutation is a named command in
 * `../lib/issue-detail.ts`; the three lazy reads are one hook. What is LEFT here
 * is the state that genuinely spans sections — which sheet is open and the
 * busy / error pair — because pushing either of those down would duplicate them.
 *
 * THE COMPOSER IS PINNED, NOT APPENDED. A task with twenty artifacts and a day of
 * events puts the reply box thousands of pixels down the scroll, so replying
 * would mean first travelling past everything you were replying to.
 */
export function IssueScreen({ dismiss = false }: { dismiss?: boolean } = {}) {
  const params = useLocalSearchParams<{ issueId: IssueId | string[] }>()
  const issueId = decodeURIComponent(
    Array.isArray(params.issueId) ? params.issueId[0] : (params.issueId ?? ''),
  )
  const router = useRouter()
  const issue = useIssue(issueId)
  const booting = useBooting()
  const connected = useConnected()

  /**
   * Back, with somewhere to go [POD-402, the trap in POD-358].
   *
   * A bare `router.back()` is fine when you arrived by tapping a row and empty
   * when you did not — reload the app on a task URL, or open one from a
   * notification, and there is no history behind this screen. The chevron then
   * did nothing at all, which on a standalone PWA (no browser back, no browser
   * chrome) leaves the task view with no exit.
   */
  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/issues')
  }, [router])

  // POD-541: "Task not found" is a claim about existence. Offline, a missing
  // row more often means "the cache does not have it" than "it does not exist"
  // — keep the page-shaped skeleton rather than a false deletion. Only claim
  // absence once we are connected and no longer booting.
  const certainAbsence = issue === undefined && !booting && connected
  const resolved = issue !== undefined || certainAbsence

  return (
    <BootstrapCrossfade resolved={resolved} placeholder={<DetailSkeleton />}>
      {issue ? (
        <IssueContent issue={issue} onBack={goBack} dismiss={dismiss} />
      ) : (
        <Screen
          title="Task"
          onBack={goBack}
          backAs={dismiss ? 'text' : 'chevron'}
          backLabel={dismiss ? 'Done' : undefined}
        >
          {certainAbsence ? <EmptyState title="Task not found." fill /> : <DetailSkeleton />}
        </Screen>
      )}
    </BootstrapCrossfade>
  )
}

/** Which single-level sheet the page is showing. One at a time, by construction
 *  — a sheet raised over a sheet is the nested-modal case react-native-web does
 *  not handle, and this union makes it unrepresentable. */
type OpenSheet =
  | null
  | { kind: 'stage' }
  | { kind: 'priority' }
  | { kind: 'type' }
  | { kind: 'parent' }
  | { kind: 'relation-type' }
  | { kind: 'relation-target'; type: string }
  | { kind: 'supersede' }
  | { kind: 'menu' }
  | { kind: 'confirm-delete' }
  | { kind: 'confirm-archive' }
  /** Carries the ending being recorded — the guard is raised BY a close, so it
   *  has to remember which one it is guarding (POD-1129). */
  | { kind: 'confirm-close'; reason: IssueCloseReason }
  | { kind: 'child-status'; child: IssueWire }
  | { kind: 'confirm-child-close'; child: IssueWire; reason: IssueCloseReason }
  | { kind: 'flag' }
  | { kind: 'colour' }
  | { kind: 'launch' }

/** The relation kinds the phone offers. `parent-child` and `supersedes` are
 *  deliberately absent: parentage has its own row and supersede/duplicate are
 *  lifecycle acts on the overflow menu, so offering them here would let the same
 *  fact be stated two ways. */
const RELATION_TYPES = ['blocks', 'related', 'discovered-from'] as const

function IssueContent({
  issue,
  onBack,
  dismiss,
}: {
  issue: IssueWire
  onBack: () => void
  dismiss: boolean
}) {
  const router = useRouter()
  const trpc = useTrpc()
  // The picked action set doubles as the page's IssueWriteActions — every
  // field is identity-stable, so this subscription never re-renders the page.
  const actions = useStoreActions()
  const { resumeAndSend } = actions
  const issues = useIssues()
  const allSessions = useSessions()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState<OpenSheet>(null)
  const [detailsOpen, detailsCollapsed] = useDetailsFold()
  const keyboardLift = useKeyboardLift()

  /** Run a mutation, surfacing any thrown error verbatim as an inline note. */
  const run: RunMutation = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const commands = issueCommands({
    trpc,
    issue,
    sessions: allSessions,
    run,
    actions,
    // Only reached when the shared derivation found something to say; a clean
    // close never gets this far (POD-1129).
    requestClose: (reason) => setSheet({ kind: 'confirm-close', reason }),
  })
  const { feed, mail, appendLocalComment } = useIssueActivity(issue)

  const sessions = useMemo(
    () => allSessions.filter((s) => s.issueId === issue.id && !s.archived),
    [allSessions, issue.id],
  )
  // The Now block is about AGENTS. A shell is a terminal the operator opened on
  // the task's checkout, not something computing on its behalf, so it belongs in
  // the roster and not in "who is working".
  const agents = useMemo(() => withoutShells(sessions), [sessions])
  const children = useMemo(() => subIssuesOf(issues, issue.id), [issues, issue.id])
  const parent = useMemo(
    () => (issue.parentId ? issues.find((i) => i.id === issue.parentId) : undefined),
    [issues, issue.parentId],
  )
  /**
   * Repo-mates: sibling tasks in the same repo excluding self — the pool for
   * parent, relations and supersede targets.
   *
   * NEWEST FIRST, where the desktop's `repoMatesOf` sorts ascending. The desktop
   * pairs that list with a type-to-filter menu, so where a task sits in it barely
   * matters; a phone sheet is a scroll with no filter, and the task you are
   * relating this one to is overwhelmingly one you filed recently. Nothing is
   * truncated — a silently capped picker is a picker that cannot reach the row
   * you want and does not say so.
   */
  const mates = useMemo(
    () =>
      issues
        .filter((i) => i.repoPath === issue.repoPath && i.id !== issue.id && !i.deletedAt)
        .sort((a, b) => b.seq - a.seq),
    [issues, issue.repoPath, issue.id],
  )
  const openIssue = (id: string) => router.replace(`/issue/${encodeURIComponent(id)}`)
  const openSession = (id: SessionId) =>
    router.push(sessionHref(id, `/issue/${encodeURIComponent(issue.id)}`))
  const askingSession =
    sessions.find((s) => s.sessionId === issue.humanQuestionAskedBy) ?? sessions[0]

  /**
   * Dismiss THIS sheet, and only if it is still the one showing.
   *
   * Not `() => setSheet(null)`. The sheet primitive fires `onClose` when its
   * close ANIMATION finishes, not when the dismissal starts, and two of these
   * flows open a second sheet from the first one's action (pick a relation type
   * then a target; choose Archive then confirm). A blanket clear therefore
   * arrives ~250ms late and closes the sheet that just opened. Keying the clear
   * on the kind makes the stale callback a no-op.
   */
  const closeIf = (kind: NonNullable<OpenSheet>['kind']) => () =>
    setSheet((cur) => (cur?.kind === kind ? null : cur))
  const resolveEdge = useMemo(() => {
    const byId = new Map(issues.map((candidate) => [candidate.id, candidate]))
    return (id: string | undefined | null) =>
      resolveIssueEdge(
        id,
        (targetId) => byId.get(targetId),
        'opaque',
        (targetId) => store.replica.exitKind?.('issue', targetId),
      )
  }, [issues, store.replica])

  const repoName = issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath
  const breadcrumb = parent
    ? `${repoName} › ${issueDisplayRef(parent)}${parent.archived ? ' · archived' : ''}`
    : repoName
  const hex = issueColorHex(issue.color)

  return (
    <Screen
      title={issueDisplayRef(issue)}
      // The desktop header's breadcrumb, at phone width: repo, then the parent's
      // ref when there is one. A nested task whose only mention of its parent
      // was inside a collapsed fold read as top-level work — the same confusion
      // the board's nesting exists to remove.
      subtitle={breadcrumb}
      onBack={onBack}
      backAs={dismiss ? 'text' : 'chevron'}
      backLabel={dismiss ? 'Done' : undefined}
      {...(hex ? { accent: hex } : {})}
      leading={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Change task colour"
          onPress={() => setSheet({ kind: 'colour' })}
          hitSlop={8}
        >
          <IdSquare
            issue={issue}
            size={22}
            state={
              issue.stage === 'done'
                ? 'done'
                : issue.needsHuman
                  ? 'waiting'
                  : agents.length > 0
                    ? 'working'
                    : 'queued'
            }
          />
        </PressableScale>
      }
      right={
        <HeaderButton label="More actions" onPress={() => setSheet({ kind: 'menu' })}>
          <Icon as={MoreHorizontal} size={17} color={color.text} />
        </HeaderButton>
      }
    >
      {/* The same keyboard contract the chat screens carry: on iOS the pinned
          composer otherwise sits UNDER the keyboard, so a comment was typed
          blind — the field disappeared on focus. The lift is the keyboard's own
          overlap (see useKeyboardHeight), not an avoiding view's frame
          arithmetic. The sheets stay outside: they are modal layers and place
          themselves. */}
      <View style={[styles.flex, { paddingBottom: keyboardLift }]} testID="issue-keyboard-avoider">
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <IssueBanners issue={issue} busy={busy} commands={commands} onRestored={onBack} />

          {issue.needsHuman ? (
            <View style={styles.question}>
              <IssueQuestionCard
                issue={issue}
                onAnswer={
                  askingSession
                    ? (answer) => resumeAndSend(askingSession.sessionId, answer)
                    : undefined
                }
                onOpenSession={
                  askingSession ? () => openSession(askingSession.sessionId) : undefined
                }
                // The card awaits its resolver; the command is fire-and-forget
                // through the page's runner, which already owns the busy/error pair.
                onResolve={async () => commands.resolveNeedsHuman()}
              />
            </View>
          ) : null}

          <IssueTitle issue={issue} busy={busy} commands={commands} />
          <StatusStrip issue={issue} />
          <PropertyBar
            issue={issue}
            onStage={() => setSheet({ kind: 'stage' })}
            onPriority={() => setSheet({ kind: 'priority' })}
            onType={() => setSheet({ kind: 'type' })}
          />

          <IssueNow issue={issue} sessions={agents} onOpenSession={openSession} />
          <IssueDescription issue={issue} busy={busy} commands={commands} />
          <IssueBrief issue={issue} />
          <LongFormFields issue={issue} busy={busy} commands={commands} />
          <IssueAgentPanel issue={issue} />
          {issue.worktreePath ? (
            <GitReviewSection
              root={issue.worktreePath}
              {...(issue.machineId === undefined ? {} : { machineId: issue.machineId })}
            />
          ) : null}
          <IssueSubIssues
            issue={issue}
            subIssues={children}
            busy={busy}
            commands={commands}
            sessions={allSessions}
            now={store.coarseNow}
            onOpen={openIssue}
            onStatus={(child) => setSheet({ kind: 'child-status', child })}
          />
          <MailSection mail={mail} />
          <IssueProperties
            issue={issue}
            sessions={sessions}
            parent={parent}
            resolveEdge={resolveEdge}
            busy={busy}
            commands={commands}
            open={detailsOpen}
            onToggle={detailsCollapsed}
            onOpenSession={openSession}
            onOpenIssue={openIssue}
            onPickParent={() => setSheet({ kind: 'parent' })}
            onAddRelation={() => setSheet({ kind: 'relation-type' })}
          />
          <IssueActivitySection issue={issue} busy={busy} commands={commands} feed={feed} />
        </ScrollView>

        {/* Pinned with the composer, not placed where the failing control was. A
          rebase fired from the Details fold at the bottom of a long page would
          otherwise report its error a full screen above the thumb that asked
          for it. */}
        {error ? (
          <View style={styles.errorBand}>
            <ErrorNote message={error} />
          </View>
        ) : null}

        <Composer
          placeholder="Comment, or @mention an agent on this task…"
          onSend={(text) => commands.postComment(text, appendLocalComment)}
        />
      </View>

      <ActionSheet
        visible={sheet?.kind === 'stage'}
        title="Status"
        // ONE list, the desktop's (POD-1074): the open lanes, then the endings
        // named as states — Done, Cancelled, Duplicate — each carrying its own
        // hint. The glyph rides every row, exactly as it does in the desktop's
        // status menu: the statuses are a shape language before they are words,
        // and a picker that drops the shape teaches a different vocabulary from
        // the board the operator just came from.
        actions={issueStatusMenuEntries().map((entry) => ({
          label: entry.label,
          ...(entry.hint ? { hint: entry.hint } : {}),
          icon: <StageGlyph stage={entry.status} size={15} ground={color.surface} />,
          selected: entry.value === issueStatusValueOf(issue),
          onPress: () => commands.selectStatus(entry.value),
        }))}
        onClose={closeIf('stage')}
      />

      <ActionSheet
        visible={sheet?.kind === 'priority'}
        title="Priority"
        actions={[0, 1, 2, 3, 4].map((p) => ({
          label: `P${p}`,
          icon: <PriorityGlyph priority={p} size={15} />,
          selected: issue.priority === p,
          onPress: () => commands.update({ priority: p }),
        }))}
        onClose={closeIf('priority')}
      />

      <ActionSheet
        visible={sheet?.kind === 'type'}
        title="Type"
        actions={IssueType.options.map((t) => ({
          label: t,
          selected: issue.type === t,
          onPress: () => commands.update({ type: t }),
        }))}
        onClose={closeIf('type')}
      />

      <IssueTargetSheet
        visible={sheet?.kind === 'parent'}
        title="Parent"
        subtitle={mates.length === 0 ? 'No other task in this repo to nest under.' : undefined}
        issues={mates}
        onPick={(target) => commands.setParent(target.id)}
        onClose={closeIf('parent')}
      />

      <ActionSheet
        visible={sheet?.kind === 'relation-type'}
        title="Add relation"
        actions={RELATION_TYPES.map((type) => ({
          label: type,
          onPress: () => setSheet({ kind: 'relation-target', type }),
        }))}
        onClose={closeIf('relation-type')}
      />

      <IssueTargetSheet
        visible={sheet?.kind === 'relation-target'}
        title={sheet?.kind === 'relation-target' ? sheet.type : ''}
        issues={mates}
        onPick={(target) => {
          if (sheet?.kind === 'relation-target') commands.addRelation(sheet.type, target.id)
        }}
        onClose={closeIf('relation-target')}
      />

      <IssueTargetSheet
        visible={sheet?.kind === 'supersede'}
        title="Supersede with"
        subtitle="This task is closed as replaced by the one you pick."
        issues={mates}
        onPick={(target) => commands.supersedeWith(target.id)}
        onClose={closeIf('supersede')}
      />

      <ActionSheet
        visible={sheet?.kind === 'child-status'}
        title={sheet?.kind === 'child-status' ? `${issueDisplayRef(sheet.child)} status` : 'Status'}
        actions={
          sheet?.kind === 'child-status'
            ? issueStatusMenuEntries().map((entry) => ({
                label: entry.label,
                ...(entry.hint ? { hint: entry.hint } : {}),
                icon: <StageGlyph stage={entry.status} size={15} ground={color.surface} />,
                selected: entry.value === issueStatusValueOf(sheet.child),
                onPress: () => selectChildStatus(sheet.child, entry.value),
              }))
            : []
        }
        onClose={closeIf('child-status')}
      />

      <ActionSheet
        visible={sheet?.kind === 'menu'}
        title={issueDisplayRef(issue)}
        actions={menuActions()}
        onClose={closeIf('menu')}
      />

      <ActionSheet
        visible={sheet?.kind === 'confirm-delete'}
        title="Delete this task?"
        subtitle={`The task and its ${sessions.length} session${sessions.length === 1 ? '' : 's'} can be restored; running processes will be stopped.`}
        actions={[
          {
            label: 'Delete',
            destructive: true,
            onPress: () => commands.deleteIssue(onBack),
          },
        ]}
        onClose={closeIf('confirm-delete')}
      />

      <ActionSheet
        visible={sheet?.kind === 'confirm-archive'}
        title="Archive this open task?"
        subtitle="It leaves active views, but it is not closed and its sessions are not retired."
        actions={[{ label: 'Archive', onPress: commands.toggleArchived }]}
        onClose={closeIf('confirm-archive')}
      />

      {/* Not an `ActionSheet` with a subtitle: what a close would cost is a LIST
          — a count of retired decisions, a count of dirty files, each with its
          own consequence — and a two-line subtitle can hold none of it. */}
      <IssueCloseSheet
        issue={sheet?.kind === 'confirm-child-close' ? sheet.child : issue}
        sessions={allSessions}
        reason={
          sheet?.kind === 'confirm-close' || sheet?.kind === 'confirm-child-close'
            ? sheet.reason
            : null
        }
        busy={busy}
        onConfirm={(reason) => {
          if (sheet?.kind === 'confirm-child-close') {
            void run(() => store.closeIssue(sheet.child.id, reason))
            setSheet(null)
            return
          }
          commands.closeNow(reason)
        }}
        onClose={() =>
          setSheet((current) =>
            current?.kind === 'confirm-close' || current?.kind === 'confirm-child-close'
              ? null
              : current,
          )
        }
      />

      <PromptSheet
        visible={sheet?.kind === 'flag'}
        title="Flag for human"
        hint="What should the operator decide? Optional."
        placeholder="Question…"
        confirmLabel="Flag"
        onConfirm={(q) => commands.flagForHuman(q || undefined)}
        onClose={closeIf('flag')}
      />

      <IssueColorSheet
        issue={sheet?.kind === 'colour' ? issue : null}
        onClose={closeIf('colour')}
      />
      <ConfiguredIssueLaunchSheet
        issue={sheet?.kind === 'launch' ? issue : null}
        onClose={closeIf('launch')}
      />
    </Screen>
  )

  /**
   * The overflow menu. Every entry is gated on DATA PRESENCE or on the task's own
   * lifecycle, exactly as the desktop's declarative menu config gates them; the
   * two acts that cannot be undone by a second tap raise a confirm sheet first.
   * This is UX gating only — the Authority re-authorizes at apply, and a denied
   * write surfaces through the same error note every command uses.
   */
  function menuActions(): SheetAction[] {
    const live = !issue.deletedAt
    const actions: SheetAction[] = []
    if (agents.length === 0 && live) {
      actions.push({
        label: 'Start an agent',
        hint: 'Choose agent, model, effort, and machine before starting.',
        onPress: () => setSheet({ kind: 'launch' }),
      })
    }
    // No "Add an agent" once one is running (2026-08-27 device review): a
    // second agent launches from the mission's deck or its 3-dots menu.
    if (live) actions.push({ label: 'Add a shell', onPress: commands.addShell })
    if (live) {
      actions.push({
        label: issue.pinned ? 'Unpin' : 'Pin',
        onPress: commands.togglePinned,
      })
      actions.push({
        label: issue.archived ? 'Unarchive task' : 'Archive task',
        onPress: () => {
          // Archiving something still OPEN is the case that surprises people.
          if (!issue.archived && !issue.closedReason && issue.stage !== 'done') {
            setSheet({ kind: 'confirm-archive' })
            return
          }
          commands.toggleArchived()
        },
      })
      actions.push({ label: 'Flag for human…', onPress: () => setSheet({ kind: 'flag' }) })
    }
    if (live && mates.length > 0) {
      actions.push({
        label: 'Supersede with…',
        onPress: () => setSheet({ kind: 'supersede' }),
        hint: 'Pick the task that replaces this one.',
      })
    }
    if (issue.deletedAt) {
      actions.push({ label: 'Restore task', onPress: () => commands.restoreIssue(onBack) })
    } else {
      actions.push({
        label: 'Delete',
        destructive: true,
        onPress: () => setSheet({ kind: 'confirm-delete' }),
      })
    }
    return actions
  }

  function selectChildStatus(child: IssueWire, value: string): void {
    const intent = parseIssueStatusValue(value)
    if (!intent) return
    if (intent.kind === 'stage') {
      void run(() => store.updateIssue(child.id, { stage: intent.stage }))
      return
    }
    if (issueCloseBlockers(child, allSessions).length > 0) {
      setSheet({ kind: 'confirm-child-close', child, reason: intent.reason })
      return
    }
    void run(() => store.closeIssue(child.id, intent.reason))
  }
}

/** The Details fold, remembered per principal in the replica's ui-state — the
 *  same store and key namespace the sidebar's folds use, so the phone and the
 *  desktop read as one product. Closed by default: it is the reference half of
 *  the page, and the activity feed should not start below a screenful of it. */
function useDetailsFold(): [boolean, () => void] {
  const [collapsed, toggle] = useCollapsed(TASK_DETAILS_FOLD_KEY, true)
  return [!collapsed, toggle]
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xxl,
  },
  question: {
    paddingBottom: space.md,
  },
  errorBand: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.dangerSoft,
  },
})
