import { approxUsd, COST_HEDGE, floorLabel } from '@podium/client-core/values'
import type { TaskCostModel } from '@podium/client-graph/task-cost-model'
import { StyleSheet, Text, View } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { color, font, sans } from '../../theme/theme'
import { DetailActionRow, DetailGroup } from './DetailList'

export const CostReading = observer(function CostReading({ model }: { model: TaskCostModel }) {
  const view = model.view
  return (
    <DetailGroup label="Cost" testID="issue-cost">
      <View style={styles.row}>
        <Text style={styles.label}>
          {view?.provisional ? 'Estimated cost so far' : 'Estimated cost'}
        </Text>
        <Text testID="issue-cost-value" selectable style={styles.value}>
          {view?.state === 'costed'
            ? approxUsd(view.rollup.estCostUsd)
            : view?.state === 'no-sessions'
              ? 'No sessions'
              : view?.state === 'not-recorded'
                ? 'Not recorded'
                : model.failed
                  ? 'Unavailable'
                  : 'Loading…'}
        </Text>
      </View>
      {view?.state === 'costed' ? (
        <>
          <Text style={styles.detail}>{view.rollup.models.map((m) => m.model).join(' + ')}</Text>
          {view.floor === 'partial' ? (
            <Text style={styles.detail}>
              {floorLabel(view.harnesses, view.uncostedSessionCount)}
            </Text>
          ) : null}
          <Text style={styles.hedge}>{COST_HEDGE}</Text>
        </>
      ) : null}
      {model.failed ? (
        <DetailActionRow label="Retry cost" onPress={() => void model.refresh()} />
      ) : null}
    </DetailGroup>
  )
})

const styles = StyleSheet.create({
  row: { padding: 16, minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  label: { ...sans(400), fontSize: font.body, color: color.text, flexGrow: 1, flexShrink: 1 },
  value: { ...sans(400), fontSize: font.body, color: color.textDim, fontVariant: ['tabular-nums'] },
  detail: {
    ...sans(400),
    fontSize: font.tiny,
    color: color.textDim,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  hedge: {
    ...sans(400),
    fontSize: font.tiny,
    color: color.textDim,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
})
