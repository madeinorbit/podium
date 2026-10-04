import type { IssueViewModel } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useCallback } from 'react'
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { useKeyboardHeight } from '../hooks/useKeyboardHeight'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { PressableScale } from './PressableScale'
import { StageGlyph } from './StageGlyph'

type IssueTarget = Pick<IssueViewModel, 'id' | 'seq' | 'title' | 'stage' | 'displayRef'>

/** Search-first issue chooser for relationship and hierarchy edits. */
export function IssueTargetSheet({
  visible,
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
      scrollable={false}
      onClose={onClose}
      head={
        <View style={styles.head}>
          <Text style={styles.heading}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          <TextInput
            autoFocus
            accessibilityLabel={`Search ${title.toLocaleLowerCase()}`}
            value={query}
            onChangeText={onQueryChange}
            placeholder="Search by title or ID…"
            placeholderTextColor={color.textMicro}
            returnKeyType="search"
            style={styles.search}
          />
        </View>
      }
      footerRule={false}
      footer={
        <View style={[styles.footer, { paddingBottom: footerPadding }]}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={onClose}
            style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </PressableScale>
        </View>
      }
      virtualizedContent={(scrollEnabled) => (
        <FlatList
          style={styles.listFrame}
          data={ids}
          keyExtractor={(id) => id}
          initialNumToRender={14}
          maxToRenderPerBatch={12}
          windowSize={7}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.2}
          scrollEnabled={scrollEnabled}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={styles.list}
          renderItem={({ item: id }) => (
            <IssueTargetRow id={id} onPick={onPick} onClose={onClose} />
          )}
          ListEmptyComponent={<Text style={styles.empty}>No matching tasks.</Text>}
        />
      )}
    />
  )
}

/** FlatList mounts only its visible window. Missing facts stay loading while
 * the one reader batches their demand; the catalog never caches payloads. */
function IssueTargetRow({
  id,
  onPick,
  onClose,
}: {
  id: string
  onPick: (issue: IssueTarget) => void
  onClose: () => void
}) {
  const read = useCallback(
    (pool: MobxPool): IssueTarget | typeof LOADING | undefined => {
      const row = pool.row('issue', id, 'summary-fields') as
        | Pick<IssueViewModel, 'seq' | 'title' | 'stage' | 'repoId'>
        | typeof LOADING
        | undefined
      if (!row || row === LOADING) return row
      const repo = row.repoId
        ? (pool.row('repo', row.repoId) as { prefix?: string } | typeof LOADING | undefined)
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
      <View style={styles.row}>
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
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <StageGlyph stage={issue.stage} size={14} ground={color.surface} />
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
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  heading: {
    ...sans(600),
    color: color.body,
    fontSize: font.body,
    textAlign: 'center',
  },
  subtitle: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    textAlign: 'center',
  },
  search: {
    ...sans(400),
    minHeight: 42,
    color: color.text,
    fontSize: font.small,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.bgSunken,
  },
  list: {
    paddingHorizontal: space.md,
    paddingBottom: space.md,
  },
  listFrame: { flex: 1 },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
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
  pressed: { opacity: 0.68 },
  footer: {
    paddingTop: space.sm,
  },
  cancel: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  cancelText: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.body,
  },
})
