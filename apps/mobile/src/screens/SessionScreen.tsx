import { issueAgentKind, issueAgentLabel, modelName } from '@podium/client-core/agent-models'
import { useHarnessDescriptors } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { sessionValues } from '@podium/client-core/session-values'
import { isDraftAgentVessel, readoutModel, sessionTitle } from '@podium/client-core/values'
import type { SessionId, WorkState } from '@podium/model'
import { asSessionId, snoozeUntil1h, snoozeUntilTomorrow5am } from '@podium/model'
import { isShortSessionIdentifier, issueDisplayRef } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { compareStructural, computed } from 'mobx'
import { observer } from 'mobx-react-lite'
import {
  type ComponentProps,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useStoreActions } from '../client/hooks'
import { useScreenReadFocus } from '../client/screen-read-focus'
import type { MobileTrpc } from '../client/trpc'
import {
  useSessionContextBooting as useBooting,
  useSessionContextChromeIssue as useIssue,
  useSessionContextSession as useSession,
  useSessionContextExit,
  useSessionContextIssueAgentCount,
  useSessionContextNextSession,
  useSessionContextSpawnPending as useSpawnPending,
  useSessionContextSpawnPrompt as useSpawnPrompt,
} from '../client/use-session-context'
import { ActionSheet } from '../components/ActionSheet'
import {
  Archive,
  ArchiveRestore,
  MoonZzz,
  MoreVertical,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  SkipForward,
  SquareStack,
  SquareTerminal,
  Trash2,
  XOctagon,
} from '../components/icons'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { Screen, type ScreenAction, type ScreenMenuEntry } from '../components/Screen'
import { SessionConversation } from '../components/SessionConversation'
import { EmptyState } from '../components/ui'
import { WorkingMark } from '../components/WorkingMark'
import { hasSessionBackTarget, sessionBackTarget, sessionHref } from '../lib/session-route'
import { DELETE_TASK_TITLE, deleteTaskSubtitle } from '../lib/task-delete'
import { useHeaderInset } from '../navigation/header-inset'
import { sessionAbsence, sessionAbsenceShowsLoader, sessionLinkAbsence } from './session-absence'
import { useSessionLink } from './session-link'

const WORK_STATES: (WorkState | null)[] = [
  'planning',
  'implementing',
  'testing',
  'done',
  'icebox',
  null,
]

/**
 * ONE AGENT'S CONVERSATION, reached directly — from the sessions roster, a
 * notification, or a draft vessel whose row IS its agent.
 *
 * The transcript itself lives in {@link SessionConversation} [POD-724]: the
 * mission screen hosts the same object, and a subscription with paging,
 * optimistic turns and a composer the feed pays height for is not something to
 * keep two copies of. What is left here is this screen's own chrome — identity,
 * the session menu, and the exits.
 */
export function SessionScreen() {
  // Route params are RAW URL values, so the type stays `string` and the brand is
  // applied once here — the DECODE EDGE for this screen (POD-362).
  const params = useLocalSearchParams<{
    sessionId: SessionId | string[]
    backTo?: string | string[]
  }>()
  const rawSessionId = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const sessionId = rawSessionId ? asSessionId(rawSessionId) : undefined
  const backTarget = sessionBackTarget(params.backTo)
  const hasBackTarget = hasSessionBackTarget(params.backTo)
  const router = useRouter()
  const exitKind = useSessionContextExit(sessionId)
  const readNextSession = useSessionContextNextSession()
  const session = useSession(sessionId)
  // Served descriptors for the session's machine (POD-4475). Above the
  // absence early-return: hooks stay unconditional.
  const { served: harnessServed } = useHarnessDescriptors<MobileTrpc>(session?.machineId)
  const spawnPending = useSpawnPending(sessionId)
  const observedSpawnPrompt = useSpawnPrompt(sessionId)
  const issue = useIssue(session?.issueId)
  useScreenReadFocus(issue?.id, session?.sessionId)
  const booting = useBooting()
  // A short id or birth ref in the route is answered by the server (POD-4637);
  // a `session` answer is the full id this route should have named.
  const link = useSessionLink(rawSessionId, { present: session !== undefined, spawnPending })
  const resolvedSessionId = link.kind === 'session' ? link.sessionId : undefined
  useEffect(() => {
    if (resolvedSessionId && resolvedSessionId !== sessionId) {
      router.replace(sessionHref(resolvedSessionId, backTarget))
    }
  }, [backTarget, resolvedSessionId, router, sessionId])

  // The ••• is a header menu action: a native pull-down on iOS that UIKit
  // opens without any render, and on Android and web a button that holds its
  // own sheet. Opening it never re-renders this screen, whose every render
  // re-sends the header's options to the native bar (that churn moved the
  // transcript).
  const menus = useRef<SessionMenusHandle>(null)
  const confirmDelete = useCallback(() => menus.current?.confirmDelete(), [])
  const [findRequest, setFindRequest] = useState(0)
  const find = useCallback(() => setFindRequest((request) => request + 1), [])
  const openTerminal = useCallback(() => {
    if (sessionId) router.push(`/session/${encodeURIComponent(sessionId)}/terminal`)
  }, [router, sessionId])
  // Replica confirmation retires the engine-owned prompt in the same update
  // that replaces the provisional session. Keep the text until the transcript
  // itself proves the first turn landed.
  const [heldSpawnPrompt, setHeldSpawnPrompt] = useState<{
    sessionId: SessionId
    text: string
  } | null>(sessionId && observedSpawnPrompt ? { sessionId, text: observedSpawnPrompt } : null)
  useEffect(() => {
    if (sessionId && observedSpawnPrompt) {
      setHeldSpawnPrompt({ sessionId, text: observedSpawnPrompt })
    }
  }, [observedSpawnPrompt, sessionId])
  const optimisticFirstPrompt =
    observedSpawnPrompt ??
    (heldSpawnPrompt && heldSpawnPrompt.sessionId === sessionId ? heldSpawnPrompt.text : undefined)
  const settleOptimisticFirstPrompt = useCallback(() => {
    setHeldSpawnPrompt((current) => (current?.sessionId === sessionId ? null : current))
  }, [sessionId])

  const goBack = useCallback(() => {
    if (hasBackTarget) {
      router.dismissTo(backTarget)
      return
    }
    router.replace('/work')
  }, [backTarget, hasBackTarget, router])

  const nextSession = useCallback(() => {
    if (!sessionId) return
    const next = readNextSession(sessionId)
    if (next && next !== sessionId) router.replace(sessionHref(next, backTarget))
  }, [backTarget, readNextSession, router, sessionId])
  const menuHandlers = useMemo<SessionMenuHandlers>(
    () => ({ nextSession, onFind: find, onDelete: confirmDelete, openTerminal }),
    [confirmDelete, find, nextSession, openTerminal],
  )

  if (!sessionId || !session) {
    // A SESSION THAT IS NOT HERE IS THREE DIFFERENT FACTS (doc §3.1 ¶2).
    // Deleted, evicted from THIS principal's view (a share revoked, or never
    // granted — it still exists), or simply not arrived yet. This screen used to
    // render all three as "it may have been removed on the server", which is the
    // exact defect `resolveReferent` exists to prevent: an eviction rendered as
    // a deletion. `pending` says "not yet" without spinning forever, and every
    // state is terminal copy. Only the genuinely pending state moves: removed
    // and not-visible are settled facts, so animating either would imply that
    // waiting can change the answer.
    const absence = sessionLinkAbsence(
      sessionAbsence(sessionId, session, () => exitKind),
      link,
      rawSessionId !== undefined && isShortSessionIdentifier(rawSessionId),
    )
    return (
      <Screen title="Session" onBack={goBack} safeBottom>
        <BootstrapCrossfade resolved={!booting} placeholder={<DetailSkeleton />}>
          <EmptyState
            title={absence.title}
            body={absence.body}
            icon={
              sessionAbsenceShowsLoader(absence, spawnPending) ? (
                <WorkingMark size={24} label="Waiting for session" />
              ) : undefined
            }
          />
        </BootstrapCrossfade>
      </Screen>
    )
  }

  return (
    <SessionChrome
      issue={issue}
      session={session}
      served={harnessServed}
      onBack={goBack}
      backLabel="Back"
      bareBack
      underHeader
      // No `safeBottom`: the floating composer is the bottom-most thing on this
      // screen and pays that inset itself, so it can drop it when the keyboard
      // takes the bottom edge [POD-502].
      menu={menuHandlers}
    >
      <HeaderInsetConversation
        session={session}
        issue={issue}
        findRequest={findRequest}
        initialPendingText={optimisticFirstPrompt}
        onInitialPendingSettled={settleOptimisticFirstPrompt}
        deferInitialTranscript={spawnPending}
      />
      <SessionMenus ref={menus} issue={issue} onDeleted={goBack} />
    </SessionChrome>
  )
}

/**
 * The transcript runs under the transparent navigation bar (POD-2387): the
 * Screen opts in with `underHeader`. The feed pays the measured bar height in
 * its content padding and marks its native scroll view for the iOS 26 edge
 * effect. The hook reads the Screen's context, hence a component below it.
 */
function HeaderInsetConversation(props: ComponentProps<typeof SessionConversation>) {
  return <SessionConversation {...props} topInset={useHeaderInset()} />
}

interface SessionMenusHandle {
  confirmDelete(): void
}

interface SessionMenuHandlers {
  nextSession: () => void
  onFind: () => void
  onDelete: () => void
  openTerminal: () => void
}

/** The draft-delete confirmation, holding its own open state. */
const SessionMenus = forwardRef<
  SessionMenusHandle,
  {
    issue: IssueViewModel | undefined
    onDeleted: () => void
  }
>(function SessionMenus({ issue, onDeleted }, ref) {
  const store = useStoreActions()
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  useImperativeHandle(ref, () => ({ confirmDelete: () => setConfirmDeleteOpen(true) }), [])
  // How many agents the draft-delete confirm names. Task scope, counted live:
  // the vessel can hold more than the one session this sheet opened from, and
  // the sentence must say so before anything is removed.
  const draftAgentCount = useSessionContextIssueAgentCount(issue?.id, confirmDeleteOpen)
  return (
    // A true confirmation: the system sheet in system colours.
    <ActionSheet
      visible={confirmDeleteOpen && draftAgentCount !== undefined}
      title={DELETE_TASK_TITLE}
      subtitle={deleteTaskSubtitle(draftAgentCount ?? 0)}
      actions={[
        {
          label: 'Delete',
          destructive: true,
          onPress: () => {
            if (issue) {
              void store.deleteIssue(issue.id).catch(() => {})
              onDeleted()
            }
          },
        },
      ]}
      onClose={() => setConfirmDeleteOpen(false)}
    />
  )
})

const SessionChrome = observer(function SessionChrome({
  issue,
  session,
  served,
  menu,
  children,
  ...screen
}: {
  issue: IssueViewModel | undefined
  session: SessionView
  served: ReturnType<typeof useHarnessDescriptors<MobileTrpc>>['served']
  /** The bar's actions: the terminal, then the ••• menu. */
  menu: SessionMenuHandlers
  children: ReactNode
} & Omit<ComponentProps<typeof Screen>, 'title' | 'subtitle' | 'leading' | 'children'>) {
  const kind = issueAgentKind(session.agentKind)
  const selectedModel = readoutModel(session)
  // Served descriptors for the session's machine (POD-4475): the harness
  // name and model render from the report, bundled copy offline.
  const provenance = `${issueAgentLabel(session.agentKind, served)}${kind && selectedModel ? ` · ${modelName(kind, selectedModel, undefined, served)}` : ''}`
  const entries = useSessionMenuEntries(session, issue, menu)
  const menuTitle = sessionTitle(session)
  const actions = useMemo<readonly ScreenAction[]>(
    () => [
      { label: 'Open terminal', icon: SquareTerminal, onPress: menu.openTerminal },
      { label: 'Session actions', icon: MoreVertical, items: entries, menuTitle },
    ],
    [entries, menu, menuTitle],
  )

  return (
    <Screen
      {...screen}
      actions={actions}
      title={issue?.title ?? sessionTitle(session)}
      subtitle={`${issue ? `${issueDisplayRef(issue)}   ` : ''}${provenance}`}
    >
      {children}
    </Screen>
  )
})

/** The facts the ••• menu is drawn from, so its entries change only when one does. */
function sessionMenuFacts(session: SessionView, issue: IssueViewModel | undefined) {
  return {
    sessionId: session.sessionId,
    issueId: issue?.id ?? null,
    draft: issue ? isDraftAgentVessel(issue, [session]) : false,
    pinned: issue?.pinned === true,
    archived: session.archived === true,
    workState: session.workState ?? null,
    snoozed: sessionValues(session).snoozedUntil !== undefined,
    errored: session.agentState?.phase === 'errored',
    live:
      session.status === 'live' ||
      session.status === 'starting' ||
      session.status === 'reconnecting',
  }
}
type SessionMenuFacts = ReturnType<typeof sessionMenuFacts>

/**
 * The ••• entries. Read through one structural `computed`, so a host observer
 * re-renders (and re-sends the native bar items) only when a menu fact
 * changes, not on every agent-state tick.
 */
function useSessionMenuEntries(
  session: SessionView,
  issue: IssueViewModel | undefined,
  handlers: SessionMenuHandlers,
): readonly ScreenMenuEntry[] {
  const store = useStoreActions()
  const facts = useMemo(
    () => computed(() => sessionMenuFacts(session, issue), { equals: compareStructural }),
    [issue, session],
  )
  const current = facts.get()
  const key = JSON.stringify(current)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `current` by value.
  return useMemo(() => sessionMenuEntries(current, store, handlers), [handlers, key, store])
}

type SessionMenuStore = ReturnType<typeof useStoreActions>

function sessionMenuEntries(
  facts: SessionMenuFacts,
  store: SessionMenuStore,
  { nextSession, onFind, onDelete }: SessionMenuHandlers,
): ScreenMenuEntry[] {
  const sessionId = facts.sessionId
  // A DRAFT'S CHAT GETS A DRAFT'S MENU (2026-08-27 device review). A draft
  // vessel has no worktree and no lifecycle yet — every session-scoped verb
  // below (archive, work state, snooze, next session) manages work that does
  // not exist. The one decision a draft supports is discarding it.
  //
  // DISCARDING IT IS A TASK DELETE, NOT A SESSION DELETE. `deleteIssue`
  // tombstones the issue AND every member session, so this row must confirm
  // first with the same cascade sentence the desktop's task menu uses —
  // never silently from a session's own menu.
  if (facts.draft) {
    return [{ label: 'Delete…', icon: Trash2, destructive: true, onPress: onDelete }]
  }
  const issueId = facts.issueId
  return [
    {
      items: [
        { label: 'Find in Transcript', icon: Search, onPress: onFind },
        {
          label: 'Next Session',
          hint: 'The next one waiting on you',
          icon: SkipForward,
          onPress: nextSession,
        },
      ],
    },
    {
      items: [
        ...(issueId
          ? [
              {
                label: facts.pinned ? 'Unpin' : 'Pin',
                icon: facts.pinned ? PinOff : Pin,
                onPress: () => void store.updateIssue(issueId, { pinned: !facts.pinned }),
              },
            ]
          : []),
        {
          label: facts.archived ? 'Unarchive' : 'Archive',
          icon: facts.archived ? ArchiveRestore : Archive,
          onPress: () => void store.archiveSession(sessionId, !facts.archived),
        },
        {
          title: 'Work State',
          icon: SquareStack,
          submenu: true,
          items: WORK_STATES.map((ws) => ({
            label: ws ? ws[0].toUpperCase() + ws.slice(1) : 'Unsorted',
            selected: facts.workState === ws,
            onPress: () => void store.setWorkState(sessionId, ws),
          })),
        },
        {
          title: 'Snooze',
          icon: MoonZzz,
          submenu: true,
          items: [
            {
              items: [
                {
                  label: 'Until Next Message',
                  onPress: () => void store.setSnooze(sessionId, null),
                },
                {
                  label: 'For 1 Hour',
                  onPress: () => void store.setSnooze(sessionId, snoozeUntil1h(Date.now())),
                },
                {
                  label: 'Until Tomorrow',
                  onPress: () =>
                    void store.setSnooze(sessionId, snoozeUntilTomorrow5am(Date.now())),
                },
              ],
            },
            ...(facts.snoozed
              ? [
                  {
                    items: [
                      {
                        label: 'Clear Snooze',
                        onPress: () => void store.clearSnooze(sessionId),
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
      ],
    },
    ...(facts.errored
      ? [
          {
            items: [
              {
                label: 'Continue After Error',
                icon: RefreshCw,
                onPress: () => void store.continueSession(sessionId),
              },
            ],
          },
        ]
      : []),
    ...(facts.live
      ? [
          {
            items: [
              {
                label: 'Kill Session',
                icon: XOctagon,
                destructive: true,
                onPress: () => void store.killSession(sessionId),
              },
            ],
          },
        ]
      : []),
  ]
}
