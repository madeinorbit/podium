import {
  activitySingletonDisplay,
  type ChatBlock,
  failLine,
  formatClock,
  resolveToolEdit,
  toolSubject,
  toolVerdict,
} from '@podium/client-core/values'
import { lazy, Suspense, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { color, mono, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { FileText, Globe, Mail, Search, SquareTerminal, Users } from './icons'
import { PressableScale } from './PressableScale'
import { ToolCallContent } from './ToolCallContent'
import { ToolDescription } from './ToolDescription'

const ToolCallDetails = lazy(() => import('./ToolCallDetails'))

/** A call opens in its fold before the full recorded output needs a sheet. */
export function ToolCallRow({ block }: { block: ChatBlock }) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const { item } = block
  const result = block.result ?? item.toolResult
  const verdict = toolVerdict(result, item.toolEffects)
  const display = activitySingletonDisplay(block)
  const mail =
    display.kind === 'sent-note' || display.kind === 'inbox-read' ? display.mail : undefined
  const description = mail
    ? mail.op === 'note'
      ? `Note to ${mail.to}`
      : mail.notes === undefined
        ? 'Read notes'
        : `Read ${mail.notes} notes`
    : toolSubject(item, Number.POSITIVE_INFINITY) || item.toolName || 'Call'
  const glyph = mail
    ? Mail
    : item.toolName === 'Bash'
      ? SquareTerminal
      : item.toolName === 'Task'
        ? Users
        : item.toolName === 'WebFetch' || item.toolName === 'WebSearch'
          ? Globe
          : item.toolName === 'Grep' || item.toolName === 'Glob'
            ? Search
            : FileText
  const edit = resolveToolEdit(item)
  const files = item.toolPaths?.length ?? 0
  return (
    <View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${open ? 'Collapse' : 'Expand'} call: ${description}`}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <Icon as={glyph} size={14} color={verdict === 'err' ? color.dangerText : color.textMicro} />
        <View style={styles.body}>
          <ToolDescription toolName={mail ? undefined : item.toolName} command={description} />
        </View>
        {edit && edit.added > 0 ? (
          <Text style={[styles.meta, styles.added]}>+{edit.added}</Text>
        ) : null}
        {edit && edit.removed > 0 ? (
          <Text style={[styles.meta, styles.removed]}>−{edit.removed}</Text>
        ) : null}
        {files > 1 ? <Text style={styles.meta}>{files} files</Text> : null}
        {item.durationMs !== undefined ? (
          <Text style={styles.meta}>{formatClock(item.durationMs)}</Text>
        ) : null}
      </PressableScale>
      {verdict === 'err' && (!open || edit) ? (
        <Text style={styles.failure} numberOfLines={2}>
          {failLine(result)}
        </Text>
      ) : null}
      {open ? (
        <View style={styles.preview}>
          <ToolCallContent block={block} preview />
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Show all for ${description}`}
            onPress={() => setShowAll(true)}
            style={styles.showAll}
          >
            <Text style={styles.showAllText}>Show all</Text>
          </PressableScale>
        </View>
      ) : null}
      {showAll ? (
        <Suspense fallback={null}>
          <ToolCallDetails block={block} onClose={() => setShowAll(false)} />
        </Suspense>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 32, gap: space.sm },
  body: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.6 },
  meta: { ...mono(400), color: color.textMicro, fontSize: 11 },
  added: { color: color.workingText },
  removed: { color: color.dangerText },
  failure: { ...mono(400), color: color.dangerText, fontSize: 12, lineHeight: 16, marginLeft: 22 },
  preview: { marginLeft: 22, gap: space.xs },
  showAll: {
    alignSelf: 'flex-start',
    minHeight: 32,
    paddingHorizontal: space.sm,
    justifyContent: 'center',
    borderRadius: radius.control,
  },
  showAllText: { ...sans(500), color: color.textDim, fontSize: 13 },
})
