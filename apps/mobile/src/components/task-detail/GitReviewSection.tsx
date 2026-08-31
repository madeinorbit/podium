import type { MachineId } from '@podium/model'
import { memo, useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useMobileStore } from '../../client/hooks'
import {
  type DiffRow,
  entryBadge,
  entryStatus,
  parseDiff,
  parseStatus,
  type ParsedDiff,
  type StatusEntry,
  untrackedDiff,
} from '../../lib/git-review'
import { color, font, leading, mono, radius, sans, space } from '../../theme/theme'
import { Icon } from '../Icon'
import { ChevronDown, ChevronRight, RefreshCw } from '../icons'
import { PressableScale } from '../PressableScale'
import { SectionHeading } from './chrome'

type DiffState =
  | { kind: 'loading' }
  | { kind: 'ready'; parsed: ParsedDiff }
  | { kind: 'note'; message: string }
  | { kind: 'error'; message: string }

interface FileReadResult {
  ok: boolean
  content?: string
  error?: string
  binary?: boolean
  tooLarge?: boolean
}

/** Changed-file inventory and wrapped, per-file diffs on the task page. It uses
 * only the store's existing read-only Git and file contracts. */
export function GitReviewSection({
  root,
  machineId,
}: {
  root: string
  machineId?: MachineId
}) {
  const store = useMobileStore()
  const [header, setHeader] = useState<ReturnType<typeof parseStatus>['header'] | null>(null)
  const [entries, setEntries] = useState<StatusEntry[]>([])
  const [statusError, setStatusError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})

  const gitArgs = useCallback(
    () => ({ root, ...(machineId === undefined ? {} : { machineId }) }),
    [machineId, root],
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setStatusError(null)
    try {
      const result = await store.gitStatus(gitArgs())
      if (!result.ok) throw new Error(result.output || 'Git status could not be read.')
      const parsed = parseStatus(result.output)
      setHeader(parsed.header)
      setEntries(parsed.entries)
      setOpenPath((current) =>
        current && parsed.entries.some((entry) => entry.path === current) ? current : null,
      )
      setDiffs({})
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }, [gitArgs, store.gitStatus])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadDiff = useCallback(
    async (entry: StatusEntry) => {
      setDiffs((current) => ({ ...current, [entry.path]: { kind: 'loading' } }))
      try {
        let next: DiffState
        if (entry.untracked && entry.path.endsWith('/')) {
          next = { kind: 'note', message: 'Open this folder on desktop to review its contents.' }
        } else if (entry.untracked) {
          const result = (await store.readFileScoped(
            { kind: 'worktree', root, ...(machineId === undefined ? {} : { machineId }) },
            entry.path,
          )) as FileReadResult
          next =
            result.ok && result.content !== undefined
              ? { kind: 'ready', parsed: parseDiff(untrackedDiff(result.content)) }
              : result.binary
                ? { kind: 'note', message: 'Binary file. No text diff is available.' }
                : result.tooLarge
                  ? { kind: 'note', message: 'This file is too large for an inline review.' }
                  : { kind: 'error', message: result.error || 'This file could not be read.' }
        } else {
          const result = await store.gitDiffFile({
            root,
            path: entry.path,
            ...(machineId === undefined ? {} : { machineId }),
          })
          next = result.ok
            ? { kind: 'ready', parsed: parseDiff(result.output) }
            : { kind: 'error', message: result.output || 'Git could not diff this file.' }
        }
        setDiffs((current) => ({ ...current, [entry.path]: next }))
      } catch (error) {
        setDiffs((current) => ({
          ...current,
          [entry.path]: {
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        }))
      }
    },
    [machineId, root, store.gitDiffFile, store.readFileScoped],
  )

  const toggle = (entry: StatusEntry): void => {
    if (openPath === entry.path) {
      setOpenPath(null)
      return
    }
    setOpenPath(entry.path)
    if (!diffs[entry.path]) void loadDiff(entry)
  }

  const branchDetail = header
    ? [header.branch, header.ahead ? `↑${header.ahead}` : '', header.behind ? `↓${header.behind}` : '']
        .filter(Boolean)
        .join(' ')
    : ''

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
        entries.map((entry) => {
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
                <Icon
                  as={open ? ChevronDown : ChevronRight}
                  size={13}
                  color={color.textFaint}
                />
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
        })
      )}
    </View>
  )
}

const DiffBody = memo(function DiffBody({ state }: { state: DiffState | undefined }) {
  if (!state || state.kind === 'loading') {
    return (
      <View style={styles.diffMessage}>
        <ActivityIndicator size="small" color={color.textFaint} />
        <Text style={styles.note}>Reading diff…</Text>
      </View>
    )
  }
  if (state.kind === 'error') return <Text style={styles.diffError}>{state.message}</Text>
  if (state.kind === 'note') return <Text style={styles.note}>{state.message}</Text>
  const { parsed } = state
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
      {parsed.rows.map((row, index) => (
        <DiffLine key={`${index}:${row.kind}`} row={row} />
      ))}
      {parsed.truncated > 0 ? (
        <Text style={styles.truncated}>{parsed.truncated} more lines not shown on phone.</Text>
      ) : null}
    </View>
  )
})

function DiffLine({ row }: { row: DiffRow }) {
  if (row.kind === 'hunk') {
    return (
      <View style={[styles.diffLine, styles.hunkLine]}>
        <Text style={styles.hunkText}>
          {row.text}
          {row.context ? ` ${row.context}` : ''}
        </Text>
      </View>
    )
  }
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
  return (
    <View
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
      <Text selectable style={styles.code}>
        {row.text || ' '}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  section: { marginTop: space.xl },
  refresh: { width: 44, height: 44, marginVertical: -14, alignItems: 'center', justifyContent: 'center' },
  muted: { opacity: 0.55 },
  branch: {
    ...mono(500),
    color: color.textFaint,
    fontSize: font.micro,
    marginBottom: space.xs,
  },
  empty: { ...sans(400), color: color.textFaint, fontSize: font.small, paddingVertical: space.sm },
  error: { ...sans(400), color: color.dangerText, fontSize: font.small, lineHeight: leading(font.small, 'prose') },
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
  sign: { ...mono(600), width: 20, paddingTop: 2, textAlign: 'center', fontSize: font.micro, lineHeight: 17 },
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
  note: { ...sans(400), color: color.textFaint, fontSize: font.small, paddingVertical: space.sm },
  diffError: { ...sans(400), color: color.dangerText, fontSize: font.small, paddingVertical: space.sm },
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
