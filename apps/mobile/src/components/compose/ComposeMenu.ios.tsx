import { Host } from '@expo/ui'
import { Button, Menu, RNHostView, Section, Text, Toggle } from '@expo/ui/swift-ui'
import {
  buttonStyle,
  disabled,
  frame,
  menuActionDismissBehavior,
} from '@expo/ui/swift-ui/modifiers'
import type { SFSymbol } from 'expo-symbols'
import { Keyboard, View } from 'react-native'
import type { ComposeMenuItem, ComposeMenuProps } from './ComposeMenu'

/** The app's SwiftUI Menu/RNHostView pattern, with nested choices and primary actions. */
export function ComposeMenu({
  items,
  children,
  onPrimaryAction,
  disabled: unavailable,
  style,
}: ComposeMenuProps) {
  return (
    <View style={style} onTouchStart={Keyboard.dismiss}>
      <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
        <Menu
          label={<RNHostView matchContents={{ vertical: true }}>{children()}</RNHostView>}
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
