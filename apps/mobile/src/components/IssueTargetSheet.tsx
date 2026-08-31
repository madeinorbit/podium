import type { IssueWire } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useEffect, useMemo, useState } from 'react'
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { PressableScale } from './PressableScale'
import { StageGlyph } from './StageGlyph'

/** Search-first issue chooser for relationship and hierarchy edits. */
export function IssueTargetSheet({
  visible,
  title,
  subtitle,
  issues,
  onPick,
  onClose,
}: {
  visible: boolean
  title: string
  subtitle?: string
  issues: readonly IssueWire[]
  onPick: (issue: IssueWire) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (!visible) setQuery('')
  }, [visible])

  const matches = useMemo(() => filterIssueTargets(issues, query), [issues, query])

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
            onChangeText={setQuery}
            placeholder="Search by title or ID…"
            placeholderTextColor={color.textMicro}
            returnKeyType="search"
            style={styles.search}
          />
        </View>
      }
      footerRule={false}
      footer={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onClose}
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </PressableScale>
      }
      virtualizedContent={(scrollEnabled) => (
        <FlatList
          style={styles.listFrame}
          data={matches}
          keyExtractor={(issue) => issue.id}
          initialNumToRender={14}
          maxToRenderPerBatch={12}
          windowSize={7}
          scrollEnabled={scrollEnabled}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={styles.list}
          renderItem={({ item: issue }) => (
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
          )}
          ListEmptyComponent={<Text style={styles.empty}>No matching tasks.</Text>}
        />
      )}
    />
  )
}

/** Pure, deterministic membership used by the virtualized picker and its scale guard. */
export function filterIssueTargets(
  issues: readonly IssueWire[],
  query: string,
): readonly IssueWire[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return issues
  const refNeedle = needle.replace(/[^a-z0-9]/g, '')
  return issues.filter(
    (issue) =>
      issue.title.toLocaleLowerCase().includes(needle) ||
      (/\d/.test(refNeedle) &&
        issueDisplayRef(issue)
          .toLocaleLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .includes(refNeedle)),
  )
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
  cancel: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: space.md,
    marginTop: space.sm,
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
