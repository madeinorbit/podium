import { Host } from '@expo/ui'
import { Menu, Picker, RNHostView, Text } from '@expo/ui/swift-ui'
import { disabled, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import { useState } from 'react'
import type { NativePickerProps } from './action-sheet-spec'

export type { NativePickerOption, NativePickerProps } from './action-sheet-spec'

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
  const [selectionRevision, setSelectionRevision] = useState(0)
  return (
    <Host matchContents ignoreSafeArea="all" style={style}>
      <Menu label={<RNHostView matchContents>{children(undefined)}</RNHostView>}>
        <Picker
          key={selectionRevision}
          label={label}
          selection={selected}
          onSelectionChange={(value) => {
            // SwiftUI changes its own selection first. A guarded or refused
            // choice can leave selected unchanged, so recreate just the Picker
            // to restore the accepted value without replacing its Menu or Host.
            setSelectionRevision((revision) => revision + 1)
            onSelect(value)
          }}
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
