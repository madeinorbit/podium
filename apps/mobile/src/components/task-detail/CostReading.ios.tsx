import { Button, HStack, Rectangle, Text, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityHidden,
  accessibilityIdentifier,
  accessibilityLabel,
  accessibilityValue,
  buttonStyle,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  monospacedDigit,
  opacity,
  padding,
} from '@expo/ui/swift-ui/modifiers'
import { approxUsd, COST_HEDGE, floorLabel } from '@podium/client-core/values'
import type { TaskCostModel } from '@podium/client-graph/task-cost-model'
import { useState } from 'react'
import { useWindowDimensions } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { color } from '../../theme/theme'
import { DetailActionRow, DetailGroup } from './DetailList'
import { detailRowInsets, useDetailSeparator } from './detail-row-geometry'

export const CostReading = observer(function CostReading({ model }: { model: TaskCostModel }) {
  const view = model.view
  const [details, setDetails] = useState(false)
  const { fontScale } = useWindowDimensions()
  const separator = useDetailSeparator()
  if (view?.state === 'no-sessions') return null
  const value =
    view?.state === 'costed'
      ? approxUsd(view.rollup.estCostUsd)
      : view?.state === 'not-recorded'
        ? 'Not recorded'
        : model.failed
          ? 'Unavailable'
          : 'Loading…'
  const titleValue = (
    <>
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
      {view?.state === 'pending' ? (
        // Desktop holds an unfilled reading here; pending may never resolve.
        <Rectangle
          modifiers={[
            frame({ width: 80, height: 1 }),
            foregroundStyle(color.textDim),
            opacity(0.32),
            padding({ top: 12 }),
            accessibilityIdentifier('issue-cost-unfilled'),
            accessibilityHidden(),
          ]}
        />
      ) : (
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
      )}
    </>
  )
  // The outermost row element carries the shared insets and separator guide.
  const row = [detailRowInsets, separator]
  const reading = (
    <VStack
      alignment="leading"
      spacing={4}
      modifiers={[
        ...(view?.state === 'costed' ? [] : row),
        padding({ vertical: 12 }),
        frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
        accessibilityIdentifier('issue-cost'),
      ]}
    >
      {fontScale > 1.35 ? (
        <VStack alignment="leading" spacing={4}>
          {titleValue}
        </VStack>
      ) : (
        <HStack alignment="firstTextBaseline" spacing={8}>
          {titleValue}
        </HStack>
      )}
      {view?.state === 'costed' ? (
        <>
          <Text modifiers={detail}>
            Estimate at list price{view.floor === 'partial' ? ' · partial' : ''}
          </Text>
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
  )
  return (
    <DetailGroup label="Cost" testID="issue-cost">
      {view?.state === 'costed' ? (
        <Button
          onPress={() => setDetails((value) => !value)}
          modifiers={[
            ...row,
            buttonStyle('automatic'),
            accessibilityLabel(
              `${view.provisional ? 'Estimated cost so far' : 'Estimated cost'}, ${value}. Estimate at list price${view.floor === 'partial' ? ', partial' : ''}. ${details ? 'Hide' : 'Show'} cost details`,
            ),
            // The Button's label replaces its children for VoiceOver, so the
            // expanded attribution and hedge are read as its value.
            ...(details
              ? [
                  accessibilityValue(
                    [
                      view.floor === 'partial'
                        ? floorLabel(view.harnesses, view.uncostedSessionCount)
                        : null,
                      COST_HEDGE,
                    ]
                      .filter(Boolean)
                      .join(' '),
                  ),
                ]
              : []),
          ]}
        >
          {reading}
        </Button>
      ) : (
        reading
      )}
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
