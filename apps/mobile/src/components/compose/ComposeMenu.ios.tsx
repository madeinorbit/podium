import { Host } from '@expo/ui'
import { Button, Menu, RNHostView, Section, Text, Toggle } from '@expo/ui/swift-ui'
import {
  buttonStyle,
  disabled,
  frame,
  menuActionDismissBehavior,
} from '@expo/ui/swift-ui/modifiers'
import type { SFSymbol } from 'expo-symbols'
import { useState } from 'react'
import { View } from 'react-native'
import type { ComposeMenuItem, ComposeMenuProps } from './ComposeMenu'

/** The app's SwiftUI Menu/RNHostView pattern, with nested choices and primary actions. */
export function ComposeMenu({
  items,
  children,
  onPrimaryAction,
  disabled: unavailable,
  style,
}: ComposeMenuProps) {
  const [width, setWidth] = useState<number>()
  const [contentHeight, setContentHeight] = useState(0)
  const label = (
    <View
      testID="compose-menu-label"
      collapsable={false}
      style={{ width }}
      onLayout={(event) => {
        if (event.nativeEvent.layout.height > 0) setContentHeight(event.nativeEvent.layout.height)
      }}
    >
      {children()}
    </View>
  )
  return (
    <View
      testID="compose-menu-host"
      style={[style, contentHeight > 0 && { minHeight: contentHeight }]}
      // Opening a UIMenu must leave the composing sheet and keyboard in place.
      // Blurring here resizes the sheet while UIKit is presenting its menu.
      onLayout={(event) => {
        const measured = event.nativeEvent.layout
        if (measured.width <= 0) return
        // The parent layout can arrive before the label's event. Preserve
        // its measured height too, including a tall Dynamic Type row.
        if (width === undefined && measured.height > 0) setContentHeight(measured.height)
        setWidth(measured.width)
      }}
    >
      {/* Measure in the RN row before crossing into SwiftUI. Mounting an
          RNHostView with no width first lays out an unconstrained label and
          then shifts its text when the host's onLayout width arrives. */}
      {width === undefined ? (
        label
      ) : (
        <Host
          // Preserve the keyboard safe area when UIKit places a tall menu.
          matchContents={{ vertical: true }}
          style={{ alignSelf: 'stretch', width, minHeight: contentHeight }}
        >
          <Menu
            label={<RNHostView matchContents={{ vertical: true }}>{label}</RNHostView>}
            onPrimaryAction={onPrimaryAction}
            modifiers={[
              buttonStyle('plain'),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
              menuActionDismissBehavior('enabled'),
              ...(unavailable ? [disabled(true)] : []),
            ]}
          >
            {items.map((item) => (
              <Entry key={item.id} item={item} />
            ))}
          </Menu>
        </Host>
      )}
    </View>
  )
}

function Entry({ item }: { item: ComposeMenuItem }) {
  if (item.items) {
    return item.inline ? (
      <Section>
        {item.items.map((child) => (
          <Entry key={child.id} item={child} />
        ))}
      </Section>
    ) : (
      <Menu label={item.label} systemImage={item.symbol}>
        {item.items.map((child) => (
          <Entry key={child.id} item={child} />
        ))}
      </Menu>
    )
  }
  const modifiers = item.disabled ? [disabled(true)] : []
  if (item.selected !== undefined)
    return (
      <Toggle
        isOn={item.selected}
        systemImage={item.symbol as SFSymbol | undefined}
        onIsOnChange={(selected) => {
          if (selected) item.onPress?.()
        }}
        modifiers={modifiers}
      >
        <Text>{item.label}</Text>
        {item.subtitle ? <Text>{item.subtitle}</Text> : null}
      </Toggle>
    )
  if (item.subtitle)
    return (
      <Button modifiers={modifiers} onPress={item.onPress}>
        <Text>{item.label}</Text>
        <Text>{item.subtitle}</Text>
      </Button>
    )
  return (
    <Button
      label={item.label}
      systemImage={item.symbol as SFSymbol | undefined}
      modifiers={modifiers}
      onPress={item.onPress}
    />
  )
}
