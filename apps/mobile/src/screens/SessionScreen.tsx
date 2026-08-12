import { groupSessions, withoutShells } from '@podium/client-core/focus'
import {
  agentBadge,
  panelLabel,
  sessionDotTone,
  sessionTitle,
} from '@podium/client-core/viewmodels'
import type { WorkState } from '@podium/model'
import { asSessionId, snoozeUntil1h, snoozeUntilTomorrow5am } from '@podium/model'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { MoreVertical, SquareTerminal } from 'lucide-react-native'
import { useCallback, useMemo, useState } from 'react'
import { useBooting, useIssue, useMobileStore, useSession, useSessions } from '../client/hooks'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { PressableScale } from '../components/PressableScale'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionConversation } from '../components/SessionConversation'
import { EmptyState } from '../components/ui'
import { hasSessionBackTarget, sessionBackTarget, sessionHref } from '../lib/session-route'
import { FLOW_HEX, issueColorHex } from '../theme/issueColors'
import { color } from '../theme/theme'
import { sessionAbsence } from './session-absence'

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
    sessionId: string | string[]
    backTo?: string | string[]
  }>()
  const rawSessionId = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const sessionId = rawSessionId ? asSessionId(rawSessionId) : undefined
  const backTarget = sessionBackTarget(params.backTo)
  const hasBackTarget = hasSessionBackTarget(params.backTo)
  const router = useRouter()
  const store = useMobileStore()
  const allSessions = useSessions()
  const session = useSession(sessionId)
  const issue = useIssue(session?.issueId)
  const booting = useBooting()

  const [menuOpen, setMenuOpen] = useState(false)
  const [workMenuOpen, setWorkMenuOpen] = useState(false)

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
    const actions: SheetAction[] = [
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
  }, [nextSession, store, session])

  if (!sessionId || !session) {
    // A SESSION THAT IS NOT HERE IS THREE DIFFERENT FACTS (doc §3.1 ¶2).
    // Deleted, evicted from THIS principal's view (a share revoked, or never
    // granted — it still exists), or simply not arrived yet. This screen used to
    // render all three as "it may have been removed on the server", which is the
    // exact defect `resolveReferent` exists to prevent: an eviction rendered as
    // a deletion. `pending` says "not yet" without spinning forever, and every
    // state is terminal copy rather than a loader.
    const absence = sessionAbsence(sessionId, session, (id) =>
      store.replica.exitKind?.('session', id),
    )
    return (
      <Screen title="Session" onBack={goBack} safeBottom>
        <BootstrapCrossfade resolved={!booting} placeholder={<DetailSkeleton />}>
          <EmptyState title={absence.title} body={absence.body} />
        </BootstrapCrossfade>
      </Screen>
    )
  }

  // The issue colour flows through the chrome; slate when the issue is uncoloured.
  const accent = issue ? (issueColorHex(issue.color) ?? FLOW_HEX) : undefined

  return (
    <Screen
      title={sessionTitle(session)}
      subtitle={`${panelLabel(session.agentKind)} · ${agentBadge(session)?.label ?? session.status}${session.queuedMessageCount ? ` · ${session.queuedMessageCount} queued` : ''}`}
      onBack={goBack}
      backLabel="Back"
      accent={accent}
      // No `safeBottom`: the floating composer is the bottom-most thing on this
      // screen and pays that inset itself, so it can drop it when the keyboard
      // takes the bottom edge [POD-502].
      leading={
        issue ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Task ${issue.seq} — open the mission`}
            onPress={() => router.push(`/mission/${encodeURIComponent(issue.id)}`)}
            hitSlop={8}
          >
            <IdSquare
              issue={issue}
              state={
                issue.needsHuman || sessionDotTone(session) === 'attention' ? 'waiting' : 'working'
              }
              size={18}
            />
          </PressableScale>
        ) : undefined
      }
      right={
        <>
          <HeaderButton
            label="Open terminal"
            onPress={() => router.push(`/session/${encodeURIComponent(sessionId)}/terminal`)}
          >
            <Icon as={SquareTerminal} size={17} color={color.textDim} />
          </HeaderButton>
          <HeaderButton label="Session actions" onPress={() => setMenuOpen(true)}>
            <Icon as={MoreVertical} size={17} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      <SessionConversation session={session} issue={issue} />
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
