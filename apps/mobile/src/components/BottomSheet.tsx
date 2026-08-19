import * as Haptics from 'expo-haptics'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  Animated,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReduceMotion } from '../hooks/useReduceMotion'
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
 * Both honour Reduce Motion (softer settle, no snap overshoot), pay the bottom
 * safe area, and dismiss on backdrop tap, on a drag past a third of the current
 * travel, or on a downward flick.
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
  const reduceMotion = useReduceMotion()
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

  const y = useRef(new Animated.Value(closed)).current
  const yValue = useRef(closed)
  const detent = useRef<SheetDetent>('medium')
  const [atLarge, setAtLarge] = useState(mode !== 'detented')
  const [mounted, setMounted] = useState(false)
  const dragStart = useRef(closed)

  useEffect(() => {
    const id = y.addListener(({ value }) => {
      yValue.current = value
    })
    return () => y.removeListener(id)
  }, [y])

  const settle = useCallback(
    (to: SheetDetent | 'closed') => {
      const target = to === 'large' ? 0 : to === 'medium' ? rest : closed
      const changed = to !== 'closed' && detent.current !== to
      if (to !== 'closed') detent.current = to
      setAtLarge(mode !== 'detented' || to === 'large')
      if (changed) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
      Animated.spring(y, {
        // JS driver on purpose: the drag below feeds this same node through
        // Animated.Value.setValue, which a native-driven node rejects.
        useNativeDriver: false,
        toValue: target,
        ...(reduceMotion ? spring.smooth : spring.snappy),
      }).start(({ finished }) => {
        if (finished && to === 'closed') {
          setMounted(false)
          onClose()
        }
      })
    },
    [closed, mode, onClose, reduceMotion, rest, y],
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
    detent.current = mode === 'detented' ? 'medium' : 'large'
    y.setValue(closedRef.current)
    const raf = requestAnimationFrame(() => settle(detent.current))
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
  const beginDrag = () => {
    y.stopAnimation()
    dragStart.current = yValue.current
  }

  const moveDrag = (translationY: number) => {
    const raw = dragStart.current + translationY
    // Rubber-band above the top stop: the sheet can be pulled past it, but at
    // a fraction of the finger, so the stop is felt rather than merely obeyed.
    y.setValue(raw < 0 ? raw * 0.38 : raw)
  }

  /**
   * Where a released finger settles. `tapToggles` is the only thing the head
   * and the content disagree about: a press that never travelled is the
   * grabber's toggle up there, and the row's own press down here.
   */
  const endDrag = (
    event: {
      canceled: boolean
      translationX: number
      translationY: number
      velocityY: number
    },
    tapToggles: boolean,
  ) => {
    const { canceled, translationX, translationY, velocityY } = event
    if (canceled) return settle(detent.current)
    // A pointer that travelled a few pixels before release still counts as the
    // grabber's tap.
    if (Math.abs(translationY) < 6 && Math.abs(translationX) < 6) {
      if (!tapToggles || mode !== 'detented') return
      return settle(detent.current === 'large' ? 'medium' : 'large')
    }
    if (velocityY > FLICK_VELOCITY) {
      return settle(mode === 'detented' && detent.current === 'large' ? 'medium' : 'closed')
    }
    if (velocityY < -FLICK_VELOCITY) return settle('large')
    const raw = dragStart.current + translationY
    const at = raw < 0 ? raw * 0.38 : raw
    if (mode !== 'detented') return settle(at > closed / 3 ? 'closed' : 'large')
    const stops = [
      ['large', Math.abs(at)],
      ['medium', Math.abs(at - rest)],
      ['closed', Math.abs(at - closed)],
    ] as const
    settle([...stops].sort((a, b) => a[1] - b[1])[0][0])
  }

  const pan = usePanGesture({
    // Gesture Handler owns the pointer stream inside a Modal on react-native-web;
    // RN's own responder system never sees it there, even though it works on iOS.
    activeOffsetY: mode === 'detented' ? [-4, 4] : 4,
    failOffsetX: [-4, 4],
    runOnJS: true,
    onActivate: () => beginDrag(),
    onUpdate: (event) => moveDrag(event.translationY),
    onDeactivate: (event) => endDrag(event, true),
  })

  /** The content's own detector — live only while the scroll under it is
   *  locked, so it can never stand between a finger and a scrollbar. */
  const contentPan = usePanGesture({
    enabled: mode === 'detented' && !atLarge,
    activeOffsetY: [-4, 4],
    failOffsetX: [-4, 4],
    runOnJS: true,
    onActivate: () => beginDrag(),
    onUpdate: (event) => moveDrag(event.translationY),
    onDeactivate: (event) => endDrag(event, false),
  })

  if (!mounted) return null

  const dim = y.interpolate({
    inputRange: [0, Math.max(1, closed)],
    outputRange: [mode === 'detented' ? 0.45 : 0.55, 0],
    extrapolate: 'clamp',
  })

  const body = scrollable ? (
    <ScrollView
      style={styles.fitScroll(screenH)}
      contentContainerStyle={contentStyle}
      showsVerticalScrollIndicator={false}
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
      <Animated.View style={[styles.backdrop, { opacity: dim }]} pointerEvents="none" />
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
            ? { top, height: span }
            : { bottom: 0, paddingBottom: insets.bottom + space.md },
          accent ? { borderTopColor: alpha(accent, 0.45), borderTopWidth: 1 } : null,
          { transform: [{ translateY: y }] },
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
