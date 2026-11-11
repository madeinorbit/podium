import { Host } from '@expo/ui'
import { Button, Menu, RNHostView } from '@expo/ui/swift-ui'
import type { ComponentProps } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Glass } from '../components/Glass'
import { Icon } from '../components/Icon'
import type { AppIcon } from '../components/icons'
import type { ScreenAction } from '../components/screen-actions'
import { color } from '../theme/theme'

const symbol = (icon: AppIcon): ComponentProps<typeof Button>['systemImage'] =>
  (typeof icon === 'object' && 'ios' in icon ? icon.ios : icon) as ComponentProps<
    typeof Button
  >['systemImage']

export function RootHeaderActions({ actions }: { actions?: readonly ScreenAction[] }) {
  return (
    <View style={styles.row}>
      {actions?.map((action) => {
        const glyph = (
          <Glass key={action.label} interactive style={styles.circle}>
            <Icon as={action.icon} size={20} color={color.text} />
          </Glass>
        )
        return action.items ? (
          <Host key={action.label} matchContents>
            <Menu
              label={
                <RNHostView matchContents>
                  <View accessibilityLabel={action.label} accessibilityRole="button">
                    {glyph}
                  </View>
                </RNHostView>
              }
            >
              {action.items.map((item) => (
                <Button
                  key={item.label}
                  label={item.label}
                  systemImage={
                    item.selected ? 'checkmark' : item.icon ? symbol(item.icon) : undefined
                  }
                  role={item.destructive ? 'destructive' : 'default'}
                  onPress={item.onPress}
                />
              ))}
            </Menu>
          </Host>
        ) : (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={action.onPress}
          >
            {glyph}
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  circle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
