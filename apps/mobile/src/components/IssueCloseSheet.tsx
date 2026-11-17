import type { IssueCloseConcern } from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { StyleSheet, Text, View } from 'react-native'
import { useIssueCloseConcerns } from '../client/use-issue-close'
import { alpha } from '../theme/mix'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { Icon } from './Icon'
import {
  AlertTriangle,
  type AppIcon,
  GitBranch,
  GitCommit,
  MessageCircleQuestion,
  Users,
} from './icons'
import {
  closeConfirmLabel,
  closeSubtitle,
  closeTitle,
  type IssueCloseSheetProps,
} from './issue-close-copy'
import { PressableScale } from './PressableScale'

/** Android and web confirmation; iOS uses the native sheet in IssueCloseSheet.ios. */
export function IssueCloseSheet({
  issue,
  reason,
  busy = false,
  onConfirm,
  onClose,
}: IssueCloseSheetProps) {
  if (reason === null) return null
  return (
    <VisibleIssueCloseSheet
      issue={issue}
      reason={reason}
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}

function VisibleIssueCloseSheet({
  issue,
  reason,
  busy = false,
  onConfirm,
  onClose,
}: Parameters<typeof IssueCloseSheet>[0]) {
  const value = useIssueCloseConcerns(issue.id)
  const pending = value === LOADING
  const concerns = pending ? [] : value

  return (
    <BottomSheet
      visible={reason !== null}
      onClose={onClose}
      mode="fit"
      scrollable={concerns.length > 3}
      contentStyle={styles.content}
      testID="issue-close-sheet"
      head={
        <View style={styles.titles}>
          <View style={styles.warn}>
            <Icon as={AlertTriangle} size={15} color={color.needsYouText} />
          </View>
          <Text style={styles.title} numberOfLines={2}>
            {closeTitle(reason, concerns.length, pending)}
          </Text>
          <Text style={styles.subtitle}>{closeSubtitle(concerns.length, pending)}</Text>
        </View>
      }
      footerRule={false}
      footer={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Keep open"
          disabled={busy}
          onPress={onClose}
          style={({ pressed }) => [styles.cancel, pressed && styles.rowPressed]}
        >
          <Text style={styles.cancelText}>Keep open</Text>
        </PressableScale>
      }
    >
      {concerns.length > 0 ? (
        <View style={styles.group} testID="issue-close-concerns">
          {concerns.map((concern, i) => (
            <View key={concern.key} style={[styles.concern, i > 0 && styles.divider]}>
              <View style={styles.icon}>
                <Icon as={CONCERN_ICONS[concern.icon]} size={15} color={color.needsYouText} />
              </View>
              <View style={styles.concernText}>
                <Text style={styles.label}>{concern.label}</Text>
                <Text style={styles.detail}>{concern.detail}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.group}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={closeConfirmLabel(reason, concerns.length > 0, false)}
          disabled={busy || pending || reason === null}
          scaleTo={0.99}
          // Dismiss FIRST, then close. The store's close is optimistic and
          // outboxed (POD-781) — the row reaches the closed fold on the press —
          // so holding the sheet up on a `Closing…` state would be a spinner
          // over something that has already happened. `busy` still gates the
          // button, for a host whose page is mid-mutation when the guard opens.
          onPress={() => {
            if (!reason) return
            onClose()
            onConfirm(reason)
          }}
          style={({ pressed }) => [
            styles.row,
            busy && styles.rowDisabled,
            pressed && styles.rowPressed,
          ]}
        >
          <Text style={[styles.label, styles.destructive]}>
            {closeConfirmLabel(reason, concerns.length > 0, busy)}
          </Text>
        </PressableScale>
      </View>
    </BottomSheet>
  )
}

/** The derivation names an icon; each surface maps it to its own set. These are
 *  the desktop's four, translated to the platform symbol set. */
const CONCERN_ICONS: Record<IssueCloseConcern['icon'], AppIcon> = {
  attention: MessageCircleQuestion,
  sessions: Users,
  children: GitBranch,
  git: GitCommit,
}

const styles = StyleSheet.create({
  titles: {
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: 3,
  },
  warn: {
    width: 28,
    height: 28,
    marginBottom: 3,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.needsYouBg,
  },
  title: {
    ...sans(600),
    color: color.body,
    fontSize: font.small,
    textAlign: 'center',
  },
  subtitle: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
    textAlign: 'center',
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  group: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: 'hidden',
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.hairline, 0.8),
  },
  // Not a `row`: a concern is read, not pressed, so it takes no minimum tap
  // height and no press state. Nothing in this group is a target.
  concern: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: 11,
    paddingHorizontal: space.lg - 2,
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    paddingHorizontal: space.lg - 2,
  },
  rowPressed: {
    backgroundColor: color.surfacePressed,
  },
  rowDisabled: {
    opacity: 0.38,
  },
  icon: {
    width: 26,
    paddingTop: 1,
    alignItems: 'center',
  },
  concernText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  label: {
    ...sans(500),
    color: color.text,
    fontSize: font.small,
  },
  detail: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  destructive: {
    ...sans(600),
    color: color.dangerText,
  },
  cancel: {
    paddingVertical: 15,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    alignItems: 'center',
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  cancelText: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
  },
})
