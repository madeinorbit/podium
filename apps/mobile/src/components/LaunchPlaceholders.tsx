import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { color, radius, space } from '../theme/theme'

/**
 * Paint content in its final flex frame while a page-shaped placeholder sits
 * above it. When readiness resolves, only opacity moves: rows can materialize
 * behind the opaque placeholder without pushing the shell during the handoff.
 * Readiness is latched so a reconnect never resurrects first-launch chrome.
 */
export function BootstrapCrossfade({
  resolved,
  placeholder,
  children,
}: {
  resolved: boolean
  placeholder: ReactNode
  children: ReactNode
}) {
  const reduceMotion = useReduceMotion()
  const everResolved = useRef(resolved)
  if (resolved) everResolved.current = true
  const settled = everResolved.current
  const [showPlaceholder, setShowPlaceholder] = useState(!settled)
  const contentOpacity = useRef(new Animated.Value(settled ? 1 : 0)).current
  const placeholderOpacity = useRef(new Animated.Value(settled ? 0 : 1)).current

  useEffect(() => {
    if (!settled) return
    if (reduceMotion) {
      contentOpacity.setValue(1)
      placeholderOpacity.setValue(0)
      setShowPlaceholder(false)
      return
    }
    Animated.parallel([
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 160,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(placeholderOpacity, {
        toValue: 0,
        duration: 160,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) setShowPlaceholder(false)
    })
  }, [contentOpacity, placeholderOpacity, reduceMotion, settled])

  return (
    <View style={styles.fill} accessibilityState={{ busy: !settled }}>
      <Animated.View
        pointerEvents={settled ? 'auto' : 'none'}
        importantForAccessibility={settled ? 'auto' : 'no-hide-descendants'}
        style={[styles.fill, { opacity: contentOpacity }]}
      >
        {children}
      </Animated.View>
      {showPlaceholder ? (
        <Animated.View
          pointerEvents="auto"
          testID="bootstrap-placeholder"
          style={[
            StyleSheet.absoluteFill,
            styles.placeholderLayer,
            { opacity: placeholderOpacity },
          ]}
        >
          {placeholder}
        </Animated.View>
      ) : null}
    </View>
  )
}

function Bar({ width = '70%', height = 9 }: { width?: `${number}%`; height?: number }) {
  return <View style={[styles.bar, { width, height }]} />
}

function SectionRule({ width = '28%' }: { width?: `${number}%` }) {
  return (
    <View style={styles.sectionRule}>
      <Bar width={width} height={7} />
      <View style={styles.rule} />
    </View>
  )
}

function Row({ compact = false }: { compact?: boolean }) {
  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      <View style={styles.square} />
      <View style={styles.lines}>
        <Bar width="72%" />
        <Bar width="39%" height={7} />
      </View>
    </View>
  )
}

export function WorkSkeleton() {
  return (
    <View style={styles.page} accessibilityLabel="Loading work">
      <SectionRule width="20%" />
      <Row compact />
      <Row compact />
      <SectionRule width="34%" />
      <Row compact />
      <Row compact />
    </View>
  )
}

export function TasksSkeleton() {
  return (
    <View style={styles.page} accessibilityLabel="Loading tasks">
      <SectionRule width="27%" />
      <Row />
      <Row />
      <SectionRule width="18%" />
      <Row />
    </View>
  )
}

export function DetailSkeleton() {
  return (
    <View style={styles.detailPage} accessibilityLabel="Loading task detail">
      <View style={styles.pills}>
        <View style={styles.pill} />
        <View style={styles.pillShort} />
        <View style={styles.pillShort} />
      </View>
      <View style={styles.prose}>
        <Bar width="91%" />
        <Bar width="84%" />
        <Bar width="58%" />
      </View>
      <SectionRule width="30%" />
      <Row />
      <Row />
      <SectionRule width="25%" />
    </View>
  )
}

export function TranscriptSkeleton() {
  return (
    <View style={styles.transcriptPage} accessibilityLabel="Loading transcript">
      <View style={[styles.bubble, styles.bubbleAssistant]}>
        <Bar width="88%" />
        <Bar width="73%" />
        <Bar width="46%" />
      </View>
      <View style={[styles.bubble, styles.bubbleUser]}>
        <Bar width="78%" />
        <Bar width="44%" />
      </View>
      <View style={[styles.bubble, styles.bubbleAssistant, styles.bubbleDim]}>
        <Bar width="69%" />
        <Bar width="51%" />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  placeholderLayer: { backgroundColor: color.bg },
  page: { flex: 1, paddingTop: space.sm },
  bar: { borderRadius: radius.xs, backgroundColor: color.elevated },
  sectionRule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: 5,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: color.hairline },
  row: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.sm + 2,
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  rowCompact: { minHeight: 62, backgroundColor: color.bg },
  square: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: color.elevated },
  lines: { flex: 1, gap: 8 },
  detailPage: { flex: 1, paddingTop: space.md },
  pills: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
  pill: { width: 88, height: 24, borderRadius: radius.full, backgroundColor: color.elevated },
  pillShort: { width: 54, height: 24, borderRadius: radius.full, backgroundColor: color.elevated },
  prose: { gap: 10, paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.sm },
  transcriptPage: { flex: 1, padding: space.lg, gap: space.lg, backgroundColor: color.engraved },
  bubble: { gap: 10, padding: space.md, borderRadius: radius.lg },
  bubbleAssistant: { width: '84%', backgroundColor: color.surface },
  bubbleUser: { width: '69%', alignSelf: 'flex-end', backgroundColor: color.userBubble },
  bubbleDim: { opacity: 0.58 },
})
