import type { IssueViewModel } from '@podium/client-core/replica'
import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useCallback } from 'react'
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { useKeyboardHeight } from '../hooks/useKeyboardHeight'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { FormSheetBar } from './compose/FormSheetBar'
import { Icon } from './Icon'
import { listWindow } from './list-window'
import { PressableScale } from './PressableScale'
import { StageGlyph } from './StageGlyph'

type IssueTarget = Pick<IssueViewModel, 'id' | 'seq' | 'title' | 'stage' | 'displayRef'>

/** Search-first issue chooser for relationship and hierarchy edits. */
export function IssueTargetSheet({
  visible,
  loading = false,
  title,
  subtitle,
  ids,
  query,
  onQueryChange,
  onEndReached,
  onPick,
  onClose,
}: {
  visible: boolean
  loading?: boolean
  title: string
  subtitle?: string
  ids: readonly string[]
  query: string
  onQueryChange: (query: string) => void
  onEndReached: () => void
  onPick: (issue: IssueTarget) => void
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  const keyboardHeight = useKeyboardHeight()
  const footerPadding = issueTargetFooterPadding(insets.bottom, keyboardHeight)

  return (
    <BottomSheet
      visible={visible}
      mode="detented"
      openAt="large"
      grouped
      scrollable={false}
      onClose={onClose}
      head={
        <View style={styles.head}>
          <FormSheetBar title={title} onCancel={onClose} />
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          <View style={styles.searchField}>
            <Icon as="magnifyingglass" size={15} color={color.textFaint} />
            <TextInput
              autoFocus
              accessibilityLabel={`Search ${title.toLocaleLowerCase()}`}
              value={query}
              onChangeText={onQueryChange}
              placeholder="Search by title or ID…"
              placeholderTextColor={color.textMicro}
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={styles.search}
            />
          </View>
        </View>
      }
      virtualizedContent={(scrollEnabled) => (
        <FlatList
          style={styles.listFrame}
          data={ids}
          keyExtractor={(id) => id}
          {...listWindow}
          onEndReached={loading ? undefined : onEndReached}
          onEndReachedThreshold={0.2}
          scrollEnabled={scrollEnabled}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={[styles.list, { paddingBottom: footerPadding }]}
          renderItem={({ item: id, index }) => (
            <IssueTargetRow
              id={id}
              first={index === 0}
              last={index === ids.length - 1}
              onPick={onPick}
              onClose={onClose}
            />
          )}
          ListEmptyComponent={
            loading ? (
              <View style={styles.row} accessibilityLabel="Loading tasks">
                <ActivityIndicator color={color.textFaint} />
              </View>
            ) : (
              <Text style={styles.empty}>No matching tasks.</Text>
            )
          }
        />
      )}
    />
  )
}

/** FlatList mounts only its visible window. Missing facts stay loading while
 * the one reader batches their demand; the catalog never caches payloads. */
function IssueTargetRow({
  id,
  first,
  last,
  onPick,
  onClose,
}: {
  id: string
  first: boolean
  last: boolean
  onPick: (issue: IssueTarget) => void
  onClose: () => void
}) {
  // One inset-grouped card drawn row by row: a virtualized list cannot clip
  // its window to a rounded container.
  const shape = [styles.card, first && styles.cardFirst, last && styles.cardLast]
  const read = useCallback(
    (pool: MobxPool): IssueTarget | typeof LOADING | undefined => {
      const row = omitGone(pool.row('issue', id)) as
        | Pick<IssueViewModel, 'seq' | 'title' | 'stage' | 'repoId'>
        | typeof LOADING
        | undefined
      if (!row || row === LOADING) return row
      const repo = row.repoId
        ? (omitGone(pool.row('repo', row.repoId)) as
            | { prefix?: string }
            | typeof LOADING
            | undefined)
        : undefined
      if (repo === LOADING) return LOADING
      return {
        id: asIssueId(id),
        seq: row.seq,
        title: row.title,
        stage: row.stage,
        displayRef: repo?.prefix ? `${repo.prefix}-${row.seq}` : `#${row.seq}`,
      }
    },
    [id],
  )
  const issue = useMobilePoolProjection(read, LOADING)
  if (issue === undefined) return null
  if (issue === LOADING)
    return (
      <View style={[styles.row, shape]}>
        <Text style={styles.title}>Loading…</Text>
      </View>
    )
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${issueDisplayRef(issue)} ${issue.title}`}
      onPress={() => {
        onClose()
        onPick(issue)
      }}
      style={({ pressed }) => [styles.row, shape, pressed && styles.pressed]}
    >
      <StageGlyph stage={issue.stage} size={14} ground={color.groupedCard} />
      <Text style={styles.ref}>{issueDisplayRef(issue)}</Text>
      <Text style={styles.title} numberOfLines={2}>
        {issue.title}
      </Text>
    </PressableScale>
  )
}

/** Clear the home indicator when idle; the sheet itself already pays for an open keyboard. */
export function issueTargetFooterPadding(safeBottom: number, keyboardHeight: number): number {
  return keyboardHeight > 0 ? space.md : safeBottom + space.md
}

const styles = StyleSheet.create({
  head: {
    gap: space.sm,
    paddingBottom: space.md,
  },
  subtitle: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    textAlign: 'center',
    paddingHorizontal: space.lg,
  },
  // The iOS search field: a filled capsule with the magnifying glass inside.
  searchField: {
    minHeight: 36,
    marginHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    borderRadius: 10,
    backgroundColor: color.quaternaryFill,
  },
  search: {
    ...sans(400),
    flex: 1,
    minHeight: 36,
    color: color.text,
    fontSize: font.body,
    paddingRight: 8,
  },
  list: {
    paddingHorizontal: space.lg,
  },
  card: { backgroundColor: color.groupedCard },
  cardFirst: { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
  cardLast: {
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
    borderBottomWidth: 0,
  },
  listFrame: { flex: 1 },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  ref: {
    ...mono(400),
    width: 66,
    color: color.textFaint,
    fontSize: font.micro,
  },
  title: {
    ...sans(400),
    flex: 1,
    color: color.body,
    fontSize: font.small,
  },
  empty: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.small,
    padding: space.xl,
    textAlign: 'center',
  },
  pressed: { backgroundColor: color.surfacePressed },
})
