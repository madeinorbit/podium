import { Host } from '@expo/ui'
import { Menu, Picker, RNHostView, Text } from '@expo/ui/swift-ui'
import { disabled, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import type { NativePickerProps } from './action-sheet-native'

/**
 * A compact SwiftUI picker hosted inside a real UIMenu. SwiftUI owns the
 * selection indicator, so labels stay plain text and VoiceOver receives the
 * native checked state.
 */
export function NativePicker({
  label,
  options,
  selected,
  onSelect,
  style,
  children,
}: NativePickerProps) {
  return (
    <Host matchContents style={style}>
      <Menu label={<RNHostView matchContents>{children(undefined)}</RNHostView>}>
        <Picker
          label={label}
          selection={selected}
          onSelectionChange={onSelect}
          modifiers={[pickerStyle('inline')]}
        >
          {options.map((option) => (
            <Text
              key={option.value}
              modifiers={[tag(option.value), ...(option.disabled ? [disabled(true)] : [])]}
            >
              {option.group ? `${option.group} · ${option.label}` : option.label}
            </Text>
          ))}
        </Picker>
      </Menu>
    </Host>
  )
}
