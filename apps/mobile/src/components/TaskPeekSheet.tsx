import { relativeTime } from '@podium/client-core/focus'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { useRouter } from 'expo-router'
import { useEffect } from 'react'
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { FLOW_SLATE, flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { IdSquare } from './IdSquare'

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
  onClose,
}: {
  issue: IssueWire | null
  /** When opened from a session context, "Open session" targets it. */
  session?: SessionMeta
  onClose: () => void
}) {
  const router = useRouter()
  const insets = useSafeAreaInsets()

  useEffect(() => {
    if (issue && Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
    }
  }, [issue])

  if (!issue) return null
  const hex = issueColorHex(issue.color) ?? FLOW_SLATE
  const now = Date.now()
  // The freshest offer across the task's live agent sessions — the "what's
  // waiting" one-liner the peek leads with.
  const offer = (issue.sessions ?? [])
    .filter((s) => !s.archived && s.agentKind !== 'shell' && s.headless !== true && s.offer)
    .map((s) => s.offer)
    .sort((a, b) => (b?.createdAt ?? '').localeCompare(a?.createdAt ?? ''))[0]
  const artifactCount = issue.panel?.artifacts?.length ?? 0
  const branch = issue.branch ?? undefined

  return (
    <Modal transparent visible animationType="slide" onRequestClose={onClose}>
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
        {artifactCount > 0 ? (
          <Text
            style={styles.artifacts}
          >{`${artifactCount} artifact${artifactCount > 1 ? 's' : ''} published`}</Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open task"
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => {
              onClose()
              router.push(`/issue/${encodeURIComponent(issue.id)}`)
            }}
          >
            <Text style={styles.btnPrimaryText}>Open task</Text>
          </Pressable>
          {session ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open session"
              style={[styles.btn, styles.btnSecondary]}
              onPress={() => {
                onClose()
                router.push(`/session/${session.sessionId}`)
              }}
            >
              <Text style={styles.btnSecondaryText}>Open session</Text>
            </Pressable>
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
    lineHeight: 18,
  },
  meta: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.micro + 0.5,
  },
  offer: {
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 3,
  },
  offerLabel: {
    ...monoLabel(8),
    color: color.accent,
  },
  offerText: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
    lineHeight: 17,
  },
  descWrap: {
    maxHeight: 110,
  },
  desc: {
    color: color.textDim,
    fontSize: font.small,
    lineHeight: 18,
  },
  artifacts: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
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
