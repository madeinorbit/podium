import { GitView, type ReviewDiffAnswer } from '@podium/client-graph/git-view'
import { issueObserver as observer } from '../../client/issue-observer'
import { useStoreHandle } from '@podium/client-core/react'
import type { MachineId } from '@podium/model'
import { memo, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import {
  type DiffRow,
  diffRowAccessibilityLabel,
  entryBadge,
  entryStatus,
  GIT_DIFF_PAGE,
  GIT_FILE_PAGE,
} from '../../lib/git-review'
import { color, font, leading, mono, radius, sans, space } from '../../theme/theme'
import { Icon } from '../Icon'
import { ChevronDown, ChevronRight, RefreshCw } from '../icons'
import { PressableScale } from '../PressableScale'
import { SectionHeading } from './chrome'

/** Changed-file inventory and wrapped, per-file diffs on the task page. It uses
 * only the store's existing read-only Git and file contracts. */
export const GitReviewSection = observer(function GitReviewSection({
  root,
  machineId,
}: {
  root: string
  machineId?: MachineId
}) {
  const { gitStatus, readFileScoped, gitDiffFile } = useStoreHandle().access
  const view = useMemo(() => new GitView(root, machineId, { gitStatus, readFileScoped, gitDiffFile }), [root, machineId, gitStatus, readFileScoped, gitDiffFile])
  useEffect(() => { void view.refresh(); return () => view.close() }, [view])
  const header = view.reviewStatus?.header
  const entries = view.reviewStatus?.entries ?? []
  const statusError = view.error
  const refreshing = view.inventory.loading
  const { openPath, diffs } = view
  const [visibleFiles, setVisibleFiles] = useState(GIT_FILE_PAGE)
  useEffect(() => { if (view.inventory.answer?.status.ok) setVisibleFiles(GIT_FILE_PAGE) }, [view.inventory.answer])
  const refresh = (): Promise<void> => view.refresh()
  const toggle = (entry: Parameters<GitView['toggleFile']>[0]): void => view.toggleFile(entry)

  const branchDetail = header
    ? [
        header.branch,
        header.ahead ? `↑${header.ahead}` : '',
        header.behind ? `↓${header.behind}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    : ''
  const visibleEntries = entries.slice(0, visibleFiles)
  const remainingFiles = entries.length - visibleEntries.length

  return (
    <View style={styles.section} testID="git-review-section">
      <SectionHeading
        label="Changes"
        count={entries.length > 0 ? String(entries.length) : undefined}
        right={
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Refresh changed files"
            disabled={refreshing}
            hitSlop={8}
            onPress={() => void refresh()}
            style={[styles.refresh, refreshing && styles.muted]}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={color.textFaint} />
            ) : (
              <Icon as={RefreshCw} size={14} color={color.textFaint} />
            )}
          </PressableScale>
        }
      />
      {branchDetail ? <Text style={styles.branch}>{branchDetail}</Text> : null}
      {statusError ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {statusError}
        </Text>
      ) : !refreshing && entries.length === 0 ? (
        <Text style={styles.empty}>No uncommitted changes.</Text>
      ) : (
        <>
          {visibleEntries.map((entry) => {
            const open = openPath === entry.path
            return (
              <View key={entry.path} style={styles.fileBlock}>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={`${entry.path}, ${entryStatus(entry)}`}
                  accessibilityState={{ expanded: open }}
                  aria-expanded={open}
                  onPress={() => toggle(entry)}
                  style={({ pressed }) => [styles.fileRow, pressed && styles.fileRowPressed]}
                >
                  <Icon as={open ? ChevronDown : ChevronRight} size={13} color={color.textFaint} />
                  <Text
                    style={[
                      styles.badge,
                      entry.untracked
                        ? styles.badgeUntracked
                        : entry.x !== ' ' && entry.y === ' '
                          ? styles.badgeStaged
                          : styles.badgeUnstaged,
                    ]}
                  >
                    {entryBadge(entry)}
                  </Text>
                  <View style={styles.pathBlock}>
                    <Text selectable style={styles.path}>
                      {entry.path}
                    </Text>
                    {entry.renamedFrom ? (
                      <Text style={styles.renamed}>from {entry.renamedFrom}</Text>
                    ) : null}
                  </View>
                </PressableScale>
                {open ? <DiffBody state={diffs[entry.path]} /> : null}
              </View>
            )
          })}
          {remainingFiles > 0 ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Show ${Math.min(GIT_FILE_PAGE, remainingFiles)} more changed files`}
              onPress={() => setVisibleFiles((count) => count + GIT_FILE_PAGE)}
              style={({ pressed }) => [styles.moreButton, pressed && styles.fileRowPressed]}
            >
              <Text style={styles.moreText}>
                Show next {Math.min(GIT_FILE_PAGE, remainingFiles)} files
              </Text>
              <Text style={styles.moreCount}>{remainingFiles} remaining</Text>
            </PressableScale>
          ) : null}
        </>
      )}
    </View>
  )
})

const DiffBody = memo(function DiffBody({ state }: { state: ReviewDiffAnswer | undefined }) {
  const [visibleRows, setVisibleRows] = useState(GIT_DIFF_PAGE)
  if (!state || state.loading) {
    return (
      <View style={styles.diffMessage}>
        <ActivityIndicator size="small" color={color.textFaint} />
        <Text style={styles.note}>Reading diff…</Text>
      </View>
    )
  }
  if (state.error) return <Text style={styles.diffError}>{state.error}</Text>
  if (state.answer?.note) return <Text style={styles.note}>{state.answer.note}</Text>
  const parsed = state.answer?.parsed
  if (!parsed) return null
  if (parsed.rows.length === 0) {
    return <Text style={styles.note}>No text diff for this file.</Text>
  }
  return (
    <View style={styles.diff}>
      <Text style={styles.summary}>
        <Text style={styles.addCount}>+{parsed.added}</Text>
        {'  '}
        <Text style={styles.delCount}>−{parsed.removed}</Text>
      </Text>
      {parsed.rows.slice(0, visibleRows).map((row, index) => (
        <DiffLine key={`${index}:${row.kind}`} row={row} />
      ))}
      {visibleRows < parsed.rows.length ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Show ${Math.min(GIT_DIFF_PAGE, parsed.rows.length - visibleRows)} more diff lines`}
          onPress={() => setVisibleRows((count) => count + GIT_DIFF_PAGE)}
          style={({ pressed }) => [styles.diffMore, pressed && styles.fileRowPressed]}
        >
          <Text style={styles.moreText}>
            Show next {Math.min(GIT_DIFF_PAGE, parsed.rows.length - visibleRows)} lines
          </Text>
        </PressableScale>
      ) : null}
      {parsed.truncated > 0 ? (
        <Text style={styles.truncated}>{parsed.truncated} more lines not shown on phone.</Text>
      ) : null}
    </View>
  )
})

export const DiffLine = observer(function DiffLine({ row }: { row: DiffRow }) {
  if (row.kind === 'hunk') {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={diffRowAccessibilityLabel(row)}
        style={[styles.diffLine, styles.hunkLine]}
      >
        <Text accessible={false} style={styles.hunkText}>
          {row.text}
          {row.context ? ` ${row.context}` : ''}
        </Text>
      </View>
    )
  }
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={diffRowAccessibilityLabel(row)}
      style={[
        styles.diffLine,
        row.kind === 'add' && styles.addLine,
        row.kind === 'del' && styles.delLine,
        row.kind === 'note' && styles.noteLine,
      ]}
    >
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.sign,
          row.kind === 'add' && styles.addCount,
          row.kind === 'del' && styles.delCount,
        ]}
      >
        {sign}
      </Text>
      <Text accessible={false} selectable style={styles.code}>
        {row.text || ' '}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  section: { marginTop: space.xl },
  refresh: {
    width: 44,
    height: 44,
    marginVertical: -14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  muted: { opacity: 0.55 },
  branch: {
    ...mono(500),
    color: color.textFaint,
    fontSize: font.micro,
    marginBottom: space.xs,
  },
  empty: { ...sans(400), color: color.textFaint, fontSize: font.small, paddingVertical: space.sm },
  error: {
    ...sans(400),
    color: color.dangerText,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  fileBlock: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline },
  fileRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: -space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  fileRowPressed: { backgroundColor: color.quaternaryFill },
  moreButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  moreText: { ...sans(600), color: color.accentTint, fontSize: font.small },
  moreCount: { ...sans(400), color: color.textFaint, fontSize: font.tiny },
  badge: { ...mono(600), width: 22, fontSize: font.micro, textAlign: 'center' },
  badgeStaged: { color: color.workingText },
  badgeUnstaged: { color: color.accentTint },
  badgeUntracked: { color: color.textFaint },
  pathBlock: { flex: 1, minWidth: 0 },
  path: {
    ...mono(500),
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small, 'ui'),
  },
  renamed: { ...mono(400), color: color.textFaint, fontSize: font.micro, marginTop: 2 },
  diff: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: space.md,
    backgroundColor: color.bgSunken,
  },
  summary: {
    ...mono(600),
    fontSize: font.micro,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  addCount: { color: color.workingText },
  delCount: { color: color.dangerText },
  diffLine: { flexDirection: 'row', alignItems: 'flex-start', minWidth: 0 },
  addLine: { backgroundColor: color.workingSoft },
  delLine: { backgroundColor: color.dangerSoft },
  noteLine: { backgroundColor: color.tertiaryFill },
  hunkLine: { backgroundColor: color.surface, paddingHorizontal: space.sm, paddingVertical: 5 },
  hunkText: { ...mono(500), color: color.workingText, fontSize: font.micro, lineHeight: 17 },
  sign: {
    ...mono(600),
    width: 20,
    paddingTop: 2,
    textAlign: 'center',
    fontSize: font.micro,
    lineHeight: 17,
  },
  code: {
    ...mono(400),
    flex: 1,
    minWidth: 0,
    color: color.body,
    fontSize: font.micro,
    lineHeight: 17,
    paddingVertical: 2,
    paddingRight: space.sm,
  },
  diffMessage: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  diffMore: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  note: { ...sans(400), color: color.textFaint, fontSize: font.small, paddingVertical: space.sm },
  diffError: {
    ...sans(400),
    color: color.dangerText,
    fontSize: font.small,
    paddingVertical: space.sm,
  },
  truncated: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.tiny,
    paddingHorizontal: space.sm,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
})
