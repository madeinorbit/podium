import { Pressable, StyleSheet, View } from 'react-native'
import { Glass } from '../components/Glass'
import { Icon } from '../components/Icon'
import type { ScreenAction } from '../components/screen-actions'
import { color } from '../theme/theme'

export function RootHeaderActions({ actions }: { actions?: readonly ScreenAction[] }) {
  return (
    <View style={styles.row}>
      {actions?.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
        >
          <Glass interactive style={styles.circle}>
            <Icon as={action.icon} size={20} color={color.text} />
          </Glass>
        </Pressable>
      ))}
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
