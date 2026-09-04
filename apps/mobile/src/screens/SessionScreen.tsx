import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { isDraftAgentVessel, panelLabel, sessionTitle } from '@podium/client-core/viewmodels'
import type { SessionId, WorkState } from '@podium/model'
import { asSessionId, snoozeUntil1h, snoozeUntilTomorrow5am } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { MoreVertical, SquareTerminal } from '../components/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useBooting,
  useIssue,
  useReplica,
  useSession,
  useSessions,
  useSpawnPending,
  useSpawnPrompt,
  useStoreActions,
} from '../client/hooks'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { HarnessChip } from '../components/AgentMark'
import { Icon } from '../components/Icon'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionConversation } from '../components/SessionConversation'
import { EmptyState } from '../components/ui'
import { WorkingMark } from '../components/WorkingMark'
import { issueAgentKind, modelLabel } from '../lib/agent-models'
import { hasSessionBackTarget, sessionBackTarget, sessionHref } from '../lib/session-route'
import { color } from '../theme/theme'
import { sessionAbsence, sessionAbsenceShowsLoader } from './session-absence'

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
  // Actions + replica are identity-stable statics: this subscription never
  // re-renders the screen on store publishes.
  const store = useStoreActions()
  const replica = useReplica()
  const allSessions = useSessions()
  const session = useSession(sessionId)
  const spawnPending = useSpawnPending(sessionId)
  const observedSpawnPrompt = useSpawnPrompt(sessionId)
  const issue = useIssue(session?.issueId)
  const booting = useBooting()

  const [menuOpen, setMenuOpen] = useState(false)
  const [workMenuOpen, setWorkMenuOpen] = useState(false)
  const [findRequest, setFindRequest] = useState(0)
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

  // Round-robin triage order: needsYou, then idle, then working. Derived HERE
  // rather than published: this screen is its only consumer, and a slice with
  // one reader is the god object growing back under a nicer name (POD-409's
  // rule 1, applied in the direction that says NO).
  const focusSessionIds = useMemo(() => {
    const groups = groupSessions(withoutShells(allSessions))
    return [...groups.needsYou, ...groups.idle, ...groups.working].map((s) => s.sessionId)
  }, [allSessions])

  const nextSession = useCallback(() => {
    if (!sessionId || focusSessionIds.length === 0) return
    const at = focusSessionIds.indexOf(sessionId)
    const next = focusSessionIds[(at + 1) % focusSessionIds.length]
    if (next && next !== sessionId) router.replace(sessionHref(next, backTarget))
  }, [backTarget, focusSessionIds, router, sessionId])

  const menuActions = useMemo<SheetAction[]>(() => {
    if (!session) return []
    // A DRAFT'S CHAT GETS A DRAFT'S MENU (2026-08-27 device review). A draft
    // vessel has no worktree and no lifecycle yet — every session-scoped verb
    // below (archive, work state, snooze, next session) manages work that does
    // not exist. The one decision a draft supports is discarding it, so the
    // sheet is exactly Delete plus the standard Cancel.
    if (issue && isDraftAgentVessel(issue, [session])) {
      return [
        {
          label: 'Delete',
          destructive: true,
          onPress: () => {
            void store.deleteIssue(issue.id).catch(() => {})
            goBack()
          },
        },
      ]
    }
    const actions: SheetAction[] = [
      {
        label: 'Find in transcript',
        onPress: () => setFindRequest((request) => request + 1),
      },
      ...(issue
        ? [
            {
              label: issue.pinned ? 'Unpin' : 'Pin',
              onPress: () => void store.updateIssue(issue.id, { pinned: !issue.pinned }),
            },
          ]
        : []),
      { label: 'Next session', hint: 'Jump to the next one waiting on you', onPress: nextSession },
      {
        label: session.archived ? 'Unarchive' : 'Archive',
        onPress: () => void store.archiveSession(session.sessionId, !session.archived),
      },
      { label: 'Set work state…', onPress: () => setWorkMenuOpen(true) },
      {
        label: 'Snooze until next message',
        onPress: () => void store.setSnooze(session.sessionId, null),
      },
      {
        label: 'Snooze for 1 hour',
        onPress: () => void store.setSnooze(session.sessionId, snoozeUntil1h(Date.now())),
      },
      {
        label: 'Snooze until tomorrow',
        onPress: () => void store.setSnooze(session.sessionId, snoozeUntilTomorrow5am(Date.now())),
      },
    ]
    if (session.snoozedUntil !== undefined) {
      actions.push({
        label: 'Clear snooze',
        onPress: () => void store.clearSnooze(session.sessionId),
      })
    }
    if (session.agentState?.phase === 'errored') {
      actions.push({
        label: 'Continue after error',
        onPress: () => void store.continueSession(session.sessionId),
      })
    }
    if (
      session.status === 'live' ||
      session.status === 'starting' ||
      session.status === 'reconnecting'
    ) {
      actions.push({
        label: 'Kill session',
        destructive: true,
        onPress: () => void store.killSession(session.sessionId),
      })
    }
    return actions
  }, [goBack, issue, nextSession, store, session])

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
    const absence = sessionAbsence(sessionId, session, (id) => replica.exitKind?.('session', id))
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

  const kind = issueAgentKind(session.agentKind)
  const selectedModel = session.observedModel ?? session.model
  const provenance = `${session.agentKind === 'claude-code' ? 'Claude Code' : panelLabel(session.agentKind)}${kind && selectedModel ? ` · ${modelLabel(kind, selectedModel)}` : ''}`

  return (
    <Screen
      title={issue?.title ?? sessionTitle(session)}
      subtitle={`${issue ? `${issueDisplayRef(issue)}   ` : ''}${provenance}`}
      onBack={goBack}
      backLabel="Back"
      bareBack
      monoSubtitle
      // No `safeBottom`: the floating composer is the bottom-most thing on this
      // screen and pays that inset itself, so it can drop it when the keyboard
      // takes the bottom edge [POD-502].
      leading={<HarnessChip kind={session.agentKind} size={20} />}
      right={
        <>
          <HeaderButton
            label="Open terminal"
            size={32}
            onPress={() => router.push(`/session/${encodeURIComponent(sessionId)}/terminal`)}
          >
            <Icon as={SquareTerminal} size={17} color={color.textDim} />
          </HeaderButton>
          <HeaderButton label="Session actions" onPress={() => setMenuOpen(true)} size={32} bare>
            <Icon as={MoreVertical} size={17} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      <SessionConversation
        session={session}
        issue={issue}
        findRequest={findRequest}
        initialPendingText={optimisticFirstPrompt}
        onInitialPendingSettled={settleOptimisticFirstPrompt}
        deferInitialTranscript={spawnPending}
      />
      <ActionSheet
        visible={menuOpen}
        title={sessionTitle(session)}
        actions={menuActions}
        onClose={() => setMenuOpen(false)}
      />
      <ActionSheet
        visible={workMenuOpen}
        title="Work state"
        actions={WORK_STATES.map((ws) => ({
          label: ws ? ws[0].toUpperCase() + ws.slice(1) : 'Unsorted',
          onPress: () => void store.setWorkState(sessionId, ws),
        }))}
        onClose={() => setWorkMenuOpen(false)}
      />
    </Screen>
  )
}
