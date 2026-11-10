import { Host } from '@expo/ui'
import { Menu, Picker, RNHostView, Text } from '@expo/ui/swift-ui'
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import type { ComposerModelMenuProps } from './ComposerModelMenu'

/**
 * The composer's model menu as a real UIMenu: the models inline with the
 * system checkmark, then an Effort submenu showing the current level, the way
 * Settings-style pickers nest in iOS 26 menus.
 */
export function ComposerModelMenu({
  models,
  model,
  efforts,
  effort,
  effortLabel,
  onModel,
  onEffort,
  children,
}: ComposerModelMenuProps) {
  return (
    <Host matchContents style={{ flexShrink: 1, minWidth: 0 }}>
      <Menu label={<RNHostView matchContents>{children(undefined)}</RNHostView>}>
        <Picker
          label="Model"
          selection={model}
          onSelectionChange={(value: string) => onModel(value)}
          modifiers={[pickerStyle('inline')]}
        >
          {models.map((option) => (
            <Text key={option.value} modifiers={[tag(option.value)]}>
              {option.label}
            </Text>
          ))}
        </Picker>
        {efforts.length > 0 ? (
          <Menu label={`Effort · ${effortLabel}`} systemImage="gauge.with.dots.needle.33percent">
            <Picker
              label="Effort"
              selection={effort}
              onSelectionChange={(value: string) => onEffort(value)}
              modifiers={[pickerStyle('inline')]}
            >
              {efforts.map((option) => (
                <Text key={option.value} modifiers={[tag(option.value)]}>
                  {option.label}
                </Text>
              ))}
            </Picker>
          </Menu>
        ) : null}
      </Menu>
    </Host>
  )
}
