import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { issueRepoName } from '@podium/client-core/values'
import { issueActivity } from '@podium/client-graph/issue-activity'
import {
  type IssueCloseReason,
  type IssueId,
  IssueType,
  issueStatusMenuEntries,
  issueStatusValueOf,
  parseIssueStatusValue,
  type SessionId,
} from '@podium/model'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useConnected, useStoreActions, useTrpc } from '../client/hooks'
import { issueObserver as observer } from '../client/issue-observer'
import { IssueOpening, useIssueOpening } from '../client/issue-opening'
import { useMobilePool } from '../client/mobile-pool'
import { useScreenReadFocus } from '../client/screen-read-focus'
import { useIssueCloseGuard } from '../client/use-issue-close'
import {
  resolveEdgeFromPool,
  useHasIssueMates,
  useIssueModel,
  useIssueTargets,
} from '../client/use-issue-model'
import { useSessionContextBooting as useBooting } from '../client/use-session-context'
import { ActionSheet } from '../components/ActionSheet'
import { IssueCloseSheet } from '../components/IssueCloseSheet'
import { IssueQuestionCard } from '../components/IssueQuestionCard'
import { IssueTargetSheet } from '../components/IssueTargetSheet'
import {
  Archive,
  ArchiveRestore,
  Flag,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Replace,
  RotateCcw,
  SquareTerminal,
  Trash2,
  UserPlus,
} from '../components/icons'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { Screen, type ScreenAction, type ScreenMenuEntry } from '../components/Screen'
import { PriorityGlyph, StageGlyph } from '../components/StageGlyph'
import { ErrorNote, ReferenceGroup } from '../components/task-detail/chrome'
import { DetailContent, DetailList } from '../components/task-detail/DetailList'
import { GitReviewSection } from '../components/task-detail/GitReviewSection'
import { IssueAgentPanel } from '../components/task-detail/IssueAgentPanel'
import { IssueBanners } from '../components/task-detail/IssueBanners'
import {
  IssueBrief,
  IssueDescriptionPreview,
  IssueTitle,
  LongFormFields,
} from '../components/task-detail/IssueBody'
import { IssueCost } from '../components/task-detail/IssueCost'
import {
  PhoneMail,
  PhoneProperties,
  PhoneTimeline,
} from '../components/task-detail/IssueModelSections'
import { PropertyBar } from '../components/task-detail/IssueProperties'
import { IssueStartAction } from '../components/task-detail/IssueStartAction'
import { IssueSubIssuesSection } from '../components/task-detail/IssueSubIssues'
import { PromptSheet } from '../components/task-detail/PromptSheet'
import { TaskOfferSummary } from '../components/task-detail/TaskOfferSummary'
import { ArtifactStrip, FoldedSection } from '../components/task-detail/TaskOverview'
import { TaskSessions } from '../components/task-detail/TaskSessions'
import { EmptyState } from '../components/ui'
import { useCollapsed } from '../hooks/useCollapsed'
import { useKeyboardLift } from '../hooks/useKeyboardHeight'
import { TASK_DETAILS_FOLD_KEY } from '../lib/fold-keys'
import { issueCommands, type RunMutation } from '../lib/issue-detail'
import { launchAgentHref, sessionHref } from '../lib/session-route'
import { DELETE_TASK_TITLE, deleteTaskSubtitle } from '../lib/task-delete'
import { color, space } from '../theme/theme'

/** Native task detail composition. Data and commands come from the shared page view.
 * Title/state, agents and actions lead; activity follows the task's reference content.
 */
export function IssueScreen(props: { dismiss?: boolean }) {
  return (
    <IssueOpening>
      <IssueScreenBody {...props} />
    </IssueOpening>
  )
}

const IssueScreenBody = observer(function IssueScreenBody({
  dismiss = false,
}: {
  dismiss?: boolean
}) {
  const params = useLocalSearchParams<{ issueId: IssueId | string[] }>()
  const issueId = decodeURIComponent(
    Array.isArray(params.issueId) ? params.issueId[0] : (params.issueId ?? ''),
  )
  const router = useRouter()
  const issue = useIssueModel(issueId)
  useScreenReadFocus(issue?.id)
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

  return issue ? (
    <IssueContent issue={issue} onBack={goBack} dismiss={dismiss} />
  ) : (
    <Screen
      grouped
      underHeader
      title="Task"
      onBack={goBack}
      backAs={dismiss ? 'text' : 'chevron'}
      backLabel={dismiss ? 'Done' : undefined}
    >
      <BootstrapCrossfade resolved={resolved} placeholder={<DetailSkeleton />}>
        {certainAbsence ? <EmptyState title="Task not found." fill /> : null}
      </BootstrapCrossfade>
    </Screen>
  )
})

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
  | { kind: 'relation-target'; type: (typeof RELATION_TYPES)[number] }
  | { kind: 'supersede' }
  | { kind: 'confirm-delete' }
  | { kind: 'confirm-archive' }
  /** Carries the ending being recorded — the guard is raised BY a close, so it
   *  has to remember which one it is guarding (POD-1129). */
  | { kind: 'confirm-close'; reason: IssueCloseReason }
  | { kind: 'child-status'; child: IssueViewModel }
  | { kind: 'confirm-child-close'; child: IssueViewModel; reason: IssueCloseReason }
  | { kind: 'flag' }
  | { kind: 'add-child' }

/** The relation kinds the phone offers. `supersedes` and `duplicates` are
 *  deliberately absent: parentage has its own row and supersede/duplicate are
 *  lifecycle acts on the overflow menu, so offering them here would let the same
 *  fact be stated two ways. */
const _EMPTY_ISSUES: IssueViewModel[] = []
const EMPTY_SESSIONS: SessionView[] = []
const EMPTY_TARGET_IDS: string[] = []

const RELATION_TYPES = ['blocked-by', 'related', 'discovered-from'] as const

const IssueContent = observer(function IssueContent({
  issue,
  onBack,
  dismiss,
}: {
  issue: IssueViewModel
  onBack: () => void
  dismiss: boolean
}) {
  const router = useRouter()
  const trpc = useTrpc()
  // The picked action set doubles as the page's IssueWriteActions — every
  // field is identity-stable, so this subscription never re-renders the page.
  const actions = useStoreActions()
  const hasCloseBlockers = useIssueCloseGuard()
  const { sendChat } = actions
  const pool = useMobilePool()
  const views = useIssueOpening()
  const detail = views?.row(issue.id)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState<OpenSheet>(null)
  const targetPickerOpen =
    sheet?.kind === 'parent' || sheet?.kind === 'relation-target' || sheet?.kind === 'supersede'
  const [targetQuery, setTargetQuery] = useState('')
  const [targetLimit, setTargetLimit] = useState(14)
  const targets = useIssueTargets(issue, targetPickerOpen, targetQuery, targetLimit + 1)
  const mates = targets?.slice(0, targetLimit) ?? EMPTY_TARGET_IDS
  useEffect(() => {
    if (!targetPickerOpen) {
      setTargetQuery('')
      setTargetLimit(14)
    }
  }, [targetPickerOpen])
  const searchTargets = (query: string) => {
    setTargetQuery(query)
    setTargetLimit(14)
  }
  const moreTargets = () => {
    if (targets && targets.length > targetLimit) setTargetLimit((limit) => limit + 14)
  }
  // The menu is built before it opens (iOS hands it to UIKit up front).
  const hasMates = useHasIssueMates(issue, true)
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
    hasCloseBlockers,
    run,
    actions,
    // Only reached when the shared derivation found something to say; a clean
    // close never gets this far (POD-1129).
    requestClose: (reason) => setSheet({ kind: 'confirm-close', reason }),
  })
  const appendLocalComment = (body: string) => {
    if (pool) issueActivity(pool, issue.id).appendComment(body)
  }

  const sessions = detail?.phoneSessions ?? EMPTY_SESSIONS
  if (typeof sessions === 'symbol') throw sessions
  const agents = sessions.filter((session) => session.agentKind !== 'shell')
  const parentEdge = resolveEdgeFromPool(pool, issue.parentId)
  const parent = parentEdge.render === 'issue' ? parentEdge.resolution.value : undefined
  const openIssue = (id: string) => router.push(`/issue/${encodeURIComponent(id)}`)
  const openSession = (id: SessionId) =>
    router.push(sessionHref(id, `/issue/${encodeURIComponent(issue.id)}`))
  const askingSession = sessions.find((s) => s.sessionId === issue.asked?.by) ?? sessions[0]
  // The shared page view orders open seats as desktop does: wanting attention
  // (an open offer), then the coordinator, then most recent. Its first seat
  // leads the page; a task with none open falls back to its roster.
  const active = detail?.dockActiveSessions ?? EMPTY_SESSIONS
  if (typeof active === 'symbol') throw active
  // Archived seats leave the open lists; the shared member roster keeps them,
  // so a finished task still shows (and opens) the session that did it.
  const members = detail?.memberSessions ?? EMPTY_SESSIONS
  if (typeof members === 'symbol') throw members
  const seats =
    active.length > 0
      ? active
      : agents.length > 0
        ? agents
        : members.filter((session) => session.agentKind !== 'shell')
  const lead = seats[0]

  // The ••• menu, built once per change of the facts that gate its entries.
  // Its actions reach the current commands through a ref, so an unrelated
  // render neither rebuilds the list nor re-sends the native bar items.
  // From the inspector sheet, launch replaces it: a sheet stacked on a sheet
  // leaves the chat two screens down, where the stack freezes it blank.
  const launch = () =>
    dismiss ? router.replace(launchAgentHref(issue.id)) : router.push(launchAgentHref(issue.id))
  const menuRun = useRef({ commands, onBack, launch })
  menuRun.current = { commands, onBack, launch }
  const menuKey = JSON.stringify({
    live: !issue.deletedAt,
    noAgents: agents.length === 0,
    pinned: issue.pinned === true,
    archived: issue.archived === true,
    finished: isFinished(issue),
    hasMates,
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: `menuKey` carries the facts by value.
  const menuEntries = useMemo(
    () => issueMenuEntries(JSON.parse(menuKey) as IssueMenuFacts, menuRun, setSheet),
    [menuKey],
  )
  const menuTitle = issueDisplayRef(issue)
  const menuBarActions = useMemo<readonly ScreenAction[]>(
    () => [{ label: 'More actions', icon: MoreHorizontal, items: menuEntries, menuTitle }],
    [menuEntries, menuTitle],
  )

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
  const _resolveEdge = (id: string | undefined | null) => resolveEdgeFromPool(pool, id)

  const repoName = issueRepoName(issue)
  const breadcrumb = parent
    ? `${repoName} › ${issueDisplayRef(parent)}${parent.archived ? ' · archived' : ''}`
    : repoName

  return (
    <Screen
      grouped
      // Content scrolls under the transparent bar (POD-2387); the ScrollView
      // insets itself below it.
      underHeader
      title={issueDisplayRef(issue)}
      // The desktop header's breadcrumb, at phone width: repo, then the parent's
      // ref when there is one. A nested task whose only mention of its parent
      // was inside a collapsed fold read as top-level work — the same confusion
      // the board's nesting exists to remove.
      subtitle={breadcrumb}
      onBack={onBack}
      backAs={dismiss ? 'text' : 'chevron'}
      backLabel={dismiss ? 'Done' : undefined}
      actions={menuBarActions}
    >
      {/* The keyboard contract the chat screens carry: inline editors (title,
          description, sub-task) stay above the keyboard. The lift is the
          keyboard's own overlap (see useKeyboardHeight). The sheets stay
          outside: they are modal layers and place themselves. */}
      <View style={[styles.flex, { paddingBottom: keyboardLift }]} testID="issue-keyboard-avoider">
        <DetailList>
          <DetailContent>
            <View style={styles.header} testID="issue-detail-header">
              <IssueTitle issue={issue} busy={busy} commands={commands} />
              <PropertyBar
                issue={issue}
                statusOnly
                onStage={() => setSheet({ kind: 'stage' })}
                onPriority={() => setSheet({ kind: 'priority' })}
                onType={() => setSheet({ kind: 'type' })}
                onSelect={{
                  status: commands.selectStatus,
                  priority: (priority) => commands.update({ priority }),
                  type: (type) => commands.update({ type }),
                }}
              />
            </View>
          </DetailContent>
          <TaskSessions issue={issue} sessions={active} onOpenSession={openSession} />
          <IssueSubIssuesSection
            key={issue.id}
            issue={issue}
            busy={busy}
            commands={commands}
            onOpen={openIssue}
            onStatus={(child) => setSheet({ kind: 'child-status', child })}
            onAdd={() => setSheet({ kind: 'add-child' })}
          />
          <IssueStartAction issue={issue} onStart={launch} />
          <IssueCost issueId={issue.id} />
          <DetailContent>
            <IssueBanners issue={issue} busy={busy} commands={commands} onRestored={onBack} />
            {issue.needsHuman ? (
              <View style={styles.question}>
                <IssueQuestionCard
                  issue={issue}
                  onAnswer={
                    askingSession
                      ? async (answer) => {
                          // A chat send like any other (POD-4762): waits for the
                          // server, wakes a parked session first.
                          await sendChat({
                            sessionId: askingSession.sessionId,
                            text: answer,
                            wake: true,
                          })
                        }
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

            <TaskOfferSummary
              issue={issue}
              lead={lead}
              onOpenSession={openSession}
              onComment={(text) => commands.postComment(text, appendLocalComment)}
            />
            <PhoneMail issue={issue} />
            <ReferenceGroup>
              <IssueDescriptionPreview issue={issue} busy={busy} commands={commands} />
              {issue.acceptance?.trim() ? (
                <LongFormFields issue={issue} busy={busy} commands={commands} />
              ) : null}
              {issue.brief?.trim() ? <IssueBrief issue={issue} /> : null}
              {issue.panel?.artifacts?.length ? (
                <FoldedSection label="Artifacts" count={String(issue.panel.artifacts.length)}>
                  <ArtifactStrip issue={issue}>
                    <IssueAgentPanel issue={issue} only="artifacts" />
                  </ArtifactStrip>
                </FoldedSection>
              ) : null}
              {issue.panel?.deferred?.length ? (
                <FoldedSection label="Deferred" count={String(issue.panel.deferred.length)}>
                  <IssueAgentPanel issue={issue} only="deferred" />
                </FoldedSection>
              ) : null}
              {issue.worktreePath ? (
                <FoldedSection label="Changes">
                  <GitReviewSection
                    root={issue.worktreePath}
                    headless
                    {...(issue.machineId === undefined ? {} : { machineId: issue.machineId })}
                  />
                </FoldedSection>
              ) : null}
              <PhoneProperties
                issue={issue}
                busy={busy}
                commands={commands}
                open={detailsOpen}
                onToggle={detailsCollapsed}
                onOpenSession={openSession}
                onOpenIssue={openIssue}
                onPickParent={() => setSheet({ kind: 'parent' })}
                onAddRelation={() => setSheet({ kind: 'relation-type' })}
                onPriority={() => setSheet({ kind: 'priority' })}
                onType={() => setSheet({ kind: 'type' })}
              />
              <FoldedSection label="Activity" testID="issue-activity-fold">
                <PhoneTimeline issue={issue} busy={busy} commands={commands} />
              </FoldedSection>
            </ReferenceGroup>
          </DetailContent>
        </DetailList>

        {/* Pinned to the bottom, not placed where the failing control was. A
          rebase fired from the Details fold at the bottom of a long page would
          otherwise report its error a full screen above the thumb that asked
          for it. */}
        {error ? (
          <View style={styles.errorBand}>
            <ErrorNote message={error} />
          </View>
        ) : null}
      </View>

      <PromptSheet
        visible={sheet?.kind === 'add-child'}
        title="Add sub-task"
        placeholder="Sub-task title"
        confirmLabel="Add"
        onConfirm={(title) => {
          if (title.trim()) commands.createSubIssue(title.trim())
        }}
        onClose={closeIf('add-child')}
      />

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
        loading={targets === null}
        title="Parent"
        subtitle={
          targets?.length === 0 && !targetQuery
            ? 'No other task in this repo to nest under.'
            : undefined
        }
        ids={mates}
        query={targetQuery}
        onQueryChange={searchTargets}
        onEndReached={moreTargets}
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
        loading={targets === null}
        title={sheet?.kind === 'relation-target' ? sheet.type : ''}
        ids={mates}
        query={targetQuery}
        onQueryChange={searchTargets}
        onEndReached={moreTargets}
        onPick={(target) => {
          if (sheet?.kind === 'relation-target') commands.addRelation(sheet.type, target.id)
        }}
        onClose={closeIf('relation-target')}
      />

      <IssueTargetSheet
        visible={sheet?.kind === 'supersede'}
        loading={targets === null}
        title="Supersede with"
        subtitle="This task is closed as replaced by the one you pick."
        ids={mates}
        query={targetQuery}
        onQueryChange={searchTargets}
        onEndReached={moreTargets}
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
        visible={sheet?.kind === 'confirm-delete'}
        title={DELETE_TASK_TITLE}
        subtitle={deleteTaskSubtitle(sessions.length)}
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
        reason={
          sheet?.kind === 'confirm-close' || sheet?.kind === 'confirm-child-close'
            ? sheet.reason
            : null
        }
        busy={busy}
        onConfirm={(reason) => {
          if (sheet?.kind === 'confirm-child-close') {
            void run(() => actions.closeIssue(sheet.child.id, reason))
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
    </Screen>
  )

  function selectChildStatus(child: IssueViewModel, value: string): void {
    const intent = parseIssueStatusValue(value)
    if (!intent) return
    if (intent.kind === 'stage') {
      void run(() => actions.updateIssue(child.id, { stage: intent.stage }))
      return
    }
    if (hasCloseBlockers(child.id)) {
      setSheet({ kind: 'confirm-child-close', child, reason: intent.reason })
      return
    }
    void run(() => actions.closeIssue(child.id, intent.reason))
  }
})

interface IssueMenuFacts {
  live: boolean
  noAgents: boolean
  pinned: boolean
  archived: boolean
  finished: boolean
  hasMates: boolean
}

/**
 * The overflow menu. Every entry is gated on DATA PRESENCE or on the task's own
 * lifecycle, exactly as the desktop's declarative menu config gates them; the
 * two acts that cannot be undone by a second tap raise a confirm sheet first.
 * This is UX gating only — the Authority re-authorizes at apply, and a denied
 * write surfaces through the same error note every command uses.
 */
function issueMenuEntries(
  facts: IssueMenuFacts,
  run: {
    readonly current: {
      commands: ReturnType<typeof issueCommands>
      onBack: () => void
      launch: () => void
    }
  },
  setSheet: (sheet: OpenSheet) => void,
): ScreenMenuEntry[] {
  const commands = () => run.current.commands
  if (!facts.live) {
    return [
      {
        label: 'Restore Task',
        icon: RotateCcw,
        onPress: () => commands().restoreIssue(run.current.onBack),
      },
    ]
  }
  return [
    {
      items: [
        // No "Add an agent" once one is running (2026-08-27 device review): a
        // second agent launches from the mission's deck or its 3-dots menu.
        ...(facts.noAgents
          ? [
              {
                label: 'Start an Agent…',
                hint: 'Choose agent, model, effort and machine',
                icon: UserPlus,
                onPress: () => run.current.launch(),
              },
            ]
          : []),
        { label: 'Add a Shell', icon: SquareTerminal, onPress: () => commands().addShell() },
        { label: 'Add sub-task', icon: Plus, onPress: () => setSheet({ kind: 'add-child' }) },
      ],
    },
    {
      items: [
        {
          label: facts.pinned ? 'Unpin' : 'Pin',
          icon: facts.pinned ? PinOff : Pin,
          onPress: () => commands().togglePinned(),
        },
        {
          label: facts.archived ? 'Unarchive Task' : 'Archive Task',
          icon: facts.archived ? ArchiveRestore : Archive,
          onPress: () => {
            // Archiving something still OPEN is the case that surprises people.
            if (!facts.archived && !facts.finished) {
              setSheet({ kind: 'confirm-archive' })
              return
            }
            commands().toggleArchived()
          },
        },
        { label: 'Flag for Human…', icon: Flag, onPress: () => setSheet({ kind: 'flag' }) },
        ...(facts.hasMates
          ? [
              {
                label: 'Supersede With…',
                hint: 'Pick the task that replaces this one',
                icon: Replace,
                onPress: () => setSheet({ kind: 'supersede' }),
              },
            ]
          : []),
      ],
    },
    {
      items: [
        {
          label: 'Delete…',
          icon: Trash2,
          destructive: true,
          onPress: () => setSheet({ kind: 'confirm-delete' }),
        },
      ],
    },
  ]
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
    gap: space.xl,
  },
  header: {
    gap: space.sm,
  },
  question: {},
  errorBand: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.dangerSoft,
  },
})
