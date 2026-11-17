import { Host } from '@expo/ui'
import { Button, HStack, Image, List, RNHostView, Section, Text, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityIdentifier,
  background,
  buttonStyle,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  listRowInsets,
  listSectionSpacing,
  listStyle,
  disabled as nativeDisabled,
  padding,
  scrollContentBackground,
  scrollDismissesKeyboard,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { color } from '../../theme/theme'

/** SwiftUI owns row measurement, separators, scrolling and accessibility sizing. */
export function DetailList({ children }: { children: ReactNode }) {
  return (
    <Host style={{ flex: 1 }}>
      <List
        modifiers={[
          listStyle('insetGrouped'),
          listSectionSpacing(16),
          scrollContentBackground('hidden'),
          scrollDismissesKeyboard('interactively'),
          background(color.groupedBg),
          accessibilityIdentifier('issue-detail-list'),
        ]}
      >
        {children}
      </List>
    </Host>
  )
}

/** Reference forms stay mounted in a non-recycled section header. Their React
 * content measures vertically at the width proposed by the native List. */
export function DetailContent({ children }: { children: ReactNode }) {
  return (
    <Section
      header={
        <VStack modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
          <RNHostView matchContents={{ vertical: true }}>
            <View collapsable={false} style={{ width: '100%', gap: 16 }}>
              {children}
            </View>
          </RNHostView>
        </VStack>
      }
    >
      {null}
    </Section>
  )
}

export function DetailGroup({
  label,
  count,
  children,
}: {
  label: string
  count?: string
  children: ReactNode
  testID?: string
}) {
  return <Section title={count ? `${label} · ${count}` : label}>{children}</Section>
}

export function DetailActionRow({
  label,
  onPress,
  primary = false,
  disabled = false,
}: {
  label: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
}) {
  return (
    <Button
      onPress={onPress}
      modifiers={[
        buttonStyle(primary ? 'borderedProminent' : 'plain'),
        ...(primary ? [tint(color.accent)] : []),
        nativeDisabled(disabled),
        listRowInsets({ leading: 16, trailing: 16, top: 0, bottom: 0 }),
        accessibilityIdentifier(primary ? 'issue-start-agent' : 'issue-detail-action'),
      ]}
    >
      <HStack
        spacing={12}
        modifiers={[
          padding({ vertical: 12 }),
          frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
        ]}
      >
        {primary ? <Image systemName="play.fill" size={16} color={color.onAccent} /> : null}
        <Text
          modifiers={[
            font({ textStyle: 'body', weight: primary ? 'semibold' : 'regular' }),
            foregroundStyle(primary ? color.onAccent : color.accentTint),
            fixedSize({ horizontal: false, vertical: true }),
            frame({ maxWidth: Infinity, alignment: 'leading' }),
          ]}
        >
          {label}
        </Text>
      </HStack>
    </Button>
  )
}
