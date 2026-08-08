import { relativeTime } from '@podium/client-core/focus'
import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import * as Haptics from 'expo-haptics'
import { usePathname, useRouter } from 'expo-router'
import { useEffect } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { sessionHref } from '../lib/session-route'
import { FLOW_SLATE, flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, leading, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { IdSquare } from './IdSquare'
import { PressableScale } from './PressableScale'

/**
 * The ONE task-reveal surface on mobile [POD-131]: a bottom "popover card" —
 * the phone analogue of the web's right-rail issue panel / ref miniview.
 * Opens from the session header's task chip, from POD-refs in chat text, and
 * from a long-press on an agent roster row (with a haptic). Native builds can
 * later upgrade the long-press entry to a real iOS context-menu preview.
 */
export function TaskPeekSheet({
  issue,
  session,
  sessions = [],
  onClose,
  onToggleTodo,
}: {
  issue: IssueNavigationModel | null
  /** When opened from a session context, "Open session" targets it. */
  session?: SessionMeta
  sessions?: readonly SessionMeta[]
  onClose: () => void
  /** The session chat supplies this so the plan bridge is checkable in-place. */
  onToggleTodo?: (index1: number, done: boolean) => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()

  useEffect(() => {
    if (issue) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
    }
  }, [issue])

  if (!issue) return null
  const hex = issueColorHex(issue.color) ?? FLOW_SLATE
  const now = Date.now()
  // The freshest offer across the task's live agent sessions — the "what's
  // waiting" one-liner the peek leads with.
  const memberIds = new Set(issue.memberSessionIds ?? [])
  const offer = sessions
    .filter((candidate) => memberIds.has(candidate.sessionId))
    .filter((s) => !s.archived && s.agentKind !== 'shell' && s.headless !== true && s.offer)
    .map((s) => s.offer)
    .sort((a, b) => (b?.createdAt ?? '').localeCompare(a?.createdAt ?? ''))[0]
  const artifactCount = issue.panel?.artifacts?.length ?? 0
  const todos = issue.panel?.todos ?? []
  const doneTodos = todos.filter((todo) => todo.done).length
  const branch = issue.branch ?? undefined

  return (
    <Modal transparent visible animationType="slide" onRequestClose={onClose}>
      {/* A dismiss backdrop stays a plain Pressable [POD-366]: scaling a
          full-bleed dim shrinks it away from the screen edges, and an impact
          haptic is the wrong report for "you tapped nothing". */}
      <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
      <View
        style={[
          styles.sheet,
          { paddingBottom: insets.bottom + space.lg, borderTopColor: alpha(hex, 0.4) },
        ]}
      >
        <View style={styles.handle} />
        <View style={styles.top}>
          <IdSquare issue={issue} state={issue.needsHuman ? 'waiting' : 'working'} size={26} />
          <View style={styles.titles}>
            <Text style={styles.title} numberOfLines={2}>
              {issue.title}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {issue.stage.replace('_', ' ')}
              {branch ? ` · ⎇ ${branch}` : ''}
              {` · ${relativeTime(issue.updatedAt, now)}`}
            </Text>
          </View>
        </View>
        {offer ? (
          <View style={[styles.offer, { backgroundColor: flow.rowBg(hex) }]}>
            <Text style={styles.offerLabel}>OFFER</Text>
            <Text style={styles.offerText} numberOfLines={2}>
              {offer.message.split('\n')[0]}
            </Text>
          </View>
        ) : null}
        {issue.description.trim() ? (
          <ScrollView style={styles.descWrap}>
            <Text style={styles.desc} numberOfLines={5}>
              {issue.description.trim()}
            </Text>
          </ScrollView>
        ) : null}
        {todos.length > 0 ? (
          <View style={styles.plan}>
            <View style={styles.planHead}>
              <Text style={styles.planLabel}>PLAN</Text>
              <Text style={styles.planCount}>
                {doneTodos}/{todos.length}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[styles.progressFill, { width: `${(doneTodos / todos.length) * 100}%` }]}
              />
            </View>
            <ScrollView style={styles.todoList} nestedScrollEnabled>
              {todos.map((todo, index) => (
                <PressableScale
                  // biome-ignore lint/suspicious/noArrayIndexKey: issue todos are positional; the mutation API addresses this exact 1-based index.
                  key={`${index}:${todo.text}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: todo.done, disabled: !onToggleTodo }}
                  accessibilityLabel={todo.text}
                  disabled={!onToggleTodo}
                  onPress={() => onToggleTodo?.(index + 1, !todo.done)}
                  style={({ pressed }) => [styles.todo, pressed && styles.todoPressed]}
                >
                  <Text style={[styles.todoCheck, todo.done && styles.todoCheckDone]}>
                    {todo.done ? '✓' : '○'}
                  </Text>
                  <Text style={[styles.todoText, todo.done && styles.todoTextDone]}>
                    {todo.text}
                  </Text>
                </PressableScale>
              ))}
            </ScrollView>
          </View>
        ) : null}
        {artifactCount > 0 ? (
          <Text
            style={styles.artifacts}
          >{`${artifactCount} artifact${artifactCount > 1 ? 's' : ''} published`}</Text>
        ) : null}
        <View style={styles.actions}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Open task"
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => {
              onClose()
              router.push(`/issue/${encodeURIComponent(issue.id)}`)
            }}
          >
            <Text style={styles.btnPrimaryText}>Open task</Text>
          </PressableScale>
          {session ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Open session"
              style={[styles.btn, styles.btnSecondary]}
              onPress={() => {
                onClose()
                router.push(sessionHref(session.sessionId, pathname))
              }}
            >
              <Text style={styles.btnSecondaryText}>Open session</Text>
            </PressableScale>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    gap: space.sm + 2,
  },
  handle: {
    alignSelf: 'center',
    width: 34,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: color.borderStrong,
    marginBottom: 2,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
  },
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body),
  },
  meta: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.micro,
  },
  offer: {
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 3,
  },
  offerLabel: {
    ...monoLabel(),
    color: color.accent,
  },
  offerText: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  descWrap: {
    maxHeight: 110,
  },
  desc: {
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  artifacts: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
  plan: {
    gap: space.xs + 1,
  },
  planHead: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  planLabel: {
    ...monoLabel(),
    color: color.textFaint,
  },
  planCount: {
    ...mono(500),
    marginLeft: 'auto',
    color: color.textDim,
    fontSize: font.micro,
  },
  progressTrack: {
    height: 3,
    overflow: 'hidden',
    borderRadius: radius.full,
    backgroundColor: color.elevated,
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.full,
    backgroundColor: color.success,
  },
  todoList: {
    maxHeight: 150,
  },
  todo: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  todoPressed: {
    opacity: 0.6,
  },
  todoCheck: {
    ...mono(500),
    width: 16,
    color: color.textMicro,
    fontSize: font.small,
  },
  todoCheckDone: {
    color: color.success,
  },
  todoText: {
    ...sans(400),
    flex: 1,
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  todoTextDone: {
    color: color.textFaint,
    textDecorationLine: 'line-through',
  },
  actions: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: 2,
  },
  btn: {
    flex: 1,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: {
    backgroundColor: color.accent,
  },
  btnPrimaryText: {
    ...sans(600),
    color: color.onAccent,
    fontSize: font.small,
  },
  btnSecondary: {
    backgroundColor: color.elevated,
    borderWidth: 1,
    borderColor: color.borderStrong,
  },
  btnSecondaryText: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
  },
})
