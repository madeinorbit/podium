import { Button, HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityAddTraits,
  accessibilityHidden,
  accessibilityHint,
  accessibilityLabel,
  accessibilityValue,
  buttonStyle,
  contentShape,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  monospacedDigit,
  shapes,
} from '@expo/ui/swift-ui/modifiers'
import type { ReactNode } from 'react'
import { useWindowDimensions } from 'react-native'
import { workPaper as paper } from '../screens/work-paper'

const CARD_INSET = 12

/**
 * A stage group's header: chevron, bold Title 3 name, count. The whole row folds; the
 * Proposed group adds a trailing "Screen" that opens the screening deck.
 */
export function NativeGroupHeader({
  title,
  count,
  folded,
  onToggle,
  trailing,
}: {
  title: string
  count: number
  folded: boolean
  onToggle: () => void
  trailing?: ReactNode
}) {
  const expanded = useWindowDimensions().fontScale >= 1.6
  const modifiers = [
    listRowBackground(paper.ground),
    listRowSeparator('hidden'),
    // The top inset parts the larger title from the card above it.
    listRowInsets({ leading: CARD_INSET, trailing: CARD_INSET, top: 8, bottom: 0 }),
    frame({ minHeight: 44, maxWidth: Infinity }),
  ]
  const content = (
    <>
      <Button
        onPress={onToggle}
        modifiers={[
          buttonStyle('plain'),
          accessibilityLabel(title),
          accessibilityValue(`${folded ? 'Collapsed' : 'Expanded'}, ${count} tasks`),
          accessibilityHint(folded ? 'Shows this group.' : 'Folds this group away.'),
          accessibilityAddTraits(['isHeader']),
        ]}
      >
        <HStack
          spacing={8}
          modifiers={[
            frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
            contentShape(shapes.rectangle()),
          ]}
        >
          <Image
            systemName={folded ? 'chevron.right' : 'chevron.down'}
            modifiers={[
              font({ textStyle: 'footnote', weight: 'semibold' }),
              foregroundStyle(paper.tertiary),
              // Grows with Dynamic Type so the glyph never meets the title.
              frame({ minWidth: 14 }),
              accessibilityHidden(),
            ]}
          />
          <Text
            modifiers={[
              // First-party section titles (Mail, Settings): bold Title 3 in the
              // label colour, well above the rows' Body text, scaling with Dynamic Type.
              font({ textStyle: 'title3', weight: 'bold' }),
              foregroundStyle(paper.ink),
              ...(expanded
                ? [
                    frame({ maxWidth: Infinity, alignment: 'leading' }),
                    fixedSize({ horizontal: false, vertical: true }),
                  ]
                : [lineLimit(1)]),
            ]}
          >
            {title}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: 'subheadline', design: 'monospaced' }),
              foregroundStyle(paper.tertiary),
              monospacedDigit(),
            ]}
          >
            {String(count)}
          </Text>
          <Spacer />
        </HStack>
      </Button>
      {trailing}
    </>
  )
  return expanded && trailing ? (
    <VStack alignment="leading" spacing={8} modifiers={modifiers}>
      {content}
    </VStack>
  ) : (
    <HStack spacing={8} modifiers={modifiers}>
      {content}
    </HStack>
  )
}
