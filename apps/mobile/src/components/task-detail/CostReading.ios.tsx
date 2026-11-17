import { Button, HStack, Text, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityIdentifier,
  accessibilityLabel,
  buttonStyle,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  listRowInsets,
  monospacedDigit,
  padding,
} from '@expo/ui/swift-ui/modifiers'
import { approxUsd, COST_HEDGE, floorLabel } from '@podium/client-core/values'
import type { TaskCostModel } from '@podium/client-graph/task-cost-model'
import { useState } from 'react'
import { useWindowDimensions } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { color } from '../../theme/theme'
import { DetailActionRow, DetailGroup } from './DetailList'

export const CostReading = observer(function CostReading({ model }: { model: TaskCostModel }) {
  const view = model.view
  const [details, setDetails] = useState(false)
  const { fontScale } = useWindowDimensions()
  const Stack = fontScale > 1.35 ? VStack : HStack
  if (view?.state === 'no-sessions') return null
  const value =
    view?.state === 'costed'
      ? approxUsd(view.rollup.estCostUsd)
      : view?.state === 'not-recorded'
        ? 'Not recorded'
        : model.failed
          ? 'Unavailable'
          : 'Loading…'
  return (
    <DetailGroup label="Cost" testID="issue-cost">
      <VStack
        alignment="leading"
        spacing={8}
        modifiers={[
          listRowInsets({ leading: 16, trailing: 16, top: 0, bottom: 0 }),
          padding({ vertical: 12 }),
          frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
          accessibilityIdentifier('issue-cost'),
        ]}
      >
        <Stack spacing={8}>
          <Text
            modifiers={[
              font({ textStyle: 'body' }),
              foregroundStyle(color.text),
              fixedSize({ horizontal: false, vertical: true }),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
            ]}
          >
            {view?.provisional ? 'Estimated cost so far' : 'Estimated cost'}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: 'body' }),
              foregroundStyle(color.textDim),
              monospacedDigit(),
              fixedSize({ horizontal: false, vertical: true }),
              accessibilityIdentifier('issue-cost-value'),
            ]}
          >
            {value}
          </Text>
        </Stack>
        {view?.state === 'costed' ? (
          <>
            <Button
              onPress={() => setDetails((value) => !value)}
              modifiers={[
                buttonStyle('plain'),
                frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
                accessibilityLabel(details ? 'Hide cost details' : 'Show cost details'),
              ]}
            >
              <Text modifiers={detail}>
                Estimate at list price{view.floor === 'partial' ? ' · partial' : ''}
              </Text>
            </Button>
            {details ? (
              <>
                {view.floor === 'partial' ? (
                  <Text modifiers={detail}>
                    {floorLabel(view.harnesses, view.uncostedSessionCount)}
                  </Text>
                ) : null}
                <Text modifiers={detail}>{COST_HEDGE}</Text>
              </>
            ) : null}
          </>
        ) : null}
      </VStack>
      {model.failed ? (
        <DetailActionRow label="Retry cost" onPress={() => void model.refresh()} />
      ) : null}
    </DetailGroup>
  )
})

const detail = [
  font({ textStyle: 'footnote' }),
  foregroundStyle(color.textDim),
  fixedSize({ horizontal: false, vertical: true }),
]
