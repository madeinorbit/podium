import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { color, space } from '../theme/theme'

export function MissionDeckList({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      testID="mission-deck"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
    >
      {children}
    </ScrollView>
  )
}

export function DeckContent({ children }: { children: ReactNode }) {
  return <View style={styles.main}>{children}</View>
}

export function DeckGroup({
  children,
  header,
  testID,
}: {
  children: ReactNode
  header?: ReactNode
  testID: string
}) {
  return (
    <View style={styles.main}>
      {header}
      <View testID={testID} style={styles.group}>
        {children}
      </View>
    </View>
  )
}

export function DeckRow({ children }: { children: ReactNode }) {
  return children
}

export function DeckProposals({
  children,
  ids,
  header,
}: {
  children: ReactNode
  ids: readonly string[]
  header?: ReactNode
}) {
  if (!ids.length && !header) return null
  return (
    <View style={styles.main}>
      {header}
      <View testID="deck-proposals" style={styles.proposals}>
        {children}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.md },
  main: { gap: space.md },
  group: {
    backgroundColor: color.groupedCard,
    borderRadius: 8,
    paddingVertical: space.xs,
    overflow: 'hidden',
  },
  proposals: {
    borderRadius: 8,
    backgroundColor: color.groupedCard,
    overflow: 'hidden',
  },
})
