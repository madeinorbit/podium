import { pendingLabel, successLabel } from '@podium/client-graph/mission-proposals'
import { settled } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { color, font, sans, space } from '../theme/theme'
import { ActionSheet } from './ActionSheet'
import { deckColor } from './deck-colors'
import type { MissionProposalRowProps } from './mission-proposal-row.types'
import { PressableScale } from './PressableScale'

export const MissionProposalRow = observer(function MissionProposalRow({
  task,
  first,
  submissions,
  onSubmit,
  onPress,
}: MissionProposalRowProps) {
  const [menu, setMenu] = useState(false)
  const facts = settled(() => ({
    title: task.row.title,
    ref: task.row.displayRef,
    author: task.proposalAuthor,
  }))
  const status = submissions.byId.get(task.id)
  if (facts === LOADING) return <View accessibilityLabel="Loading proposal" />
  const busy = status?.phase === 'pending' || status?.phase === 'success'
  return (
    <>
      <PressableScale
        testID="deck-proposal"
        accessibilityRole="button"
        accessibilityLabel={`Proposal ${facts.ref} ${facts.title}`}
        accessibilityState={{ busy: status?.phase === 'pending' }}
        haptic={false}
        onPress={onPress}
        onLongPress={() => setMenu(true)}
        style={[styles.row, !first && styles.separated]}
      >
        <View style={styles.ring} />
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={1}>
            {facts.title}
          </Text>
          {facts.author ? (
            <Text style={styles.author} numberOfLines={1}>{`by ${facts.author}`}</Text>
          ) : null}
        </View>
        <Text style={styles.ref}>{facts.ref}</Text>
      </PressableScale>
      {status ? (
        <Text
          role={status.phase === 'error' ? 'alert' : 'status'}
          style={[styles.receipt, status.phase === 'error' && styles.error]}
        >
          {status.phase === 'success'
            ? successLabel[status.action]
            : status.phase === 'pending'
              ? pendingLabel[status.action]
              : status.error}
        </Text>
      ) : null}
      <ActionSheet
        visible={menu}
        title={facts.title}
        onClose={() => setMenu(false)}
        actions={[
          { label: 'Start', disabled: busy, onPress: () => onSubmit('start') },
          { label: 'Add to backlog', disabled: busy, onPress: () => onSubmit('backlog') },
          { label: 'Open details', onPress },
          {
            label: 'Dismiss',
            destructive: true,
            disabled: busy,
            onPress: () => onSubmit('dismiss'),
          },
        ]}
      />
    </>
  )
})

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  separated: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: deckColor.proposalRing },
  ring: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: deckColor.proposal },
  title: { ...sans(400), flex: 1, color: color.text, fontSize: font.small },
  body: { flex: 1, minWidth: 0, paddingVertical: space.xs },
  author: { ...sans(400), color: color.textDim, fontSize: font.micro },
  ref: { ...sans(400), color: deckColor.proposalText, fontSize: font.micro },
  receipt: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  error: { color: color.dangerText },
})
