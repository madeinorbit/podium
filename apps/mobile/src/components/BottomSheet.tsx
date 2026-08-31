import * as Haptics from 'expo-haptics'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Dimensions, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets'
import { useKeyboardHeight } from '../hooks/useKeyboardHeight'
import { alpha } from '../theme/mix'
import { color, elevation, radius, space, spring } from '../theme/theme'

/**
 * THE ONE BOTTOM SHEET.
 *
 * Every overlay that rises from the bottom edge on this app — the action menus,
 * the new-work picker, the colour picker, the task inspector — is this
 * component. It was three implementations before [POD-724]: `ActionSheet` tracked
 * a downward finger against a hard-coded 320pt travel, `TaskSheet` ran a proper
 * two-detent rubber-banded drag, and `TaskPeekSheet` had `animationType="slide"`
 * and no gesture at all, so the same grab pill meant three different things
 * depending on which surface you had opened. A modal you can drag on one screen
 * and cannot on the next is not a modal with a bug; it is two objects wearing
 * one costume.
 *
 * Two shapes, one physics:
 *
 *  - `fit` — the sheet is as tall as its content (menus, pickers). One detent.
 *    Travel is MEASURED, not assumed, so a two-row menu and a ten-row menu both
 *    open from exactly their own height and dismiss on the same third-of-travel.
 *  - `detented` — a fixed span with medium and large stops (the task inspector).
 *    The scroll is locked below large and the CONTENT carries its own copy of
 *    the drag, so a finger on the text promotes the sheet first and only then
 *    scrolls — the iOS rule that makes a two-detent sheet read as one surface
 *    instead of a window with a list glued inside it. Both halves are load-
 *    bearing: with only the lock, a long task's inspector answers no finger at
 *    all below large [POD-1358].
 *
 * Both honour the system Reduce Motion setting, pay the bottom safe area, and
 * dismiss on backdrop tap, on a drag past a third of the current travel, or on
 * a downward flick.
 */

export type SheetDetent = 'medium' | 'large'

/** Where the large detent stops — far enough down to leave the status bar. */
const TOP_GAP = 10
/** Fraction of the screen the medium detent shows. */
const MEDIUM_FRACTION = 0.52
/** Past this velocity the flick decides, not the position. */
const FLICK_VELOCITY = 500
/** Fallback travel before the first layout measurement lands (fit mode). */
const ASSUMED_FIT_HEIGHT = 320

const SHEET_SPRING = {
  ...spring.snappy,
  reduceMotion: ReduceMotion.System,
}

function impactLight() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
}

export function BottomSheet({
  visible,
  onClose,
  mode = 'fit',
  accent,
  head,
  children,
  footer,
  footerRule = true,
  scrollable,
  contentStyle,
  testID,
  accessibilityLabel,
}: {
  visible: boolean
  onClose: () => void
  mode?: 'fit' | 'detented'
  /** Issue colour for the top hairline — the sheet's one tinted edge. */
  accent?: string | undefined
  /**
   * The fixed region above the scroll: grabber, identity, primary controls.
   * The whole region is the drag handle, so it must stay bounded — nothing
   * data-sized belongs here.
   */
  head?: ReactNode
  children: ReactNode
  /** Pinned below the scroll. In `detented` mode it appears only at large,
   *  where the surface it acts on is actually readable. */
  footer?: ReactNode
  /** Hairline between the scroll and the footer. Off where the footer is itself
   *  an inset control (a Cancel capsule) and the rule would cut the inset. */
  footerRule?: boolean
  /** `fit` mode: put the content in a scroll view capped at 60% of the screen. */
  scrollable?: boolean
  contentStyle?: object
  testID?: string
  accessibilityLabel?: string
}) {
  const insets = useSafeAreaInsets()
  // The sheet lives in a Modal with absolute geometry — no KeyboardAvoidingView
  // can reach it, so the keyboard's overlap is paid directly: detented sheets
  // lift their footer (the comment composer) by padding, fit sheets rise
  // bodily. [2026-08-28 device feedback: peek-task comments typed blind.]
  const keyboardHeight = useKeyboardHeight()
  const screenH = Dimensions.get('window').height
  const top = insets.top + TOP_GAP
  const span = screenH - top
  const MEDIUM = Math.round(screenH * (1 - MEDIUM_FRACTION)) - top

  // Fit mode measures its own height so the open/close travel is the sheet's
  // real one; detented mode's travel is its span by construction.
  const [fitHeight, setFitHeight] = useState(ASSUMED_FIT_HEIGHT)
  const closed = mode === 'detented' ? span : fitHeight
  const rest = mode === 'detented' ? MEDIUM : 0
  // The travel a fit sheet opens from is its MEASURED height, and the first
  // measurement lands one frame after mount. Reading it through a ref keeps that
  // arrival out of the open effect's dependencies: keying the effect on `closed`
  // meant the sheet re-seated itself at its closed position the instant it
  // measured, which the operator sees as a second slide.
  const closedRef = useRef(closed)
  closedRef.current = closed

  const y = useSharedValue(closed)
  const dragStart = useSharedValue(closed)
  const detent = useSharedValue<SheetDetent>('medium')
  const [atLarge, setAtLarge] = useState(mode !== 'detented')
  const [mounted, setMounted] = useState(false)

  const commitAtLarge = useCallback((next: boolean) => setAtLarge(next), [])
  const finishClose = useCallback(() => {
    setMounted(false)
    onClose()
  }, [onClose])

  const settleOnUI = useCallback(
    (to: SheetDetent | 'closed', velocity = 0) => {
      'worklet'
      const target = to === 'large' ? 0 : to === 'medium' ? rest : closed
      const changed = to !== 'closed' && detent.get() !== to
      if (to !== 'closed') detent.set(to)
      scheduleOnRN(commitAtLarge, mode !== 'detented' || to === 'large')
      if (changed) scheduleOnRN(impactLight)
      y.set(
        withSpring(target, { ...SHEET_SPRING, velocity }, (finished) => {
          'worklet'
          if (finished && to === 'closed') {
            scheduleOnRN(finishClose)
          }
        }),
      )
    },
    [closed, commitAtLarge, detent, finishClose, mode, rest, y],
  )

  const settle = useCallback(
    (to: SheetDetent | 'closed', velocity = 0) => {
      scheduleOnUI(settleOnUI, to, velocity)
    },
    [settleOnUI],
  )

  // Open on `visible`, close on its withdrawal. Keyed on `visible` alone —
  // `settle` changes identity with every detent, and depending on it would
  // re-seat an open sheet at its resting stop each time it moved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!visible) {
      if (mounted) settle('closed')
      return
    }
    setMounted(true)
    const initialDetent = mode === 'detented' ? 'medium' : 'large'
    detent.set(initialDetent)
    y.set(closedRef.current)
    const raf = requestAnimationFrame(() => settle(initialDetent))
    return () => cancelAnimationFrame(raf)
  }, [visible])

  /**
   * One physics, two detectors. The head and the CONTENT must answer a finger
   * the same way, but Gesture Handler refuses to mount one gesture instance in
   * two detectors, so the handlers live here and each detector calls them.
   *
   * They stay OUT of the hook configs as plain calls: the worklets Babel plugin
   * workletizes whatever object literal a gesture hook is handed, and it rejects
   * both a spread and a shared config object — so the two literals below are
   * written out, and only their bodies are shared.
   */
  const beginDrag = useCallback(() => {
    'worklet'
    cancelAnimation(y)
    dragStart.set(y.get())
  }, [dragStart, y])

  const moveDrag = useCallback(
    (translationY: number) => {
      'worklet'
      const raw = dragStart.get() + translationY
      // Rubber-band above the top stop: the sheet can be pulled past it, but at
      // a fraction of the finger, so the stop is felt rather than merely obeyed.
      y.set(raw < 0 ? raw * 0.38 : raw)
    },
    [dragStart, y],
  )

  /**
   * Where a released finger settles. `tapToggles` is the only thing the head
   * and the content disagree about: a press that never travelled is the
   * grabber's toggle up there, and the row's own press down here.
   */
  const endDrag = useCallback(
    (
      event: {
        canceled: boolean
        translationX: number
        translationY: number
        velocityY: number
      },
      tapToggles: boolean,
    ) => {
      'worklet'
      const { canceled, translationX, translationY, velocityY } = event
      if (canceled) return settleOnUI(detent.get())
      // A pointer that travelled a few pixels before release still counts as the
      // grabber's tap.
      if (Math.abs(translationY) < 6 && Math.abs(translationX) < 6) {
        if (!tapToggles || mode !== 'detented') return
        return settleOnUI(detent.get() === 'large' ? 'medium' : 'large')
      }
      if (velocityY > FLICK_VELOCITY) {
        return settleOnUI(
          mode === 'detented' && detent.get() === 'large' ? 'medium' : 'closed',
          velocityY,
        )
      }
      if (velocityY < -FLICK_VELOCITY) return settleOnUI('large', velocityY)
      const raw = dragStart.get() + translationY
      const at = raw < 0 ? raw * 0.38 : raw
      if (mode !== 'detented') {
        return settleOnUI(at > closed / 3 ? 'closed' : 'large', velocityY)
      }
      const stops = [
        ['large', Math.abs(at)],
        ['medium', Math.abs(at - rest)],
        ['closed', Math.abs(at - closed)],
      ] as const
      settleOnUI([...stops].sort((a, b) => a[1] - b[1])[0][0], velocityY)
    },
    [closed, detent, dragStart, mode, rest, settleOnUI],
  )

  const pan = usePanGesture({
    // Gesture Handler owns the pointer stream inside a Modal on react-native-web;
    // RN's own responder system never sees it there, even though it works on iOS.
    activeOffsetY: mode === 'detented' ? [-4, 4] : 4,
    failOffsetX: [-4, 4],
    onActivate: () => {
      'worklet'
      beginDrag()
    },
    onUpdate: (event) => {
      'worklet'
      moveDrag(event.translationY)
    },
    onDeactivate: (event) => {
      'worklet'
      endDrag(event, true)
    },
  })

  /** The content's own detector — live only while the scroll under it is
   *  locked, so it can never stand between a finger and a scrollbar. */
  const contentPan = usePanGesture({
    enabled: mode === 'detented' && !atLarge,
    activeOffsetY: [-4, 4],
    failOffsetX: [-4, 4],
    onActivate: () => {
      'worklet'
      beginDrag()
    },
    onUpdate: (event) => {
      'worklet'
      moveDrag(event.translationY)
    },
    onDeactivate: (event) => {
      'worklet'
      endDrag(event, false)
    },
  })

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      y.get(),
      [0, Math.max(1, closed)],
      [mode === 'detented' ? 0.45 : 0.55, 0],
      Extrapolation.CLAMP,
    ),
  }))

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: y.get() }],
  }))

  if (!mounted) return null

  const body = scrollable ? (
    <ScrollView
      style={styles.fitScroll(screenH)}
      contentContainerStyle={contentStyle}
      showsVerticalScrollIndicator={false}
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
    >
      {children}
    </ScrollView>
  ) : mode === 'detented' ? (
    // THE PROMOTE HALF (POD-1358). Locking the scroll below large is only half
    // the iOS rule; the other half is that the drag which cannot scroll yet
    // raises the sheet instead. Without this detector the content answered
    // nothing at all at medium — on a long task the inspector showed its first
    // screenful and every finger on it died, which is what "unscrollable" was.
    // At large the detector stands down (disabled, and `pan-y` handed back to
    // the browser) so the scroll it just unlocked is the one the finger gets.
    <GestureDetector
      gesture={contentPan}
      touchAction={atLarge ? 'pan-y' : 'none'}
      userSelect="none"
    >
      <View style={styles.flex}>
        <ScrollView
          style={styles.flex}
          scrollEnabled={atLarge}
          contentContainerStyle={[{ paddingBottom: space.xl }, contentStyle]}
          automaticallyAdjustKeyboardInsets
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
        >
          {children}
        </ScrollView>
      </View>
    </GestureDetector>
  ) : (
    <View style={contentStyle}>{children}</View>
  )

  return (
    <Modal transparent visible animationType="none" onRequestClose={() => settle('closed')}>
      <Animated.View
        testID={testID ? `${testID}-backdrop` : undefined}
        style={[styles.backdrop, backdropStyle]}
        pointerEvents="none"
      />
      <Pressable
        accessibilityLabel="Close"
        style={StyleSheet.absoluteFill}
        onPress={() => settle('closed')}
      />
      <Animated.View
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        style={[
          styles.sheet,
          elevation.raised,
          mode === 'detented'
            ? { top, height: span, paddingBottom: keyboardHeight }
            : {
                bottom: keyboardHeight,
                paddingBottom: keyboardHeight > 0 ? space.md : insets.bottom + space.md,
              },
          accent ? { borderTopColor: alpha(accent, 0.45), borderTopWidth: 1 } : null,
          sheetStyle,
        ]}
        onLayout={
          mode === 'fit'
            ? (e) => {
                const h = Math.round(e.nativeEvent.layout.height)
                if (h > 0 && Math.abs(h - fitHeight) > 1) setFitHeight(h)
              }
            : undefined
        }
      >
        <GestureDetector gesture={pan} touchAction="none" userSelect="none">
          <View
            {...(mode === 'detented' ? { accessibilityRole: 'adjustable' as const } : {})}
            accessibilityLabel={
              mode === 'detented'
                ? atLarge
                  ? 'Collapse the sheet'
                  : 'Expand the sheet'
                : undefined
            }
            accessibilityActions={
              mode === 'detented'
                ? [
                    { name: 'increment', label: 'Expand' },
                    { name: 'decrement', label: 'Collapse' },
                  ]
                : undefined
            }
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === 'increment') settle('large')
              if (event.nativeEvent.actionName === 'decrement') settle('medium')
            }}
            style={styles.dragRegion}
          >
            <View style={styles.grabberBox}>
              <View style={styles.grabber} />
            </View>
            {head}
          </View>
        </GestureDetector>

        {body}

        {footer && atLarge ? <View style={footerRule ? styles.footer : null}>{footer}</View> : null}
      </Animated.View>
    </Modal>
  )
}

/** Close the sheet, then run the action — so the action's own navigation or
 *  sheet never races the dismissal animation. */
export function dismissThen(onClose: () => void, action: () => void): () => void {
  return () => {
    onClose()
    action()
  }
}

const styles = {
  ...StyleSheet.create({
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: '#000',
    },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      backgroundColor: color.bg,
      borderTopLeftRadius: radius.xl + 4,
      borderTopRightRadius: radius.xl + 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.borderStrong,
      overflow: 'hidden',
    },
    // A drag must never leave a trail of selected text behind it.
    dragRegion: Platform.OS === 'web' ? ({ userSelect: 'none' } as object) : {},
    grabberBox: { height: 24, alignItems: 'center', justifyContent: 'center' },
    grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: color.borderStrong },
    flex: { flex: 1 },
    footer: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: alpha(color.border, 0.7),
    },
  }),
  /** A fit sheet never eats the whole screen: past 60% its content scrolls. */
  fitScroll: (screenH: number) => ({ maxHeight: Math.round(screenH * 0.6) }),
}
