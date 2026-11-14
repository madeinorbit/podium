import { Button, ContextMenu, HStack, Image, SwipeActions, Text, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityElement,
  accessibilityHint,
  accessibilityIdentifier,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  padding,
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
import { RevealSwipeActions } from './RevealSwipeActions.ios'

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
        frame({ minWidth: 0, maxWidth: Infinity, alignment: 'leading' }),
        accessibilityIdentifier('deck-proposal'),
      ]}
    >
      <ContextMenu modifiers={[frame({ minWidth: 0, maxWidth: Infinity, alignment: 'leading' })]}>
        <ContextMenu.Trigger>
          <Button
            onPress={onPress}
            modifiers={[
              buttonStyle('plain'),
              frame({ minWidth: 0, maxWidth: Infinity, alignment: 'leading' }),
              accessibilityElement('ignore'),
              accessibilityLabel(
                `Proposal ${facts.ref} ${facts.title}${receipt ? `, ${receipt}` : ''}`,
              ),
              accessibilityHint(
                busy
                  ? 'Opens details.'
                  : 'Opens details. Swipe or long press for proposal actions.',
              ),
            ]}
          >
            <HStack
              alignment="top"
              spacing={12}
              modifiers={[
                frame({ minWidth: 0, minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
                padding({ vertical: 8 }),
                contentShape(shapes.rectangle()),
              ]}
            >
              <Image
                systemName="circle"
                color={deckColor.proposal}
                modifiers={[
                  font({ textStyle: 'footnote' }),
                  // The task rows' 20pt glyph column.
                  frame({ width: 20, alignment: 'center' }),
                  padding({ top: 2 }),
                ]}
              />
              <VStack
                alignment="leading"
                spacing={4}
                // The ring keeps its intrinsic size; text accepts all remaining
                // width through the swipe/menu wrappers, including Dynamic Type.
                modifiers={[
                  layoutPriority(1),
                  frame({ minWidth: 0, maxWidth: Infinity, alignment: 'leading' }),
                ]}
              >
                <Text
                  modifiers={[
                    font({ textStyle: 'subheadline' }),
                    foregroundStyle(color.text),
                    fixedSize({ horizontal: false, vertical: true }),
                    frame({ maxWidth: Infinity, alignment: 'leading' }),
                  ]}
                >
                  {facts.title}
                </Text>
                <Text
                  modifiers={[
                    font({ textStyle: 'footnote' }),
                    foregroundStyle(color.textDim),
                    fixedSize({ horizontal: false, vertical: true }),
                    frame({ maxWidth: Infinity, alignment: 'leading' }),
                  ]}
                >{`${facts.ref}${facts.author ? ` · by ${facts.author}` : ''}`}</Text>
                {receipt ? (
                  <Text
                    modifiers={[
                      font({ textStyle: 'footnote' }),
                      foregroundStyle(status?.phase === 'error' ? color.dangerText : color.textDim),
                      accessibilityIdentifier('deck-proposal-receipt'),
                      fixedSize({ horizontal: false, vertical: true }),
                      frame({ maxWidth: Infinity, alignment: 'leading' }),
                    ]}
                  >
                    {receipt}
                  </Text>
                ) : null}
              </VStack>
            </HStack>
          </Button>
        </ContextMenu.Trigger>
        {busy ? null : (
          <ContextMenu.Items>
            <Button label="Start" systemImage="play" onPress={() => onSubmit('start')} />
            <Button label="Add to backlog" systemImage="tray" onPress={() => onSubmit('backlog')} />
            <Button label="Open details" systemImage="arrow.up.right" onPress={onPress} />
            {/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI button role, not an ARIA role. */}
            <Button
              label="Dismiss"
              systemImage="xmark"
              role="destructive"
              onPress={() => onSubmit('dismiss')}
            />
          </ContextMenu.Items>
        )}
      </ContextMenu>
      {busy ? null : (
        // Trailing only: on the flight deck page a left-to-right drag always
        // pages back to the chat, so no proposal action sits under it. The
        // swipe reveals the buttons; only a tap acts [POD-2527].
        <RevealSwipeActions edge="trailing">
          <Button
            label="Start"
            systemImage="play"
            onPress={() => onSubmit('start')}
            modifiers={[tint(deckColor.proposal)]}
          />
          <Button
            label="Backlog"
            systemImage="tray"
            onPress={() => onSubmit('backlog')}
            modifiers={[tint('#636366')]}
          />
          {/* A destructive swipe role lets SwiftUI remove the cell before the
          command finishes. Keep its red tint while our receipt owns removal. */}
          <Button
            label="Dismiss"
            systemImage="xmark"
            onPress={() => onSubmit('dismiss')}
            modifiers={[tint(color.danger)]}
          />
        </RevealSwipeActions>
      )}
    </SwipeActions>
  )
})
