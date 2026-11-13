import {
  Button,
  ContextMenu,
  HStack,
  Image,
  Spacer,
  SwipeActions,
  Text,
  VStack,
} from '@expo/ui/swift-ui'
import {
  accessibilityElement,
  accessibilityHint,
  accessibilityIdentifier,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowBackground,
  listRowInsets,
  listRowSeparatorTint,
  shapes,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import { pendingLabel, successLabel } from '@podium/client-graph/mission-proposals'
import { settled } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { observer } from 'mobx-react-lite'
import { color } from '../theme/theme'
import { deckColor } from './deck-colors'
import type { MissionProposalRowProps } from './mission-proposal-row.types'

/** SwiftUI List owns the swipe and context menu; every action uses desktop's shared command. */
export const MissionProposalRow = observer(function MissionProposalRow({
  task,
  submissions,
  onSubmit,
  onPress,
}: MissionProposalRowProps) {
  const facts = settled(() => ({
    title: task.row.title,
    ref: task.row.displayRef,
    author: task.proposalAuthor,
  }))
  const status = submissions.byId.get(task.id)
  if (facts === LOADING) return <Text>Loading proposal…</Text>
  const busy = status?.phase === 'pending' || status?.phase === 'success'
  const receipt =
    status?.phase === 'success'
      ? successLabel[status.action]
      : status?.phase === 'pending'
        ? pendingLabel[status.action]
        : status?.error
  return (
    <SwipeActions
      modifiers={[
        listRowBackground(deckColor.proposalFill),
        listRowSeparatorTint(deckColor.proposalRing),
        listRowInsets({ leading: 12, trailing: 12, top: 0, bottom: 0 }),
        accessibilityIdentifier('deck-proposal'),
      ]}
    >
      <ContextMenu>
        <ContextMenu.Trigger>
          <Button
            onPress={onPress}
            modifiers={[
              buttonStyle('plain'),
              accessibilityElement('ignore'),
              accessibilityLabel(
                `Proposal ${facts.ref} ${facts.title}${receipt ? `, ${receipt}` : ''}`,
              ),
              accessibilityHint('Opens details. Swipe or long press for proposal actions.'),
            ]}
          >
            <VStack
              alignment="leading"
              spacing={4}
              modifiers={[
                frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
                contentShape(shapes.rectangle()),
              ]}
            >
              <HStack spacing={8}>
                <Image systemName="circle" size={8} color={deckColor.proposal} />
                <Text
                  modifiers={[
                    font({ textStyle: 'subheadline' }),
                    foregroundStyle(color.text),
                    lineLimit(2),
                  ]}
                >
                  {facts.title}
                </Text>
                <Spacer />
                <Text
                  modifiers={[
                    font({ textStyle: 'caption2', design: 'monospaced' }),
                    foregroundStyle(deckColor.proposalText),
                    lineLimit(1),
                  ]}
                >
                  {facts.ref}
                </Text>
              </HStack>
              {facts.author ? (
                <Text
                  modifiers={[font({ textStyle: 'caption2' }), foregroundStyle(color.textDim)]}
                >{`by ${facts.author}`}</Text>
              ) : null}
              {receipt ? (
                <Text
                  modifiers={[
                    font({ textStyle: 'caption1' }),
                    foregroundStyle(status?.phase === 'error' ? color.dangerText : color.textDim),
                    accessibilityIdentifier('deck-proposal-receipt'),
                  ]}
                >
                  {receipt}
                </Text>
              ) : null}
            </VStack>
          </Button>
        </ContextMenu.Trigger>
        <ContextMenu.Items>
          <Button
            label="Start"
            systemImage="play"
            onPress={() => onSubmit('start')}
            modifiers={[disabled(busy)]}
          />
          <Button
            label="Add to backlog"
            systemImage="tray"
            onPress={() => onSubmit('backlog')}
            modifiers={[disabled(busy)]}
          />
          <Button label="Open details" systemImage="arrow.up.right" onPress={onPress} />
          {/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI button role, not an ARIA role. */}
          <Button
            label="Dismiss"
            systemImage="xmark"
            role="destructive"
            onPress={() => onSubmit('dismiss')}
            modifiers={[disabled(busy)]}
          />
        </ContextMenu.Items>
      </ContextMenu>
      <SwipeActions.Actions edge="leading" allowsFullSwipe>
        <Button
          label="Start"
          systemImage="play"
          onPress={() => onSubmit('start')}
          modifiers={[tint(deckColor.proposal), disabled(busy)]}
        />
        <Button
          label="Backlog"
          systemImage="tray"
          onPress={() => onSubmit('backlog')}
          modifiers={[tint('#636366'), disabled(busy)]}
        />
      </SwipeActions.Actions>
      <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
        {/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI button role, not an ARIA role. */}
        <Button
          label="Dismiss"
          systemImage="xmark"
          role="destructive"
          onPress={() => onSubmit('dismiss')}
          modifiers={[disabled(busy)]}
        />
      </SwipeActions.Actions>
    </SwipeActions>
  )
})
