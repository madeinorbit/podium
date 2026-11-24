import { View } from 'react-native'
import { color } from '../theme/theme'
import { Icon } from './Icon'

/** The system delivery-failure glyph, shared by the bubble and its Work row. */
export function DeliveryFailureMark({ label, size = 20 }: { label: string; size?: number }) {
  return (
    <View accessibilityRole="image" accessibilityLabel={label} testID="delivery-failure-mark">
      <Icon
        as={{ ios: 'exclamationmark.circle.fill', android: 'error', web: 'error' }}
        size={size}
        color={color.dangerText}
      />
    </View>
  )
}
