import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { space } from '../theme/theme'
import { deckColor } from './deck-colors'

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

export function DeckProposals({ children }: { children: ReactNode }) {
  return (
    <View testID="deck-proposals" style={styles.proposals}>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xxl },
  main: { gap: space.md },
  proposals: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: deckColor.proposalRing,
    backgroundColor: deckColor.proposalFill,
    overflow: 'hidden',
  },
})
