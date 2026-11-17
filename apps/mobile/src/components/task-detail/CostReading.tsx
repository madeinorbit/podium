import { approxUsd, COST_HEDGE, floorLabel } from '@podium/client-core/values'
import type { TaskCostModel } from '@podium/client-graph/task-cost-model'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { color, font, sans } from '../../theme/theme'
import { PressableScale } from '../PressableScale'
import { DetailActionRow, DetailGroup } from './DetailList'
import { DetailText as Text } from './DetailText'

export const CostReading = observer(function CostReading({ model }: { model: TaskCostModel }) {
  const view = model.view
  const [details, setDetails] = useState(false)
  if (view?.state === 'no-sessions') return null
  return (
    <DetailGroup label="Cost" testID="issue-cost">
      <View style={styles.row}>
        <Text style={styles.label}>
          {view?.provisional ? 'Estimated cost so far' : 'Estimated cost'}
        </Text>
        {view?.state === 'pending' ? (
          // Desktop holds an unfilled reading here; pending may never resolve.
          <View testID="issue-cost-unfilled" aria-hidden style={styles.unfilled} />
        ) : (
          <Text testID="issue-cost-value" selectable style={styles.value}>
            {view?.state === 'costed'
              ? approxUsd(view.rollup.estCostUsd)
              : view?.state === 'not-recorded'
                ? 'Not recorded'
                : model.failed
                  ? 'Unavailable'
                  : 'Loading…'}
          </Text>
        )}
      </View>
      {view?.state === 'costed' ? (
        <>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={details ? 'Hide cost details' : 'Show cost details'}
            accessibilityState={{ expanded: details }}
            aria-expanded={details}
            onPress={() => setDetails((value) => !value)}
            style={styles.detailsButton}
          >
            <Text style={styles.detail}>
              Estimate at list price{view.floor === 'partial' ? ' · partial' : ''}
            </Text>
          </PressableScale>
          {details ? (
            <View>
              {view.floor === 'partial' ? (
                <Text style={styles.detail}>
                  {floorLabel(view.harnesses, view.uncostedSessionCount)}
                </Text>
              ) : null}
              <Text style={styles.hedge}>{COST_HEDGE}</Text>
            </View>
          ) : null}
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
  unfilled: {
    width: 80,
    height: 12,
    alignSelf: 'center',
    borderBottomWidth: 1,
    borderBottomColor: color.textDim,
    opacity: 0.32,
  },
  detailsButton: { minHeight: 44, justifyContent: 'center' },
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
