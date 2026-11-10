import { Host } from '@expo/ui'
import {
  BottomSheet,
  Button,
  Form,
  Group,
  NavigationStack,
  Picker,
  Section,
  Text,
  Toggle,
  Toolbar,
  ToolbarItem,
} from '@expo/ui/swift-ui'
import {
  disabled,
  navigationBarTitleDisplayMode,
  navigationTitle,
  pickerStyle,
  presentationDetents,
  presentationDragIndicator,
  tag,
} from '@expo/ui/swift-ui/modifiers'
import { StyleSheet } from 'react-native'
import { color } from '../theme/theme'
import {
  DISPLAY_FACETS,
  type Facet,
  FILTER_FACETS,
  MORE_FACETS,
  type TaskFiltersSheetProps,
  useTaskFilterFacets,
} from './TaskFiltersSheet'

export type { TaskFiltersSheetProps } from './TaskFiltersSheet'

/**
 * FILTER AND DISPLAY, the iOS sheet: a real SwiftUI sheet with medium and large
 * detents, a grouped Form of menu pickers and switches, and the navigation
 * bar's Reset and Done. iOS draws the sheet's glass, grabber and detents.
 *
 * Same facets and writes as the React Native sheet (`useTaskFilterFacets`):
 * the board's `setFilter`, the shared display preference, the Show-done toggle.
 */
export function TaskFiltersSheet(props: TaskFiltersSheetProps) {
  const { visible, filter, showDone, showAgentTasks, onShowDone, onShowAgentTasks, onClose } = props
  const { configs, set, reset, activeCount } = useTaskFilterFacets(props)
  const picker = (facet: Facet) => {
    const config = configs[facet]
    return (
      <Picker
        key={facet}
        label={config.label}
        selection={config.value}
        onSelectionChange={(value) => config.apply(String(value))}
        modifiers={[pickerStyle('menu')]}
      >
        {config.options.map((option) => (
          <Text key={option.value} modifiers={[tag(option.value)]}>
            {option.label}
          </Text>
        ))}
      </Picker>
    )
  }

  return (
    <Host style={styles.host} seedColor={color.accentTint}>
      <BottomSheet isPresented={visible} onIsPresentedChange={(open) => (open ? null : onClose())}>
        <Group
          modifiers={[
            presentationDetents(['medium', 'large']),
            presentationDragIndicator('visible'),
          ]}
        >
          <NavigationStack>
            <Toolbar
              modifiers={[
                navigationTitle('Filter and Display'),
                navigationBarTitleDisplayMode('inline'),
              ]}
            >
              <Form>
                <Section>{FILTER_FACETS.map(picker)}</Section>
                <Section>
                  {DISPLAY_FACETS.map(picker)}
                  <Toggle label="Show Done" isOn={showDone} onIsOnChange={onShowDone} />
                  <Toggle
                    label="Show Agent Tasks"
                    isOn={showAgentTasks}
                    onIsOnChange={onShowAgentTasks}
                  />
                </Section>
                <Section title="More">
                  {MORE_FACETS.map(picker)}
                  <Toggle
                    label="Archived"
                    isOn={filter.archived === true}
                    onIsOnChange={(value) => set('archived', value || undefined)}
                  />
                  <Toggle
                    label="Deleted"
                    isOn={filter.deleted === true}
                    onIsOnChange={(value) => set('deleted', value || undefined)}
                  />
                </Section>
              </Form>
              <Toolbar.Content>
                <ToolbarItem placement="cancellationAction">
                  <Button label="Reset" onPress={reset} modifiers={[disabled(activeCount === 0)]} />
                </ToolbarItem>
                <ToolbarItem placement="confirmationAction">
                  <Button label="Done" systemImage="checkmark" onPress={onClose} />
                </ToolbarItem>
              </Toolbar.Content>
            </Toolbar>
          </NavigationStack>
        </Group>
      </BottomSheet>
    </Host>
  )
}

const styles = StyleSheet.create({
  // The sheet presents itself; its anchor takes no room in the screen.
  host: { position: 'absolute', width: 0, height: 0 },
})
