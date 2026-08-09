import { relativeTime, withoutShells } from '@podium/client-core/focus'
import {
  groupRelations,
  operationalState,
  presenceNote,
  sessionNeedsHuman,
  sessionTitle,
  subIssuesOf,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { Check, ChevronDown, ExternalLink } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { FLOW_SLATE, issueColorHex } from '../theme/issueColors'
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
  spring,
  tracking,
} from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { kindTone } from './spine'

/**
 * The task inspector as ONE sheet with TWO detents [POD-592].
 *
 * Medium is the peek: identity, the decision band, and the beginning of the
 * scroll. Large is the whole inspector plus the comment composer. There is no
 * second full-screen task page — everything the old `/issue/[id]` showed lives
 * in the large detent, which is what makes this one object rather than a glance
 * that hands off to a page.
 *
 * THE SCROLL IS LOCKED AT MEDIUM. Dragging the content upward promotes the
 * sheet to large first, and only then does the scroll take over. That is the
 * standard iOS rule and the thing that makes a two-detent sheet feel like one
 * surface; without it the sheet and its scroll fight for the same gesture and
 * the sheet reads as a window with a list glued inside it.
 *
 * On native this should become a real `formSheet` with system detents once
 * POD-501 lands the platform-split navigator; the geometry and the vocabulary
 * here are the fallback that the PWA keeps either way.
 */

export type Detent = 'medium' | 'large' | 'closed'

/** Where the large detent stops — far enough down to leave the status bar. */
const TOP_GAP = 10
/** Fraction of the screen the medium detent shows. */
const MEDIUM_FRACTION = 0.52
/** Past this velocity the flick decides, not the position. */
const FLICK = 0.5

export function TaskSheet({
  issue,
  issues,
  sessions,
  onClose,
  onOpenSession,
}: {
  issue: IssueWire | null
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  onClose: () => void
  onOpenSession: (session: SessionMeta) => void
}) {
  const insets = useSafeAreaInsets()
  const reduceMotion = useReduceMotion()
  const screenH = Dimensions.get('window').height
  const top = insets.top + TOP_GAP
  const span = screenH - top
  const MEDIUM = Math.round(screenH * (1 - MEDIUM_FRACTION)) - top
  const CLOSED = span

  const y = useRef(new Animated.Value(CLOSED)).current
  const yValue = useRef(CLOSED)
  const detent = useRef<Detent>('medium')
  const [atLarge, setAtLarge] = useState(false)
  const [mounted, setMounted] = useState(false)
  const scrollTop = useRef(0)

  useEffect(() => {
    const id = y.addListener(({ value }) => {
      yValue.current = value
    })
    return () => y.removeListener(id)
  }, [y])

  const settle = useCallback(
    (to: Detent) => {
      const target = to === 'large' ? 0 : to === 'medium' ? MEDIUM : CLOSED
      const changed = detent.current !== to
      detent.current = to
      setAtLarge(to === 'large')
      if (changed && to !== 'closed') {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
      }
      Animated.spring(y, {
        toValue: target,
        // JS driver on purpose: the drag below feeds this same node through
        // `setValue`, which a native-driven node rejects.
        useNativeDriver: false,
        ...(reduceMotion ? spring.smooth : spring.snappy),
      }).start(({ finished }) => {
        if (finished && to === 'closed') {
          setMounted(false)
          onClose()
        }
      })
    },
    [CLOSED, MEDIUM, onClose, reduceMotion, y],
  )

  useEffect(() => {
    if (!issue) {
      if (mounted) settle('closed')
      return
    }
    setMounted(true)
    scrollTop.current = 0
    detent.current = 'closed'
    y.setValue(CLOSED)
    const raf = requestAnimationFrame(() => settle('medium'))
    return () => cancelAnimationFrame(raf)
    // Re-running on `issue` alone is deliberate: switching the peeked task
    // re-seats the sheet at medium rather than leaving it wherever it was.
  }, [issue?.id])

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claim on TOUCH-DOWN, so the head is a grab handle rather than a region
        // that only becomes one once the finger has already travelled. This is
        // also what makes the tap recognisable here: the release below decides
        // between "toggled the detent" and "dragged it".
        onStartShouldSetPanResponder: () => true,
        // CAPTURE, not bubble. A drag that begins on a Text node inside the head
        // never reaches the bubbling hook on react-native-web — the browser
        // starts a text selection instead, and the sheet simply does not move.
        onMoveShouldSetPanResponderCapture: (_e, g) => {
          if (Math.abs(g.dy) < 4 || Math.abs(g.dy) < Math.abs(g.dx)) return false
          // At large, the scroll owns downward drags until it is back at its top.
          if (detent.current === 'large' && g.dy > 0 && scrollTop.current > 0) return false
          return true
        },
        onPanResponderGrant: () => {
          y.stopAnimation()
          y.setOffset(yValue.current)
          y.setValue(0)
        },
        onPanResponderMove: (_e, g) => {
          // Rubber-band above the large detent: the sheet can be pulled past
          // its stop, but at a fraction of the finger, so the stop is felt.
          const raw = yValue.current + g.dy
          y.setValue(raw < 0 ? g.dy - (g.dy * -0.62 - g.dy) * 0 : g.dy)
          if (raw < 0) y.setValue(g.dy * 0.38)
        },
        onPanResponderRelease: (_e, g) => {
          y.flattenOffset()
          const at = yValue.current
          // A release that went nowhere is a TAP on the head: toggle the detent.
          // Costs nothing, and it is the only way through for a pointer that
          // cannot express a flick.
          if (Math.abs(g.dy) < 6 && Math.abs(g.dx) < 6) {
            return settle(detent.current === 'large' ? 'medium' : 'large')
          }
          if (g.vy > FLICK) return settle(detent.current === 'large' ? 'medium' : 'closed')
          if (g.vy < -FLICK) return settle('large')
          const d = [
            ['large', Math.abs(at - 0)],
            ['medium', Math.abs(at - MEDIUM)],
            ['closed', Math.abs(at - CLOSED)],
          ] as const
          settle([...d].sort((a, b) => a[1] - b[1])[0][0])
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [CLOSED, MEDIUM, settle, y],
  )

  if (!issue || !mounted) return null

  const hex = issueColorHex(issue.color) ?? FLOW_SLATE
  const backdrop = y.interpolate({
    inputRange: [0, CLOSED],
    outputRange: [0.45, 0],
    extrapolate: 'clamp',
  })

  return (
    <Modal transparent visible animationType="none" onRequestClose={() => settle('closed')}>
      <Animated.View style={[styles.backdrop, { opacity: backdrop }]} pointerEvents="none" />
      <Pressable
        accessibilityLabel="Close"
        style={StyleSheet.absoluteFill}
        onPress={() => settle('closed')}
      />
      <Animated.View
        style={[
          styles.sheet,
          elevation.raised,
          { top, height: span, transform: [{ translateY: y }], borderTopColor: alpha(hex, 0.45) },
        ]}
      >
        {/* ONE gesture surface for the whole head. A nested Pressable on the
            grabber would claim the responder on touch-down and the drag would
            never start — so the tap is recognised by the pan responder itself
            (a release that travelled almost nowhere) rather than by a second
            component competing for the same events. */}
        <View
          {...responder.panHandlers}
          accessibilityRole="adjustable"
          accessibilityLabel={atLarge ? 'Collapse the task' : 'Expand the task'}
          style={styles.dragRegion}
        >
          <View style={styles.grabberBox}>
            <View style={styles.grabber} />
          </View>
          <SheetHead issue={issue} sessions={sessions} issues={issues} hex={hex} />
        </View>

        <ScrollView
          style={styles.scroll}
          scrollEnabled={atLarge}
          onScroll={(e) => {
            scrollTop.current = e.nativeEvent.contentOffset.y
          }}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingBottom: space.xl }}
        >
          <SheetBody
            issue={issue}
            issues={issues}
            sessions={sessions}
            onOpenSession={onOpenSession}
          />
        </ScrollView>

        {/* The composer belongs to the large detent — at medium it would be a
            control for a surface you cannot yet read. */}
        {atLarge ? (
          <View style={[styles.composer, { paddingBottom: insets.bottom + space.sm }]}>
            <View style={styles.well}>
              <Text style={styles.wellHint}>Comment on this task…</Text>
            </View>
          </View>
        ) : null}
      </Animated.View>
    </Modal>
  )
}

/**
 * The fixed head — bounded BY CONSTRUCTION: a ref line, a title, one control
 * row and a one-line decision band. Nothing data-sized is allowed above the
 * scroll; the desktop dock became unscrollable the moment a stack of offer
 * cards was let into its fixed region.
 */
function SheetHead({
  issue,
  sessions,
  issues,
  hex,
}: {
  issue: IssueWire
  sessions: readonly SessionMeta[]
  issues: readonly IssueWire[]
  hex: string
}) {
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const mine = useMemo(
    () => withoutShells([...sessions]).filter((s) => s.issueId === issue.id && !s.archived),
    [sessions, issue.id],
  )
  const asking = mine.filter(sessionNeedsHuman)
  const op = operationalState(issue, mine, byId)
  const presence = presenceNote(issue, mine, byId)

  return (
    <View style={styles.head}>
      <View style={styles.identRow}>
        <Text style={[styles.chip, styles.chipRef]}>{issueDisplayRef(issue)}</Text>
        <Text
          style={[
            styles.chip,
            {
              borderColor: alpha(hex, 0.45),
              color: alpha(hex, 0.95),
              backgroundColor: alpha(hex, 0.12),
            },
          ]}
        >
          {issue.stage.replace('_', ' ')}
        </Text>
        <View style={styles.flex} />
        <Text style={styles.chip}>P{issue.priority}</Text>
      </View>

      <Text numberOfLines={2} style={styles.title}>
        {issue.title}
      </Text>

      <View style={styles.decide}>
        <PressableScale
          style={styles.stagePill}
          accessibilityLabel="Change stage"
          onPress={() => {}}
        >
          <Text style={styles.stagePillText}>
            {issue.stage.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())}
          </Text>
          <Icon as={ChevronDown} size={11} color={color.text} />
        </PressableScale>
        <PressableScale
          style={styles.primary}
          accessibilityLabel={asking.length ? 'Answer' : 'Run now'}
        >
          <Text style={styles.primaryText}>{asking.length > 0 ? 'Answer' : 'Run now'}</Text>
        </PressableScale>
      </View>

      {asking.length > 0 ? (
        <View style={styles.asking}>
          <Text style={styles.askingText}>
            <Text style={styles.askingLead}>
              {asking.length} agent{asking.length === 1 ? '' : 's'}{' '}
              {asking.length === 1 ? 'is' : 'are'} asking.
            </Text>{' '}
            {asking[0]?.offer?.message?.trim() || 'Open the transcript to answer.'}
          </Text>
        </View>
      ) : op.state === 'waiting' ? (
        <View style={[styles.asking, styles.blocked]}>
          <Text style={[styles.askingText, styles.blockedText]}>{op.label}</Text>
        </View>
      ) : presence ? (
        <Text style={styles.presence}>{presence.text}</Text>
      ) : null}
    </View>
  )
}

function SheetBody({
  issue,
  issues,
  sessions,
  onOpenSession,
}: {
  issue: IssueWire
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  onOpenSession: (s: SessionMeta) => void
}) {
  const children = useMemo(() => subIssuesOf(issues, issue.id), [issues, issue.id])
  const relations = useMemo(() => groupRelations(issue), [issue])
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const mine = useMemo(
    () =>
      withoutShells([...sessions])
        .filter((s) => s.issueId === issue.id && !s.archived)
        .sort((a, b) => {
          const an = sessionNeedsHuman(a)
          const bn = sessionNeedsHuman(b)
          if (an !== bn) return an ? -1 : 1
          return b.lastActiveAt.localeCompare(a.lastActiveAt)
        }),
    [sessions, issue.id],
  )
  const todos = issue.panel?.todos ?? []
  const done = todos.filter((t) => t.done).length
  const git = issue.gitState

  return (
    <View style={styles.body}>
      {/* The task in the author's own words, UNCAPPED — it sits in the scroll
          precisely so it can be. */}
      {issue.description.trim() ? <Text style={styles.prose}>{issue.description}</Text> : null}

      <Part
        title="Current update"
        meta={issue.notesUpdatedAt ? relativeTime(issue.notesUpdatedAt, Date.now()) : undefined}
      >
        <Text style={[styles.proseTight, issue.activityNotes ? null : styles.proseEmpty]}>
          {issue.activityNotes || 'No status posted yet.'}
        </Text>
      </Part>

      {todos.length > 0 ? (
        <Part title="Evidence & checks" meta={`${done} / ${todos.length}`}>
          {todos.map((todo) => (
            <View key={todo.text} style={styles.todo}>
              <View style={[styles.todoBox, todo.done ? styles.todoBoxDone : null]}>
                {todo.done ? <Icon as={Check} size={9} color="#fff" /> : null}
              </View>
              <Text style={[styles.todoText, todo.done ? styles.todoTextDone : null]}>
                {todo.text}
              </Text>
            </View>
          ))}
        </Part>
      ) : null}

      {children.length > 0 ? (
        <Part
          title="Subtasks"
          meta={`${children.filter((c) => c.stage === 'done').length} / ${children.length}`}
        >
          {children.map((child) => (
            <View key={child.id} style={styles.row}>
              <Text style={styles.rowRef}>{issueDisplayRef(child)}</Text>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {child.title}
              </Text>
            </View>
          ))}
        </Part>
      ) : null}

      {mine.length > 0 ? (
        <Part title="Agents & sessions" meta={String(mine.length)}>
          {mine.map((session) => {
            const tone = kindTone(session.agentKind)
            return (
              <PressableScale
                key={session.sessionId}
                onPress={() => onOpenSession(session)}
                style={styles.row}
              >
                <View style={[styles.kind, { backgroundColor: tone.bg }]}>
                  <Text style={[styles.kindCh, { color: tone.fg }]}>{tone.ch}</Text>
                </View>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {sessionTitle(session)}
                </Text>
                {sessionNeedsHuman(session) ? <View style={styles.dot} /> : null}
                <Text style={styles.rowStamp}>
                  {relativeTime(session.lastActiveAt, Date.now())}
                </Text>
              </PressableScale>
            )
          })}
        </Part>
      ) : null}

      {relations.length > 0 ? (
        <Part title="Relations" meta={String(relations.length)}>
          {relations.map((rel) => (
            <View key={rel.section} style={styles.row}>
              <Text style={styles.rowRef}>{rel.section}</Text>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {rel.entries
                  .map((entry) => {
                    const target = byId.get(entry.id)
                    return target ? issueDisplayRef(target) : entry.id.slice(0, 8)
                  })
                  .join(', ')}
              </Text>
            </View>
          ))}
        </Part>
      ) : null}

      {issue.branch ? (
        <Part title="Branch & worktree">
          <Text style={styles.branch}>{issue.branch}</Text>
          <Text style={styles.gitLine}>
            {git?.ahead ? `↑${git.ahead} · ` : ''}
            {git?.dirtyFiles ? `${git.dirtyFiles} dirty` : 'clean'}
            {issue.worktreePath
              ? ` · ${issue.worktreePath.replace(/^.*\/\.worktrees\//, '…/')}`
              : ''}
          </Text>
        </Part>
      ) : null}
    </View>
  )
}

function Part({
  title,
  meta,
  children,
}: {
  title: string
  meta?: string
  children: React.ReactNode
}) {
  return (
    <View style={styles.part}>
      <View style={styles.partHdr}>
        <Text style={styles.partTitle}>{title}</Text>
        <View style={styles.rule} />
        {meta ? <Text style={styles.partMeta}>{meta}</Text> : null}
      </View>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: '#000' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: color.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  // A drag must never leave a trail of selected text behind it.
  dragRegion: Platform.OS === 'web' ? ({ userSelect: 'none' } as object) : {},
  grabberBox: { height: 26, alignItems: 'center', justifyContent: 'center' },
  grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: color.borderStrong },
  flex: { flex: 1 },

  head: {
    paddingHorizontal: 18,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: alpha(color.border, 0.7),
  },
  identRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: 6 },
  chip: {
    ...mono(400),
    fontSize: font.micro,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    color: color.textDim,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  chipRef: { ...mono(600), color: color.body },
  title: {
    ...sans(600),
    fontSize: 19,
    lineHeight: 24,
    color: color.text,
    letterSpacing: -0.3,
  },
  decide: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md },
  stagePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  stagePillText: { ...sans(500), fontSize: font.tiny, color: color.text },
  primary: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: radius.md,
    backgroundColor: color.accent,
  },
  primaryText: { ...sans(600), fontSize: font.small, color: color.onAccent },
  asking: {
    marginTop: 11,
    padding: 10,
    borderRadius: radius.md,
    backgroundColor: color.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentBorder,
  },
  askingText: { ...sans(400), fontSize: font.tiny, lineHeight: 18, color: color.accentTint },
  askingLead: { ...sans(600), color: color.accent },
  blocked: { backgroundColor: color.dangerSoft, borderColor: alpha(color.danger, 0.4) },
  blockedText: { color: '#f0a0a6' },
  presence: { ...mono(400), fontSize: font.micro, color: color.textMicro, marginTop: 10 },

  scroll: { flex: 1 },
  body: { paddingHorizontal: 18, paddingTop: space.md },
  prose: {
    ...sans(400),
    fontSize: font.small,
    lineHeight: leading(15, 'prose'),
    letterSpacing: tracking[15],
    color: color.textDim,
    marginBottom: 18,
  },
  proseTight: { ...sans(400), fontSize: font.tiny, lineHeight: 19, color: alpha(color.body, 0.85) },
  proseEmpty: { color: color.textFaint, fontStyle: 'italic' },

  part: { marginBottom: 20 },
  partHdr: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: space.sm },
  partTitle: { ...monoLabel(font.micro), color: color.label },
  partMeta: { ...mono(400), fontSize: font.micro, color: color.textMicro },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: color.hairline },

  todo: { flexDirection: 'row', gap: 9, paddingVertical: 5 },
  todoBox: {
    width: 15,
    height: 15,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: color.borderStrong,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todoBoxDone: { backgroundColor: color.working, borderColor: color.working },
  todoText: { ...sans(400), flex: 1, fontSize: font.tiny, lineHeight: 19, color: color.textDim },
  todoTextDone: { color: color.textMicro, textDecorationLine: 'line-through' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: alpha(color.hairline, 0.55),
  },
  rowRef: { ...mono(400), fontSize: font.micro, color: color.textMicro, minWidth: 52 },
  rowTitle: { ...sans(400), flex: 1, fontSize: font.tiny, color: color.body },
  rowStamp: { ...mono(400), fontSize: font.micro, color: color.textMicro },
  kind: {
    width: 20,
    height: 20,
    borderRadius: radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kindCh: { ...mono(600), fontSize: 9 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.accent },

  branch: { ...mono(400), fontSize: font.micro, color: color.accentTint },
  gitLine: { ...mono(400), fontSize: font.micro, color: color.textFaint, marginTop: 4 },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 9,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.border, 0.7),
    backgroundColor: Platform.OS === 'web' ? color.bar : alpha(color.bar, 0.86),
  },
  well: {
    flex: 1,
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: 20,
    paddingHorizontal: 14,
    backgroundColor: color.bgSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  wellHint: { ...mono(400), fontSize: font.tiny, color: color.textMicro },
})
