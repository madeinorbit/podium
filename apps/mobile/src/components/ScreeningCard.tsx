import { relativeTime } from '@podium/client-core/focus'
import type { IssueWire } from '@podium/model'
import * as Haptics from 'expo-haptics'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { FLOW_HEX, flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import {
  color,
  elevation,
  font,
  leading,
  mono,
  monoLabel,
  radius,
  sans,
  space,
} from '../theme/theme'
import { IdSquare } from './IdSquare'
import { PressableScale } from './PressableScale'
import { Pill } from './ui'

/** Horizontal travel that commits a swipe (a flick past it also commits). */
const COMMIT_PX = 96
const FLICK_VELOCITY_X = 450
const EXIT_Y = 40
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1)

function decisionHaptic() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {})
}

export type ScreeningGesture = 'accepted' | 'declined' | 'skipped'

/**
 * One proposal, as a decidable card [POD-277].
 *
 * Carries enough to decide cold — identity square, repo, age, title, type /
 * priority / blocker pills, the human summary, the agent brief, and the launch
 * facts a start would use (agent, model, branch base). Dragging right stamps
 * START in bisque (the one primary-action signal), left stamps WON'T
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
  const { width } = useWindowDimensions()
  const reduceMotion = useReduceMotion()
  const translateX = useSharedValue(0)
  const translateY = useSharedValue(0)
  const dragStartX = useSharedValue(0)
  const dragStartY = useSharedValue(0)
  const exitOpacity = useSharedValue(1)
  const decided = useSharedValue(false)

  const pan = usePanGesture({
    // Taps (Open task) pass through; a vertical move fails before this
    // horizontal gesture can take the pointer stream.
    activeOffsetX: [-6, 6],
    failOffsetY: [-6, 6],
    onActivate: () => {
      'worklet'
      if (decided.get()) return
      cancelAnimation(translateX)
      cancelAnimation(translateY)
      dragStartX.set(translateX.get())
      dragStartY.set(translateY.get())
    },
    onUpdate: (event) => {
      'worklet'
      if (decided.get()) return
      translateX.set(dragStartX.get() + event.translationX)
      translateY.set(dragStartY.get() + event.translationY * 0.25)
    },
    onDeactivate: (event) => {
      'worklet'
      if (decided.get()) return

      if (event.canceled) {
        translateX.set(
          withSpring(0, {
            duration: 400,
            dampingRatio: 0.8,
            velocity: event.velocityX,
            reduceMotion: ReduceMotion.System,
          }),
        )
        translateY.set(
          withSpring(0, {
            duration: 400,
            dampingRatio: 0.8,
            velocity: event.velocityY * 0.25,
            reduceMotion: ReduceMotion.System,
          }),
        )
        return
      }

      const x = translateX.get()
      const distanceCommits = Math.abs(x) > COMMIT_PX
      const velocityCommits =
        !distanceCommits && Math.abs(event.velocityX) > FLICK_VELOCITY_X
      const commits = distanceCommits || velocityCommits
      if (!commits) {
        translateX.set(
          withSpring(0, {
            duration: 400,
            dampingRatio: 0.8,
            velocity: event.velocityX,
            reduceMotion: ReduceMotion.System,
          }),
        )
        translateY.set(
          withSpring(0, {
            duration: 400,
            dampingRatio: 0.8,
            velocity: event.velocityY * 0.25,
            reduceMotion: ReduceMotion.System,
          }),
        )
        return
      }

      const direction = distanceCommits ? Math.sign(x) : Math.sign(event.velocityX)
      const exitVelocityX = direction * event.velocityX > 0 ? event.velocityX : 0
      const gesture: ScreeningGesture = direction > 0 ? 'accepted' : 'declined'
      decided.set(true)
      scheduleOnRN(decisionHaptic)

      if (reduceMotion) {
        exitOpacity.set(
          withTiming(
            0,
            { duration: 150, easing: EASE_OUT, reduceMotion: ReduceMotion.Never },
            (finished) => {
              if (finished) scheduleOnRN(onDecide, gesture)
            },
          ),
        )
        return
      }

      translateY.set(
        withSpring(EXIT_Y, {
          duration: 300,
          dampingRatio: 1,
          velocity: event.velocityY * 0.25,
          overshootClamping: true,
          reduceMotion: ReduceMotion.System,
        }),
      )
      translateX.set(
        withSpring(
          direction * width * 1.3,
          {
            duration: 300,
            dampingRatio: 1,
            velocity: exitVelocityX,
            overshootClamping: true,
            reduceMotion: ReduceMotion.System,
          },
          (finished) => {
            if (finished) scheduleOnRN(onDecide, gesture)
          },
        ),
      )
    },
  })

  const hex = issueColorHex(issue.color) ?? FLOW_HEX
  const now = Date.now()
  const cardStyle = useAnimatedStyle(() => ({
    opacity: exitOpacity.get(),
    transform: [
      { translateX: translateX.get() },
      { translateY: translateY.get() },
      {
        rotate: `${interpolate(
          translateX.get(),
          [-width, 0, width],
          [-9, 0, 9],
          Extrapolation.CLAMP,
        )}deg`,
      },
    ],
  }))
  const acceptStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.get(), [0, COMMIT_PX], [0, 1], Extrapolation.CLAMP),
  }))
  const declineStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.get(), [-COMMIT_PX, 0], [1, 0], Extrapolation.CLAMP),
  }))
  const blockers = issue.blockedByNotes.length
  const openChildren = Math.max(0, issue.childCount - issue.childDoneCount)
  const brief = issue.brief?.trim()
  const description = issue.description.trim()
  const modelBits = [issue.defaultAgent, issue.defaultModel, issue.defaultEffort]
    .filter((bit) => bit && bit !== 'auto')
    .join(' · ')

  return (
    <GestureDetector gesture={pan} touchAction="none" userSelect="none">
      <Animated.View
        testID="screening-card"
        accessibilityLabel={`Proposal ${issue.displayRef ?? `#${issue.seq}`}: ${issue.title}`}
        style={[
          styles.card,
          elevation.raised,
          { backgroundColor: flow.rowBg(hex), borderColor: alpha(hex, 0.35) },
          cardStyle,
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[styles.stamp, styles.stampLeft, styles.stampAccept, acceptStyle]}
        >
          <Text style={[styles.stampText, { color: color.accentTint }]}>START</Text>
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[styles.stamp, styles.stampRight, styles.stampDecline, declineStyle]}
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
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Open task ${issue.displayRef ?? `#${issue.seq}`}`}
            onPress={onOpen}
            hitSlop={10}
          >
            <Text style={styles.open}>Open ↗</Text>
          </PressableScale>
        </View>

        <Text style={[styles.title, { color: flow.text(hex) }]} numberOfLines={3}>
          {issue.title}
        </Text>

        <View style={styles.pills}>
          <Pill label={issue.type} />
          <Pill
            label={`P${issue.priority}`}
            toneKey={issue.priority <= 1 ? 'needsYou' : undefined}
          />
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
    </GestureDetector>
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
    fontSize: font.tiny,
    letterSpacing: 0.4,
  },
  origin: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
  open: {
    // Deliberately not the accent: the one lit action on this screen is
    // Start (The Signal Rule), so the escape hatch stays quiet.
    ...sans(600),
    color: color.textDim,
    fontSize: font.tiny,
  },
  title: {
    ...sans(600),
    fontSize: font.title,
    lineHeight: leading(font.body),
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
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
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
    ...monoLabel(),
    color: color.label,
  },
  brief: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
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
    fontSize: font.micro,
  },
})
