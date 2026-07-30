import type { IssueId, IssueWire } from '@podium/model'
import { useRouter } from 'expo-router'
import { Check, Inbox, Play, RotateCcw, SkipForward, X } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { Screen } from '../components/Screen'
import { ScreeningCard } from '../components/ScreeningCard'
import { EmptyState } from '../components/ui'
import {
  applyScreeningDecision,
  buildScreeningQueue,
  reconcileScreeningOrder,
  type ScreeningOutcome,
  screeningTally,
} from '../lib/screening'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

interface Deck {
  order: IssueId[]
  index: number
}

interface Failure {
  id: string
  ref: string
  outcome: ScreeningOutcome
  message: string
}

const repoName = (issue: IssueWire) => issue.repoPath.split('/').filter(Boolean).pop() ?? ''
const refOf = (issue: IssueWire) => issue.displayRef ?? `#${issue.seq}`
const sameDeck = (a: Deck, b: Deck) =>
  a.index === b.index &&
  a.order.length === b.order.length &&
  a.order.every((id, i) => id === b.order[i])

/**
 * "Screen proposed" [POD-277] — one agent proposal at a time, decided in a
 * couple of seconds from the couch.
 *
 * Right (or the Start button) promotes the proposal and starts its agent; left
 * (or Decline) closes it as `wontfix`; Skip advances without touching the issue,
 * so it stays proposed for the next pass. Decisions apply optimistically — the
 * next card is immediately live — and a mutation that fails surfaces as a
 * retryable banner rather than a silently lost decision.
 *
 * The deck order is snapshotted when the flow opens; a board change underneath
 * only drops undecided cards that left the lane and appends new arrivals at the
 * end (see reconcileScreeningOrder), so the card under the thumb never swaps.
 */
export function ProposalScreeningScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const insets = useSafeAreaInsets()
  const [deck, setDeck] = useState<Deck>(() => ({
    order: buildScreeningQueue(client.issues).map((issue) => issue.id),
    index: 0,
  }))
  const [outcomes, setOutcomes] = useState<Record<string, ScreeningOutcome>>({})
  const [failures, setFailures] = useState<Failure[]>([])
  const [pending, setPending] = useState<string[]>([])
  const inFlight = useRef(new Set<string>())

  // Fold live board changes into the open deck (never around the current card).
  useEffect(() => {
    setDeck((prev) => {
      const next = reconcileScreeningOrder(prev.order, prev.index, client.issues)
      return sameDeck(prev, next) ? prev : next
    })
  }, [client.issues])

  const run = useCallback(
    async (issue: IssueWire, outcome: ScreeningOutcome) => {
      const ref = refOf(issue)
      inFlight.current.add(issue.id)
      setPending((p) => [...p, issue.id])
      try {
        await applyScreeningDecision(client.trpc, issue, outcome)
        setFailures((f) => f.filter((entry) => entry.id !== issue.id))
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setOutcomes((o) => {
          const next = { ...o }
          delete next[issue.id]
          return next
        })
        setFailures((f) => [
          ...f.filter((entry) => entry.id !== issue.id),
          { id: issue.id, ref, outcome, message },
        ])
      } finally {
        inFlight.current.delete(issue.id)
        setPending((p) => p.filter((id) => id !== issue.id))
      }
    },
    [client.trpc],
  )

  const decide = useCallback(
    (issue: IssueWire, outcome: ScreeningOutcome) => {
      // A card can only be decided once; a second gesture on an in-flight
      // mutation is a no-op rather than a double promote/close.
      if (inFlight.current.has(issue.id)) return
      setOutcomes((o) => ({ ...o, [issue.id]: outcome }))
      setDeck((prev) => ({ ...prev, index: Math.min(prev.index + 1, prev.order.length) }))
      void run(issue, outcome)
    },
    [run],
  )

  const retry = useCallback(
    (failure: Failure) => {
      const issue = client.issueById(failure.id)
      if (!issue) {
        setFailures((f) => f.filter((entry) => entry.id !== failure.id))
        return
      }
      setOutcomes((o) => ({ ...o, [issue.id]: failure.outcome }))
      void run(issue, failure.outcome)
    },
    [client, run],
  )

  // Opened from a deep link / notification there is nothing to go back to, so
  // leaving lands on the board rather than doing nothing.
  const leave = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/issues')
  }, [router])

  const current = client.issueById(deck.order[deck.index] ?? '')
  const next = client.issueById(deck.order[deck.index + 1] ?? '')
  const tally = useMemo(() => screeningTally(Object.values(outcomes)), [outcomes])
  const skipped = useMemo(
    () => deck.order.slice(0, deck.index).filter((id) => outcomes[id] === 'skipped'),
    [deck, outcomes],
  )
  // The store paints from the local replica first; an empty board while the
  // socket is still down is "not loaded yet", not "nothing to screen".
  const booting = client.issues.length === 0 && !client.connected
  const failure = failures[failures.length - 1]

  const body = (() => {
    if (booting) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={color.accent} />
          <Text style={styles.loading}>Loading proposals…</Text>
        </View>
      )
    }
    if (deck.order.length === 0) {
      return (
        <EmptyState
          title="No proposals waiting"
          body="Anything an agent proposes lands here for your call. Nothing needs screening right now."
          icon={<Icon as={Inbox} size={24} color={color.textFaint} />}
        />
      )
    }
    if (!current) {
      return (
        <View style={styles.summary}>
          <View style={styles.summaryMark}>
            <Icon as={Check} size={22} color={color.accent} />
          </View>
          <Text style={styles.summaryTitle}>Screening done</Text>
          <Text style={styles.summaryBody}>
            {`${tally.total} proposal${tally.total === 1 ? '' : 's'} decided`}
          </Text>
          <View style={styles.tally}>
            <Text style={styles.tallyItem}>{`${tally.accepted} started`}</Text>
            <Text style={styles.tallyDot}>·</Text>
            <Text style={styles.tallyItem}>{`${tally.declined} declined`}</Text>
            <Text style={styles.tallyDot}>·</Text>
            <Text style={styles.tallyItem}>{`${tally.skipped} skipped`}</Text>
          </View>
          <View style={styles.summaryActions}>
            {skipped.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Screen the ${skipped.length} skipped proposals again`}
                onPress={() => {
                  setOutcomes((o) => {
                    const kept = { ...o }
                    for (const id of skipped) delete kept[id]
                    return kept
                  })
                  setDeck({ order: skipped, index: 0 })
                }}
                style={({ pressed }) => [styles.summaryBtn, pressed && styles.summaryBtnPressed]}
              >
                <Text style={styles.summaryBtnText}>{`Review ${skipped.length} skipped`}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to Tasks"
              onPress={() => leave()}
              style={({ pressed }) => [
                styles.summaryBtn,
                styles.summaryBtnPrimary,
                pressed && styles.summaryBtnPressed,
              ]}
            >
              <Text style={[styles.summaryBtnText, styles.summaryBtnPrimaryText]}>
                Back to Tasks
              </Text>
            </Pressable>
          </View>
        </View>
      )
    }

    return (
      <View style={styles.deck}>
        <View style={styles.progress}>
          {deck.order.map((id, i) => (
            <View
              key={id}
              style={[
                styles.progressSeg,
                i < deck.index && styles.progressSegDone,
                i === deck.index && styles.progressSegCurrent,
              ]}
            />
          ))}
        </View>
        <View style={styles.stack}>
          <View style={styles.cardWrap}>
            {/* The card underneath, peeking as a rim — the deck has depth only
                while something is actually behind it. */}
            {next ? <View style={styles.behindCard} pointerEvents="none" /> : null}
            <ScreeningCard
              key={current.id}
              issue={current}
              repoName={repoName(current)}
              parent={current.parentId ? client.issueById(current.parentId) : undefined}
              onDecide={(gesture) => decide(current, gesture)}
              onOpen={() => router.push(`/issue/${encodeURIComponent(current.id)}`)}
            />
          </View>
        </View>
        <Text style={styles.hint}>Swipe right to start · left to decline</Text>
      </View>
    )
  })()

  return (
    <Screen
      title="Screen proposed"
      subtitle={
        deck.order.length === 0
          ? undefined
          : current
            ? `${deck.index + 1} of ${deck.order.length} · ${repoName(current)}`
            : `${tally.total} decided`
      }
      onBack={() => leave()}
      backLabel="Back to Tasks"
    >
      <View style={styles.body}>
        {body}
        {pending.length > 0 ? (
          <Text style={styles.pending} accessibilityLiveRegion="polite">
            {`Applying ${pending.length} decision${pending.length === 1 ? '' : 's'}…`}
          </Text>
        ) : null}
        {failure ? (
          <View style={styles.failure} accessibilityLiveRegion="polite">
            <View style={styles.failureText}>
              <Text style={styles.failureTitle} numberOfLines={1}>
                {`${failure.ref} — ${failure.outcome === 'accepted' ? 'could not start' : 'could not close'}`}
              </Text>
              <Text style={styles.failureBody} numberOfLines={2}>
                {failure.message}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Retry ${failure.ref}`}
              onPress={() => retry(failure)}
              hitSlop={8}
              style={styles.failureBtn}
            >
              <Icon as={RotateCcw} size={14} color={color.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Dismiss the ${failure.ref} error`}
              onPress={() => setFailures((f) => f.filter((entry) => entry.id !== failure.id))}
              hitSlop={8}
              style={styles.failureBtn}
            >
              <Icon as={X} size={14} color={color.textDim} />
            </Pressable>
          </View>
        ) : null}
        {current ? (
          <View style={[styles.actions, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
            <ActionButton
              label="Decline"
              hint={`Close ${refOf(current)} as won't fix — same as swiping left`}
              icon={X}
              tint={color.danger}
              onPress={() => decide(current, 'declined')}
            />
            <ActionButton
              label="Skip"
              hint={`Leave ${refOf(current)} proposed and move on`}
              icon={SkipForward}
              tint={color.textDim}
              onPress={() => decide(current, 'skipped')}
            />
            <ActionButton
              label="Start"
              hint={`Accept ${refOf(current)} and start its agent — same as swiping right`}
              icon={Play}
              tint={color.accent}
              primary
              onPress={() => decide(current, 'accepted')}
            />
          </View>
        ) : null}
      </View>
    </Screen>
  )
}

function ActionButton({
  label,
  hint,
  icon,
  tint,
  primary,
  onPress,
}: {
  label: string
  hint: string
  icon: typeof X
  tint: string
  primary?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        primary
          ? { backgroundColor: color.accent, borderColor: color.accent }
          : { borderColor: color.border },
        pressed && styles.actionPressed,
      ]}
    >
      <Icon as={icon} size={16} color={primary ? color.onAccent : tint} />
      <Text style={[styles.actionLabel, { color: primary ? color.onAccent : tint }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
  },
  loading: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.small,
  },
  deck: {
    flex: 1,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm,
  },
  progress: {
    flexDirection: 'row',
    gap: 3,
    height: 3,
  },
  progressSeg: {
    flex: 1,
    borderRadius: radius.full,
    backgroundColor: color.hairline,
  },
  progressSegDone: {
    backgroundColor: color.textFaint,
  },
  progressSegCurrent: {
    backgroundColor: color.accent,
  },
  stack: {
    // Top-anchored: the ID square and title hold the same spot from card to
    // card, so screening is a rhythm instead of a re-read.
    flex: 1,
    justifyContent: 'flex-start',
  },
  cardWrap: {
    maxHeight: '100%',
  },
  behindCard: {
    position: 'absolute',
    left: 9,
    right: 9,
    top: 12,
    bottom: -9,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: color.hairline,
    backgroundColor: color.surface,
    opacity: 0.6,
  },
  hint: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
    textAlign: 'center',
  },
  pending: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    textAlign: 'center',
    paddingTop: space.xs,
  },
  failure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.md,
    marginTop: space.sm,
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(229, 48, 63, 0.4)',
    backgroundColor: color.dangerSoft,
  },
  failureText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  failureTitle: {
    ...sans(600),
    color: color.danger,
    fontSize: font.small,
  },
  failureBody: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.micro,
    lineHeight: 13,
  },
  failureBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
  },
  actions: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm + 2,
  },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 46,
    borderRadius: radius.lg,
    borderWidth: 1,
    backgroundColor: color.surface,
  },
  actionPressed: {
    opacity: 0.8,
  },
  actionLabel: {
    ...sans(600),
    fontSize: font.body,
  },
  summary: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.xl,
  },
  summaryMark: {
    width: 52,
    height: 52,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accentSoft,
    borderWidth: 1,
    borderColor: color.accentBorder,
    marginBottom: space.xs,
  },
  summaryTitle: {
    ...sans(600),
    color: color.text,
    fontSize: font.title,
    letterSpacing: -0.2,
  },
  summaryBody: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
  },
  tally: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: space.xs,
  },
  tallyItem: {
    ...monoLabel(9),
    color: color.label,
  },
  tallyDot: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
  },
  summaryActions: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.lg,
  },
  summaryBtn: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryBtnPrimary: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  summaryBtnPressed: {
    opacity: 0.85,
  },
  summaryBtnText: {
    ...sans(600),
    color: color.body,
    fontSize: font.small,
  },
  summaryBtnPrimaryText: {
    color: color.onAccent,
  },
})
