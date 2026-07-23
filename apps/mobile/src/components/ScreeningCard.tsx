import { relativeTime } from '@podium/client-core/focus'
import type { IssueWire } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { useRef } from 'react'
import {
  Animated,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { FLOW_SLATE, flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, elevation, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { IdSquare } from './IdSquare'
import { Pill } from './ui'

/** Horizontal travel that commits a swipe (a flick past it also commits). */
const COMMIT_PX = 96
const FLICK_VX = 0.45

export type ScreeningGesture = 'accepted' | 'declined' | 'skipped'

/**
 * One proposal, as a decidable card [POD-277].
 *
 * Carries enough to decide cold — identity square, repo, age, title, type /
 * priority / blocker pills, the human summary, the agent brief, and the launch
 * facts a start would use (agent, model, branch base). Dragging right stamps
 * START in Superade Yellow (the one primary-action signal), left stamps WON'T
 * FIX in alert red; releasing past the commit line flies the card out and
 * reports the gesture. Every gesture has a button twin in the screen's action
 * row, so nothing here is reachable only by dragging.
 */
export function ScreeningCard({
  issue,
  repoName,
  parent,
  onDecide,
  onOpen,
}: {
  issue: IssueWire
  repoName: string
  /** Resolved parent issue, when the proposal was filed under one. */
  parent?: IssueWire | undefined
  onDecide: (gesture: ScreeningGesture) => void
  onOpen: () => void
}) {
  const { width, height } = useWindowDimensions()
  const pan = useRef(new Animated.ValueXY()).current
  const decided = useRef(false)

  const fling = (gesture: ScreeningGesture) => {
    if (decided.current) return
    decided.current = true
    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(
        gesture === 'skipped'
          ? Haptics.ImpactFeedbackStyle.Light
          : Haptics.ImpactFeedbackStyle.Medium,
      ).catch(() => {})
    }
    const to =
      gesture === 'accepted'
        ? { x: width * 1.3, y: 40 }
        : gesture === 'declined'
          ? { x: -width * 1.3, y: 40 }
          : { x: 0, y: -height * 0.55 }
    Animated.timing(pan, { toValue: to, duration: 190, useNativeDriver: false }).start(() =>
      onDecide(gesture),
    )
  }

  const responder = useRef(
    PanResponder.create({
      // Taps (Open task) pass through; only a real horizontal drag takes over.
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_e, g) => {
        if (decided.current) return
        pan.setValue({ x: g.dx, y: g.dy * 0.25 })
      },
      onPanResponderRelease: (_e, g) => {
        if (decided.current) return
        const commit = Math.abs(g.dx) > COMMIT_PX || Math.abs(g.vx) > FLICK_VX
        if (commit && g.dx > 0) fling('accepted')
        else if (commit && g.dx < 0) fling('declined')
        else
          Animated.spring(pan, {
            toValue: { x: 0, y: 0 },
            useNativeDriver: false,
            speed: 22,
            bounciness: 6,
          }).start()
      },
      onPanResponderTerminate: () => {
        Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false, speed: 22 }).start()
      },
    }),
  ).current

  const hex = issueColorHex(issue.color) ?? FLOW_SLATE
  const now = Date.now()
  const rotate = pan.x.interpolate({
    inputRange: [-width, 0, width],
    outputRange: ['-9deg', '0deg', '9deg'],
  })
  const acceptOpacity = pan.x.interpolate({
    inputRange: [0, COMMIT_PX],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  })
  const declineOpacity = pan.x.interpolate({
    inputRange: [-COMMIT_PX, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  })
  const blockers = issue.blockedBy.length
  const openChildren = Math.max(0, issue.childCount - issue.childDoneCount)
  const brief = issue.brief?.trim()
  const description = issue.description.trim()
  const modelBits = [issue.defaultAgent, issue.defaultModel, issue.defaultEffort]
    .filter((bit) => bit && bit !== 'auto')
    .join(' · ')

  return (
    <Animated.View
      testID="screening-card"
      accessibilityLabel={`Proposal ${issue.displayRef ?? `#${issue.seq}`}: ${issue.title}`}
      {...responder.panHandlers}
      style={[
        styles.card,
        elevation.raised,
        { backgroundColor: flow.rowBg(hex), borderColor: alpha(hex, 0.35) },
        { transform: [{ translateX: pan.x }, { translateY: pan.y }, { rotate }] },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.stamp, styles.stampLeft, styles.stampAccept, { opacity: acceptOpacity }]}
      >
        <Text style={[styles.stampText, { color: color.accent }]}>START</Text>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[styles.stamp, styles.stampRight, styles.stampDecline, { opacity: declineOpacity }]}
      >
        <Text style={[styles.stampText, { color: color.danger }]}>WON'T FIX</Text>
      </Animated.View>

      <View style={styles.identity}>
        <IdSquare issue={issue} state="queued" size={26} ringColor={flow.rowBg(hex)} />
        <View style={styles.identityText}>
          <Text style={styles.ref}>{issue.displayRef ?? `#${issue.seq}`}</Text>
          <Text style={styles.origin} numberOfLines={1}>
            {repoName}
            {` · proposed ${relativeTime(issue.createdAt, now)}`}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open task ${issue.displayRef ?? `#${issue.seq}`}`}
          onPress={onOpen}
          hitSlop={10}
        >
          <Text style={styles.open}>Open ↗</Text>
        </Pressable>
      </View>

      <Text style={[styles.title, { color: flow.text(hex) }]} numberOfLines={3}>
        {issue.title}
      </Text>

      <View style={styles.pills}>
        <Pill label={issue.type} />
        <Pill label={`P${issue.priority}`} toneKey={issue.priority <= 1 ? 'needsYou' : undefined} />
        {blockers > 0 ? <Pill label={`blocked by ${blockers}`} toneKey="danger" /> : null}
        {openChildren > 0 ? <Pill label={`${openChildren} sub-tasks`} /> : null}
        {issue.origin === 'agent' ? <Pill label="agent proposal" /> : null}
      </View>

      <View style={styles.body}>
        {description ? (
          <Text style={styles.description} numberOfLines={brief ? 5 : 9}>
            {description}
          </Text>
        ) : (
          <Text style={styles.noDescription}>No summary was filed with this proposal.</Text>
        )}
        {brief ? (
          <View style={styles.briefBlock}>
            <Text style={styles.briefLabel}>BRIEF</Text>
            <Text style={styles.brief} numberOfLines={5}>
              {brief}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.facts}>
        {parent ? (
          <Text style={styles.fact} numberOfLines={1}>
            {`under ${parent.displayRef ?? `#${parent.seq}`} · ${parent.title}`}
          </Text>
        ) : null}
        {issue.dependencyNote ? (
          <Text style={styles.fact} numberOfLines={1}>
            {issue.dependencyNote}
          </Text>
        ) : null}
        <Text style={styles.fact} numberOfLines={1}>
          {`starts ${modelBits || issue.defaultAgent} on ⎇ ${issue.parentBranch}`}
        </Text>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  card: {
    // Content-sized: a proposal card is as tall as what it has to say, so a
    // one-line chore doesn't paint a screen of empty surface.
    maxHeight: '100%',
    borderRadius: radius.xl,
    borderWidth: 1,
    paddingHorizontal: space.md + 2,
    paddingTop: space.md,
    paddingBottom: space.md,
    gap: space.sm + 2,
    overflow: 'hidden',
  },
  stamp: {
    // Below the identity row, so the verdict never covers the issue's ID.
    position: 'absolute',
    top: '34%',
    zIndex: 2,
    borderWidth: 2,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  stampLeft: { left: space.md, transform: [{ rotate: '-11deg' }] },
  stampRight: { right: space.md, transform: [{ rotate: '11deg' }] },
  stampAccept: { borderColor: color.accent, backgroundColor: color.accentSoft },
  stampDecline: { borderColor: color.danger, backgroundColor: color.dangerSoft },
  stampText: {
    ...mono(700),
    fontSize: font.heading,
    letterSpacing: 1.5,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
  },
  identityText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  ref: {
    ...mono(600),
    color: color.textDim,
    fontSize: font.tiny + 1,
    letterSpacing: 0.4,
  },
  origin: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
  open: {
    // Deliberately not Superade Yellow: the one lit action on this screen is
    // Start (The Signal Rule), so the escape hatch stays quiet.
    ...sans(600),
    color: color.textDim,
    fontSize: font.tiny + 1,
  },
  title: {
    ...sans(600),
    fontSize: font.title,
    lineHeight: 23,
    letterSpacing: -0.3,
  },
  pills: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  body: {
    gap: space.sm + 2,
  },
  description: {
    ...sans(400),
    color: color.body,
    fontSize: font.body + 1,
    lineHeight: 20,
  },
  noDescription: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.body,
    fontStyle: 'italic',
  },
  briefBlock: {
    backgroundColor: color.bgSunken,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.sm,
    gap: 3,
  },
  briefLabel: {
    ...monoLabel(8),
    color: color.label,
  },
  brief: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: 17,
  },
  facts: {
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
    paddingTop: space.sm,
  },
  fact: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro + 0.5,
  },
})
